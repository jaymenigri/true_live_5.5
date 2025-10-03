// server.js — True Live v2.7 (definitivo, tolerante a exports do RAG)
// - ACK imediato no WhatsApp para evitar timeout.
// - Busca híbrida via services/hybridRag.js com fallback garantido.
// - Memória de assunto por usuário (RAM + opcional Postgres com TTL).
// - /admin/health com contagem do corpus e ping.
// - Logs claros (INFO/WARN/ERROR), sem “recusas em branco”.

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------- Ambiente ----------
const {
  PORT,
  ADMIN_TOKEN = "truelive2025",
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  OPENAI_TIMEOUT_MS = "10000",
  RAG_THRESHOLD = "0.4",
  ANSWER_OUTSIDE_CORPUS = "1",
  OFFTOPIC_MAX = "3",
  OFFTOPIC_COOLDOWN_MIN = "15",
  LOG_LEVEL = "info",

  // Twilio (para WhatsApp)
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM, // ex.: "whatsapp:+18706068686"

  // Postgres (opcional)
  DATABASE_URL,
} = process.env;

const CONFIG = {
  PORT: Number(PORT) || 3000,
  OPENAI_MODEL,
  OPENAI_TIMEOUT_MS: Number(OPENAI_TIMEOUT_MS) || 10000,
  RAG_THRESHOLD: Number(RAG_THRESHOLD) || 0.4,
  ANSWER_OUTSIDE_CORPUS: ANSWER_OUTSIDE_CORPUS === "1" || ANSWER_OUTSIDE_CORPUS === "true",
  OFFTOPIC_MAX: Number(OFFTOPIC_MAX) || 3,
  OFFTOPIC_COOLDOWN_MIN: Number(OFFTOPIC_COOLDOWN_MIN) || 15,
  LOG_LEVEL,
};

// ---------- Util de log ----------
const levels = { error: 0, warn: 1, info: 2, debug: 3 };
function log(level, ...args) {
  if ((levels[level] ?? 2) <= (levels[CONFIG.LOG_LEVEL] ?? 2)) {
    console.log(`[${level.toUpperCase()}]`, ...args);
  }
}

// ---------- Resolução tolerante do RAG ----------
import * as ragModule from "./services/hybridRag.js";
const hybridSearch =
  ragModule.search ||
  ragModule.hybridSearch ||
  (typeof ragModule.default === "function" ? ragModule.default : ragModule.default?.search);

if (typeof hybridSearch !== "function") {
  throw new Error(
    "hybridRag.js: não encontrei a função de busca (search/hybridSearch/default)."
  );
}

// Opcional: tentar ler contagem do corpus no disco para o /health
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let CORPUS_COUNT = 0;
try {
  const corpusPath = path.join(__dirname, "corpus", "corpus.json");
  const buf = fs.readFileSync(corpusPath, "utf8");
  const arr = JSON.parse(buf);
  if (Array.isArray(arr)) CORPUS_COUNT = arr.length;
  log("info", `Corpus loaded: ${CORPUS_COUNT} items.`);
} catch (e) {
  log("warn", "Não consegui ler corpus/corpus.json (somente para health):", e?.message);
}

// ---------- Twilio client (opcional) ----------
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  const twilio = await import("twilio").then((m) => m.default || m);
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// ---------- Postgres (opcional) ----------
let pgPool = null;
if (DATABASE_URL) {
  try {
    const pg = await import("pg").then((m) => m.default || m);
    pgPool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    // criar tabela simples para “assunto” (memória de conversa)
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS tl_subject_memory (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        subject TEXT,
        lang TEXT,
        ts TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS tl_subject_memory_phone_idx ON tl_subject_memory (phone);
    `);
    log("info", "Postgres conectado.");
  } catch (e) {
    log("warn", "Postgres indisponível, seguindo sem persistência:", e?.message);
    pgPool = null;
  }
}

// ---------- Memória em RAM (sempre) ----------
const mem = new Map(); // key: phone -> { subject, lang, ts }
const SUBJECT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

async function rememberSubject(phone, subject, lang) {
  const rec = { subject: subject || null, lang: lang || "pt", ts: Date.now() };
  mem.set(phone, rec);
  if (pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO tl_subject_memory (phone, subject, lang) VALUES ($1,$2,$3)`,
        [phone, subject || null, lang || "pt"]
      );
    } catch (e) {
      log("warn", "Falha ao salvar subject no Postgres:", e?.message);
    }
  }
}

async function readSubject(phone) {
  // RAM primeiro
  const got = mem.get(phone);
  if (got && Date.now() - got.ts < SUBJECT_TTL_MS) {
    return { subject: got.subject, lang: got.lang };
  }
  // fallback Postgres (último registro)
  if (pgPool) {
    try {
      const { rows } = await pgPool.query(
        `SELECT subject, lang, ts FROM tl_subject_memory WHERE phone=$1 ORDER BY ts DESC LIMIT 1`,
        [phone]
      );
      if (rows[0]) {
        const r = rows[0];
        return { subject: r.subject || null, lang: r.lang || "pt" };
      }
    } catch (e) {
      log("warn", "Falha ao ler subject no Postgres:", e?.message);
    }
  }
  return { subject: null, lang: "pt" };
}

// ---------- Fallback OpenAI ----------
async function openaiFallback(userQuery, lang = "pt", subject = null) {
  const sysPT =
    "Você é um assistente direto. Responda em português em até 1200 caracteres.";
  const sysEN = "You are a direct assistant. Answer in English in up to 1200 characters.";
  const sysES = "Eres un asistente directo. Responde en español en hasta 1200 caracteres.";

  const sys =
    lang === "en" ? sysEN : lang === "es" ? sysES : sysPT;

  const hosts =
    "Prefira fatos consistentes; cite números com parcimônia; seja claro e conciso.";
  const extra = subject ? ` Contexto: a conversa atual é sobre ${subject}.` : "";

  const messages = [
    { role: "system", content: `${sys} ${hosts}${extra}` },
    { role: "user", content: userQuery },
  ];

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), CONFIG.OPENAI_TIMEOUT_MS);

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: CONFIG.OPENAI_MODEL,
        messages,
        temperature: 0.4,
      }),
    });
    clearTimeout(to);
    const json = await resp.json();
    const txt = json?.choices?.[0]?.message?.content?.trim() || "OK.";
    return { kind: "fallback", text: txt, sources: [], score: 0 };
  } catch (e) {
    clearTimeout(to);
    const msgPT =
      "No momento não consegui consultar a fonte externa. Tente novamente em instantes.";
    return { kind: "fallback_error", text: msgPT, sources: [], score: 0 };
  }
}

// ---------- Express ----------
const app = express();
// Twilio envia application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health simples
app.get("/health", (_req, res) => res.send("ok"));

// Health com token e contagem de corpus
app.get("/admin/health", (req, res) => {
  const token = req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ status: "unauthorized" });
  return res.json({
    status: "ok",
    corpus_items: CORPUS_COUNT,
    time: new Date().toISOString(),
  });
});

// ---------- Util WhatsApp ----------
async function sendWhatsApp(to, body) {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) {
    log("warn", "Twilio OFF (mensagem não enviada). Body:", body?.slice?.(0, 120));
    return;
  }
  try {
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to,
      body,
    });
  } catch (e) {
    log("error", "Falha ao enviar WhatsApp:", e?.message);
  }
}

// ACK rápido
async function sendAck(to) {
  const check = "✅";
  const body = `${check} Received, thinking...`;
  await sendWhatsApp(to, body);
}

// Detecta idioma simples
function detectLang(txt = "") {
  const s = (txt || "").toLowerCase();
  if (/[áéíóúãõç]/.test(s) || /que|quem|onde|como|por que/.test(s)) return "pt";
  if (/¿|¡/.test(s) || /\b(dónde|qué|quién|cómo)\b/.test(s)) return "es";
  return "en";
}

// ---------- Webhook do WhatsApp ----------
app.post("/twilio/whatsapp", async (req, res) => {
  // Responde 200 imediatamente (ACK HTTP para Twilio)
  res.status(200).send("");

  const from = req.body?.From || req.body?.from || "";
  const to = req.body?.To || req.body?.to || "";
  const body = (req.body?.Body || req.body?.body || "").trim();
  if (!from || !body) {
    log("warn", "Webhook sem From/Body. Ignorando.");
    return;
  }

  // ACK via WhatsApp (para o usuário ver que recebemos)
  sendAck(from).catch(() => {});

  // Recupera último assunto/idioma
  const last = await readSubject(from);
  const lang = detectLang(body) || last.lang || "pt";

  // Chama o RAG híbrido
  let result;
  try {
    result = await hybridSearch(body, {
      threshold: CONFIG.RAG_THRESHOLD,
      lang,
      prevSubject: last.subject,
    });
  } catch (e) {
    log("error", "Erro no hybridSearch:", e?.message);
    result = null;
  }

  // Formatação final
  let finalText = "";
  let decidedSubject = last.subject || null;

  if (result && (result.kind === "corpus" || (result.score ?? 0) >= CONFIG.RAG_THRESHOLD)) {
    // Resposta do acervo
    const sources = Array.isArray(result.sources) ? result.sources : [];
    const srcLine =
      sources.length
        ? `\n\nBaseado no acervo.\nFontes: ${sources
            .map((s) => (s?.title ? s.title : s?.id || "corpus"))
            .join(" | ")}`
        : `\n\nBaseado no acervo.`;

    finalText = `${result.text?.trim() || "OK."}${srcLine}`;
    decidedSubject = result.subject || decidedSubject;

  } else {
    // Fallback geral — NUNCA recusar
    const fb = await openaiFallback(body, lang, last.subject);
    finalText = fb.text?.trim() || "OK.";
    if (CONFIG.ANSWER_OUTSIDE_CORPUS) {
      const tag =
        lang === "en"
          ? "\n\nGeneral answer (outside the curated corpus)."
          : lang === "es"
          ? "\n\nRespuesta general (fuera del acervo)."
          : "\n\nResposta geral (fora do acervo).";
      finalText += tag;
    }
  }

  // Memoriza novo “assunto” se houver no resultado
  if (result?.subject) {
    await rememberSubject(from, result.subject, lang).catch(() => {});
  }

  // Envia resposta final
  await sendWhatsApp(from, finalText);
  log("info", "RAG result", {
    from,
    scope: result?.kind === "corpus" ? "in" : "out",
    score: (result?.score ?? 0).toFixed(3),
    prevSubject: last.subject || null,
    resolvedQuery: body,
  });
});

// ---------- Sobe o servidor ----------
app.listen(CONFIG.PORT, () => {
  log("info", "Server up", { port: String(CONFIG.PORT), corpus_items: CORPUS_COUNT });
});
