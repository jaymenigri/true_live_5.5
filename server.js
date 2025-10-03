// server.js — True Live v2.7 (definitivo, com alias /whatsapp)
// - ACK imediato no WhatsApp.
// - Busca híbrida via services/hybridRag.js com fallback garantido.
// - Memória de assunto por usuário (RAM + Postgres opcional).
// - /admin/health com contagem do corpus e ping.
// - Logs claros (INFO/WARN/ERROR).
// - ATENÇÃO: agora expõe DOIS endpoints equivalentes:
//      POST /twilio/whatsapp   (canônico)
//      POST /whatsapp          (alias, para compatibilidade com Twilio)

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
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

const levels = { error: 0, warn: 1, info: 2, debug: 3 };
function log(level, ...args) {
  if ((levels[level] ?? 2) <= (levels[CONFIG.LOG_LEVEL] ?? 2)) {
    console.log(`[${level.toUpperCase()}]`, ...args);
  }
}

// ---------- Resolução tolerante do RAG ----------
import * as ragModule from "./services/hybridRag.js";
let hybridSearch = null;
const listCandidates = (mod) => {
  const arr = [];
  if (mod) {
    arr.push(mod.search, mod.hybridSearch, mod.default);
    arr.push(...Object.values(mod).filter((v) => typeof v === "function"));
    if (mod.default && typeof mod.default === "object") {
      arr.push(...Object.values(mod.default).filter((v) => typeof v === "function"));
    }
  }
  return arr.filter(Boolean);
};
for (const fn of listCandidates(ragModule)) {
  if (typeof fn === "function") { hybridSearch = fn; break; }
}
if (typeof hybridSearch !== "function") {
  throw new Error("hybridRag.js: não encontrei uma função de busca.");
}

// ---------- Corpus count (para health) ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let CORPUS_COUNT = 0;
try {
  const corpusPath = path.join(__dirname, "corpus", "corpus.json");
  const arr = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  if (Array.isArray(arr)) CORPUS_COUNT = arr.length;
  log("info", `Corpus loaded: ${CORPUS_COUNT} items.`);
} catch (e) {
  log("warn", "Não consegui ler corpus/corpus.json (somente para health):", e?.message);
}

// ---------- Twilio ----------
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  const twilio = await import("twilio").then((m) => m.default || m);
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}
async function sendWhatsApp(to, body) {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) {
    log("warn", "Twilio OFF (mensagem não enviada). Body:", body?.slice?.(0, 160));
    return;
  }
  try {
    await twilioClient.messages.create({ from: TWILIO_WHATSAPP_FROM, to, body });
  } catch (e) {
    log("error", "Falha ao enviar WhatsApp:", e?.message);
  }
}
async function sendAck(to) {
  await sendWhatsApp(to, "✅ Received, thinking...");
}

// ---------- Postgres opcional ----------
let pgPool = null;
if (DATABASE_URL) {
  try {
    const pg = await import("pg").then((m) => m.default || m);
    pgPool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
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

// ---------- Memória simples ----------
const mem = new Map(); // phone -> { subject, lang, ts }
const SUBJECT_TTL_MS = 24 * 60 * 60 * 1000;
async function rememberSubject(phone, subject, lang) {
  mem.set(phone, { subject: subject || null, lang: lang || "pt", ts: Date.now() });
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
  const got = mem.get(phone);
  if (got && Date.now() - got.ts < SUBJECT_TTL_MS) return { subject: got.subject, lang: got.lang };
  if (pgPool) {
    try {
      const { rows } = await pgPool.query(
        `SELECT subject, lang, ts FROM tl_subject_memory WHERE phone=$1 ORDER BY ts DESC LIMIT 1`,
        [phone]
      );
      if (rows[0]) return { subject: rows[0].subject || null, lang: rows[0].lang || "pt" };
    } catch (e) {
      log("warn", "Falha ao ler subject no Postgres:", e?.message);
    }
  }
  return { subject: null, lang: "pt" };
}

// ---------- OpenAI fallback ----------
async function openaiFallback(userQuery, lang = "pt", subject = null) {
  const sysPT = "Você é um assistente direto. Responda em português em até 1200 caracteres.";
  const sysEN = "You are a direct assistant. Answer in English in up to 1200 characters.";
  const sysES = "Eres un asistente directo. Responde en español en hasta 1200 caracteres.";
  const sys = lang === "en" ? sysEN : lang === "es" ? sysES : sysPT;
  const extra = subject ? ` Contexto: a conversa atual é sobre ${subject}.` : "";

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), Number(OPENAI_TIMEOUT_MS) || 10000);

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: `${sys}${extra}` },
          { role: "user", content: userQuery },
        ],
        temperature: 0.4,
      }),
    });
    clearTimeout(to);
    const json = await resp.json();
    const txt = json?.choices?.[0]?.message?.content?.trim() || "OK.";
    return { kind: "fallback", text: txt };
  } catch {
    clearTimeout(to);
    const msgPT = "No momento não consegui consultar a fonte externa. Tente novamente em instantes.";
    return { kind: "fallback_error", text: msgPT };
  }
}

// ---------- App ----------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/health", (_req, res) => res.send("ok"));
app.get("/admin/health", (req, res) => {
  const token = req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ status: "unauthorized" });
  res.json({ status: "ok", corpus_items: CORPUS_COUNT, time: new Date().toISOString() });
});

function detectLang(txt = "") {
  const s = txt.toLowerCase();
  if (/[áéíóúãõç]/.test(s) || /\b(que|quem|onde|como|por que|qual)\b/.test(s)) return "pt";
  if (/¿|¡/.test(s) || /\b(dónde|qué|quién|cómo|por qué|cuál)\b/.test(s)) return "es";
  return "en";
}

// ---------- Handler único do WhatsApp ----------
async function whatsappHandler(req, res) {
  try {
    // ACK HTTP pro Twilio
    try { res.status(200).send(""); } catch {}

    const from = req.body?.From || req.body?.from || "";
    const body = (req.body?.Body || req.body?.body || "").trim();
    if (!from || !body) { log("warn", "Webhook sem From/Body"); return; }

    // ACK via WhatsApp
    sendAck(from).catch(() => {});

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

    let finalText = "";
    if (result && (result.kind === "corpus" || (result.score ?? 0) >= CONFIG.RAG_THRESHOLD)) {
      const sources = Array.isArray(result.sources) ? result.sources : [];
      const srcLine = sources.length
        ? `\n\nBaseado no acervo.\nFontes: ${sources.map(s => (s?.title ? s.title : s?.id || "corpus")).join(" | ")}`
        : `\n\nBaseado no acervo.`;
      finalText = `${(result.text || "OK.").trim()}${srcLine}`;
      if (result.subject) await rememberSubject(from, result.subject, lang).catch(() => {});
    } else {
      const fb = await openaiFallback(body, lang, last.subject);
      finalText = (fb.text || "OK.").trim();
      if (CONFIG.ANSWER_OUTSIDE_CORPUS) {
        finalText += lang === "en"
          ? "\n\nGeneral answer (outside the curated corpus)."
          : lang === "es"
          ? "\n\nRespuesta general (fuera del acervo)."
          : "\n\nResposta geral (fora do acervo).";
      }
    }

    await sendWhatsApp(from, finalText);

    log("info", "RAG result", {
      from,
      scope: result?.kind === "corpus" ? "in" : "out",
      score: (result?.score ?? 0).toFixed(3),
      prevSubject: last.subject || null,
      resolvedQuery: body,
    });
  } catch (e) {
    log("error", "Webhook handler error:", e?.message);
  }
}

// **Rotas equivalentes** (canônica e alias)
app.post("/twilio/whatsapp", whatsappHandler);
app.post("/whatsapp", whatsappHandler);

// ---------- Start ----------
app.listen(CONFIG.PORT, () => {
  log("info", "Server up", { port: String(CONFIG.PORT), corpus_items: CORPUS_COUNT });
});
