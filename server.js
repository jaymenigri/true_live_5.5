// server.js — True Live v2.10.1
// - RAG threshold estrito + memória de assunto via Postgres
// - Fallback garantido e consciente de contexto
// - /admin/health com status e contagem do corpus
// - Logger embutido (dispensa "morgan")

import express from "express";
import bodyParser from "body-parser";
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

// ---------- APP ----------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Logger embutido (substitui morgan)
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    if (CONFIG.LOG_LEVEL !== "silent") {
      console.log(
        `[REQ] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - t0}ms)`
      );
    }
  });
  next();
});

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subjects (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL UNIQUE,
      subject TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
}

async function saveSubject(phone, subject) {
  if (!pool || !phone || !subject) return;
  await pool.query(
    `INSERT INTO subjects (phone, subject, updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (phone) DO UPDATE SET subject=EXCLUDED.subject, updated_at=NOW();`,
    [phone, subject]
  );
}

async function loadSubject(phone) {
  if (!pool || !phone) return null;
  const { rows } = await pool.query(
    `SELECT subject, updated_at FROM subjects WHERE phone=$1 LIMIT 1;`,
    [phone]
  );
  if (!rows.length) return null;
  const updated = new Date(rows[0].updated_at).getTime();
  if (Date.now() - updated > 24 * 3600 * 1000) return null; // TTL 24h
  return rows[0].subject;
}

// ---------- UTIL ----------
function guessLang(text) {
  const t = (text || "").toLowerCase();
  if (/[áàãâéêíóôõúç]/.test(t) || /\b(quem|qual|onde|como)\b/.test(t)) return "pt";
  if (/\b(qué|quién|dónde|cuál|cómo)\b/.test(t)) return "es";
  return "en";
}
function looksRelational(q) {
  const t = ` ${q.toLowerCase()} `;
  return [
    "esposa","marido","filho","filha","mãe","mae","pai","sogro","sogra",
    "dele","dela","seus","seu","sua","onde nasceu","onde ele nasceu","onde ela nasceu",
    "where was","his wife","her husband","children","mother","father","parents",
  ].some(k => t.includes(k));
}
function formatSources(top) {
  return top.map(d => d.title).join(" | ");
}

async function waSend(to, body) {
  if (!twilioClient || !CONFIG.TWILIO_FROM) return;
  await twilioClient.messages.create({ from: CONFIG.TWILIO_FROM, to, body });
}

// ---------- OPENAI HELPERS ----------
async function composeWithOpenAI({ lang, subject, query, docs }) {
  const sys =
    lang === "pt"
      ? `Você é um assistente que responde com exatidão e em até 1200 caracteres. Cite fatos apenas do "Contexto".`
      : lang === "es"
      ? `Eres un asistente que responde con precisión y en hasta 1200 caracteres. Cita hechos solo del "Contexto".`
      : `You are a precise assistant. Keep answers under 1200 characters. Use only facts from "Context".`;

  const ctx = docs.map((d,i)=>`#${i+1} ${d.title}\n${d.text}`).join("\n\n");

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

// ---------- HEALTH ----------
app.get("/admin/health", async (req, res) => {
  const token = req.query.token || req.headers["x-admin-token"];
  if (token !== CONFIG.ADMIN_TOKEN) return res.status(403).json({ ok:false, error:"forbidden" });
  res.json({ status:"ok", version:"v2.10.1", corpus_items: corpusSize(), db: !!pool });
});

// ---------- WHATSAPP ----------
app.post("/twilio/whatsapp", async (req, res) => {
  const from = req.body?.From;             // "whatsapp:+5511..."
  const body = (req.body?.Body || "").trim();
  const lang = guessLang(body);
  const prevSubject = from ? await loadSubject(from) : null;

  // ACK rápido se houver Twilio
  if (twilioClient && from) { try { await waSend(from, "✅ Recebido, pensando..."); } catch {} }

  try {
    // 1) RAG com limiar estrito
    const rag = await hybridSearch({
      query: body,
      lang,
      threshold: CONFIG.RAG_THRESHOLD,
      prevSubject,
    });

    if (CONFIG.LOG_LEVEL === "info") {
      console.log("[INFO] RAG", {
        score: rag.bestScore?.toFixed?.(3),
        pass: rag.pass,
        subject: rag.subject || null,
        resolvedQuery: rag.resolvedQuery,
      });
    }

    let replyText = "";
    if (rag.pass) {
      // 2) Geração baseada no acervo
      const text = await composeWithOpenAI({
        lang,
        subject: rag.subject,
        query: rag.resolvedQuery,
        docs: rag.topDocs,
      });
      const suffix =
        lang === "pt"
          ? `\n\nBaseado no acervo.\nFontes: ${formatSources(rag.topDocs)}`
          : lang === "es"
          ? `\n\nBasado en el acervo.\nFuentes: ${formatSources(rag.topDocs)}`
          : `\n\nBased on the corpus.\nSources: ${formatSources(rag.topDocs)}`;

      replyText = `${text}${suffix}`;
      if (from && rag.subject) await saveSubject(from, rag.subject);
    } else {
      // 3) Fallback geral, preservando subject se pergunta relacional
      const useSubject = looksRelational(body) && prevSubject ? prevSubject : null;
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
        lang === "pt" ? "Resposta geral (fora do acervo)." :
        lang === "es" ? "Respuesta general (fuera del acervo)." :
                         "General answer (outside the corpus).";
      replyText = `${answer}\n\n${outside}`;
      if (from && useSubject) await saveSubject(from, useSubject);
    }

    // Envia por Twilio (se disponível) ou responde HTTP
    if (twilioClient && from) {
      try { await waSend(from, replyText); } catch {}
      return res.sendStatus(200);
    } else {
      return res.json({ ok: true, text: replyText });
    }
  } catch (err) {
    console.error("[ERROR] /twilio/whatsapp:", err?.message || err);
    if (twilioClient && from) return res.sendStatus(200);
    return res.status(500).json({ ok:false, error:"internal_error" });
  }
});

// ---------- START ----------
app.listen(CONFIG.PORT, () => {
  console.log(`[INFO] Server up { port: '${CONFIG.PORT}', corpus_items: ${corpusSize()} }`);
});
