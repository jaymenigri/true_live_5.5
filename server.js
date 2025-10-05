// server.js — True Live v2.10.0 (RAG threshold estrito + memória robusta)
// - /twilio/whatsapp: ACK imediato (se Twilio configurado) e resposta final
// - Memória de assunto: salva/restaura por contato (Postgres). TTL 24h
// - RAG: só passa se score >= RAG_THRESHOLD
// - Fallback: sempre responde; preserva subject para perguntas relacionais
// - /admin/health: status do serviço

import express from "express";
import bodyParser from "body-parser";
import morgan from "morgan";
import pkg from "pg";
import { config as dotenv } from "dotenv";
dotenv();

import { search as hybridSearch, corpusSize } from "./services/hybridRag.js";

const { Pool } = pkg;

// ---------- CONFIG ----------
const CONFIG = {
  PORT: process.env.PORT || 3000,
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o-mini",
  OPENAI_TIMEOUT_MS: +(process.env.OPENAI_TIMEOUT_MS || 20000),

  RAG_THRESHOLD: +(process.env.RAG_THRESHOLD || 0.5),

  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "truelive2025",

  DB_URL: process.env.DATABASE_URL || "",

  TWILIO_SID: process.env.TWILIO_ACCOUNT_SID || "",
  TWILIO_TOKEN: process.env.TWILIO_AUTH_TOKEN || "",
  TWILIO_FROM: process.env.TWILIO_WHATSAPP_FROM || "",
  ANSWER_OUTSIDE_CORPUS_FIRST_N: +(process.env.ANSWER_OUTSIDE_CORPUS_FIRST_N || 1),
};

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(morgan("tiny"));

// ---------- TWILIO (opcional) ----------
let twilioClient = null;
if (CONFIG.TWILIO_SID && CONFIG.TWILIO_TOKEN) {
  const twilio = (await import("twilio")).default;
  twilioClient = twilio(CONFIG.TWILIO_SID, CONFIG.TWILIO_TOKEN);
}

// ---------- OPENAI ----------
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY });

// ---------- DB / MEMÓRIA ----------
let pool = null;
if (CONFIG.DB_URL) {
  pool = new Pool({ connectionString: CONFIG.DB_URL, ssl: { rejectUnauthorized: false } });
  // cria tabela se não existir
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subjects (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      subject TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_subject_phone ON subjects(phone);
  `);
}

async function saveSubject(phone, subject) {
  if (!pool || !phone || !subject) return;
  await pool.query(
    `INSERT INTO subjects (phone, subject, updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (id) DO NOTHING;`
  ).catch(() => {});
  await pool.query(
    `UPDATE subjects SET subject=$2, updated_at=NOW()
     WHERE phone=$1;`,
    [phone, subject]
  ).catch(() => {});
}

async function loadSubject(phone) {
  if (!pool || !phone) return null;
  const { rows } = await pool.query(
    `SELECT subject, updated_at
     FROM subjects
     WHERE phone=$1
     ORDER BY updated_at DESC
     LIMIT 1;`,
    [phone]
  );
  if (!rows.length) return null;
  // TTL 24h
  const updated = new Date(rows[0].updated_at).getTime();
  const ageMs = Date.now() - updated;
  if (ageMs > 24 * 3600 * 1000) return null;
  return rows[0].subject;
}

// ---------- UTIL ----------
function guessLang(text) {
  const t = (text || "").toLowerCase();
  if (/[áàãâéêíóôõúç]/.test(t) || / quem | qual | onde | como /.test(` ${t} `)) return "pt";
  if (/\b(qué|quién|dónde|cuál|cómo)\b/.test(t)) return "es";
  return "en";
}

function looksRelational(q) {
  const t = ` ${q.toLowerCase()} `;
  return [
    "esposa", "marido", "filho", "filha", "mãe", "mae", "pai", "sogro", "sogra",
    "dele", "dela", "seus", "seu", "sua", "onde nasceu", "onde ele nasceu", "onde ela nasceu",
    "where was", "his wife", "her husband", "children", "mother", "father", "parents",
  ].some(k => t.includes(k));
}

async function composeWithOpenAI({ lang, subject, query, docs, scope }) {
  const sys =
    lang === "pt"
      ? `Você é um assistente que responde com exatidão e em até 1200 caracteres. Cite fatos apenas do material fornecido no "Contexto".`
      : lang === "es"
      ? `Eres un asistente que responde con precisión y en hasta 1200 caracteres. Cita hechos solo del material en el "Contexto".`
      : `You are a precise assistant. Keep answers under 1200 characters. Use only facts from "Context".`;

  const ctx = docs
    .map((d, i) => `#${i + 1} ${d.title}\n${d.text}`)
    .join("\n\n");

  const prompt =
    (lang === "pt"
      ? `Pergunta: ${query}\nAssunto: ${subject || "(desconhecido)"}\n\nContexto:\n${ctx}\n\nResponda de forma direta.`
      : lang === "es"
      ? `Pregunta: ${query}\nTema: ${subject || "(desconocido)"}\n\nContexto:\n${ctx}\n\nResponde de forma directa.`
      : `Question: ${query}\nSubject: ${subject || "(unknown)"}\n\nContext:\n${ctx}\n\nAnswer directly.`);

  const comp = await openai.chat.completions.create({
    model: CONFIG.OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: prompt },
    ],
    timeout: CONFIG.OPENAI_TIMEOUT_MS,
  });

  return comp.choices?.[0]?.message?.content?.trim() || "";
}

function formatSources(top) {
  return top.map(d => d.title).join(" | ");
}

async function waSend(to, body) {
  if (!twilioClient || !CONFIG.TWILIO_FROM) return;
  await twilioClient.messages.create({
    from: CONFIG.TWILIO_FROM,
    to,
    body,
  });
}

// ---------- ROTA HEALTH ----------
app.get("/admin/health", async (req, res) => {
  const token = req.query.token || req.headers["x-admin-token"];
  if (token !== CONFIG.ADMIN_TOKEN) return res.status(403).json({ ok: false, error: "forbidden" });

  res.json({
    status: "ok",
    version: "v2.10.0",
    corpus_items: corpusSize(),
    db: !!pool,
  });
});

// ---------- WHATSAPP ----------
app.post("/twilio/whatsapp", async (req, res) => {
  const from = req.body?.From;       // "whatsapp:+55119..."
  const body = (req.body?.Body || "").trim();

  // ACK imediato (se Twilio configurado)
  if (twilioClient && from) {
    try { await waSend(from, "✅ Recebido, pensando..."); } catch {}
  }

  handleIncoming({ from, body })
    .then(async (reply) => {
      // envia pelo Twilio, se disponível; senão responde HTTP
      if (twilioClient && from) {
        try { await waSend(from, reply.text); } catch {}
        return res.sendStatus(200);
      } else {
        return res.json({ ok: true, ...reply });
      }
    })
    .catch((err) => {
      console.error("[ERROR] handleIncoming:", err?.message);
      if (twilioClient && from) return res.sendStatus(200);
      return res.status(500).json({ ok: false, error: "internal_error" });
    });
});

async function handleIncoming({ from, body }) {
  const lang = guessLang(body);
  const previousSubject = from ? await loadSubject(from) : null;

  // 1) Executa RAG com limiar estrito
  const rag = await hybridSearch({
    query: body,
    lang,
    threshold: CONFIG.RAG_THRESHOLD,
    prevSubject: previousSubject,
  });

  if (CONFIG.LOG_LEVEL === "info") {
    console.log("[INFO] RAG", {
      score: rag.bestScore?.toFixed?.(3),
      pass: rag.pass,
      subject: rag.subject || null,
      resolvedQuery: rag.resolvedQuery,
    });
  }

  // 2) Se RAG passou, compõe com OpenAI usando apenas docs top-k
  if (rag.pass) {
    const text = await composeWithOpenAI({
      lang,
      subject: rag.subject,
      query: rag.resolvedQuery,
      docs: rag.topDocs,
      scope: "in",
    });

    const suffix =
      lang === "pt"
        ? `\n\nBaseado no acervo.\nFontes: ${formatSources(rag.topDocs)}`
        : lang === "es"
        ? `\n\nBasado en el acervo.\nFuentes: ${formatSources(rag.topDocs)}`
        : `\n\nBased on the corpus.\nSources: ${formatSources(rag.topDocs)}`;

    // salva subject (se mudou)
    if (from && rag.subject) await saveSubject(from, rag.subject);

    return { scope: "in", text: `${text}${suffix}`, subject: rag.subject };
  }

  // 3) Fallback (fora do acervo) — preserva subject se pergunta relacional
  const fallbackSubject = looksRelational(body) && previousSubject ? previousSubject : null;
  const sys =
    lang === "pt"
      ? "Você é um assistente geral. Responda de forma clara, sucinta e útil."
      : lang === "es"
      ? "Eres un asistente general. Responde de forma clara, sucinta y útil."
      : "You are a helpful general assistant. Be clear and concise.";

  const comp = await openai.chat.completions.create({
    model: CONFIG.OPENAI_MODEL,
    temperature: 0.4,
    timeout: CONFIG.OPENAI_TIMEOUT_MS,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: body },
    ],
  });
  const answer = comp.choices?.[0]?.message?.content?.trim() || "";

  const outside =
    lang === "pt"
      ? "Resposta geral (fora do acervo)."
      : lang === "es"
      ? "Respuesta general (fuera del acervo)."
      : "General answer (outside the corpus).";

  // Atualiza subject se pergunta relacional
  if (from && fallbackSubject) await saveSubject(from, fallbackSubject);

  return { scope: "out", text: `${answer}\n\n${outside}`, subject: fallbackSubject };
}

// ---------- START ----------
app.listen(CONFIG.PORT, () => {
  console.log(`[INFO] Server up { port: '${CONFIG.PORT}', corpus_items: ${corpusSize()} }`);
});
