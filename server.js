// server.js — True Live v2.6.3 (memória robusta mesmo em fallback)
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import pkg from "pg";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { search as hybridSearch, loadAliases } from "./services/hybridRag.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =======================
// Config
// =======================
const {
  PORT = 3000,
  ADMIN_TOKEN = "truelive2025",
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  OPENAI_TIMEOUT_MS = "10000",
  RAG_THRESHOLD = "0.4",
  ANSWER_OUTSIDE_CORPUS = "1",
  // Twilio
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  // Postgres (opcional)
  DATABASE_URL,
  NODE_ENV = "production",
} = process.env;

const CONFIG = {
  OPENAI_API_KEY,
  OPENAI_MODEL,
  OPENAI_TIMEOUT_MS: Number(OPENAI_TIMEOUT_MS),
  RAG_THRESHOLD: Number(RAG_THRESHOLD),
  ANSWER_OUTSIDE_CORPUS: ANSWER_OUTSIDE_CORPUS === "1",
};

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// =======================
// Corpus & Aliases
// =======================
const corpusPath = path.join(__dirname, "corpus", "corpus.json");
let CORPUS = [];
try {
  CORPUS = JSON.parse(readFileSync(corpusPath, "utf-8"));
  console.log("[INFO] Corpus loaded:", CORPUS.length, "items.");
} catch (e) {
  console.error("[ERROR] Não consegui carregar corpus:", e?.message || e);
}
const ALIASES = loadAliases(); // vem do hybridRag.js

// =======================
// PG (opcional) para memória
// =======================
let db = null;
let mem = new Map(); // fallback in-memory

async function dbInit() {
  if (!DATABASE_URL) return null;
  const { Pool } = pkg;
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS convo_context (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      subject TEXT,
      lang TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_convo_user ON convo_context(user_id);
  `);
  console.log("[INFO] Postgres conectado.");
  return pool;
}
const ready = (async () => { db = await dbInit(); })();

async function setSubject(userId, subject, lang = "pt") {
  if (!subject) return;
  if (db) {
    await db.query(
      `INSERT INTO convo_context (user_id, subject, lang, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (user_id) DO UPDATE SET subject=EXCLUDED.subject, lang=EXCLUDED.lang, updated_at=NOW();`,
      [userId, subject, lang]
    ).catch(() => {});
  } else {
    mem.set(userId, { subject, lang, updated_at: Date.now() });
  }
}
async function getSubject(userId) {
  if (db) {
    const r = await db.query(`SELECT subject, lang FROM convo_context WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 1`, [userId]).catch(() => null);
    return r?.rows?.[0] || null;
  }
  return mem.get(userId) || null;
}

// =======================
// Utilidades de assunto
// =======================
function norm(t) { return (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, ""); }

function resolveSubjectFromText(text) {
  const t = norm(text);
  // 1) checa aliases (chave ou valor)
  for (const [canonical, vars] of Object.entries(ALIASES)) {
    if (t.includes(norm(canonical))) return canonical;
    if (vars?.some(v => t.includes(norm(v)))) return canonical;
  }
  // 2) fallback: nomes evidentes muito comuns do corpus (títulos/nomes)
  for (const item of CORPUS) {
    const title = norm(item.title || "");
    if (title && t.includes(title.split(" — ")[0])) return item.title.split(" — ")[0];
  }
  return null;
}

function usesPronoun(text) {
  const t = norm(text);
  return /( ele | ela | dele | dela | him | her )/.test(` ${t} `);
}

// =======================
// OpenAI helper (fallback)
// =======================
async function openaiAnswer({ userQuery, lang, subject }) {
  const hosts = "Use fatos consistentes e concisos. Cite fontes do acervo quando disponível.";
  const sys = lang === "en"
    ? `You are a direct assistant. Answer in English up to 1200 characters.`
    : lang === "es"
    ? `Eres un asistente directo. Responde en español en hasta 1200 caracteres.`
    : `Você é um assistente direto. Responda em português em até 1200 caracteres.`;
  const contextLine = subject ? (lang === "en" ? `Context: the current conversation is about ${subject}.` :
                     lang === "es" ? `Contexto: la conversación actual es sobre ${subject}.` :
                     `Contexto: a conversa atual é sobre ${subject}.`) : "";

  const messages = [
    { role: "system", content: `${sys}\n${hosts}\n${contextLine}`.trim() },
    { role: "user", content: userQuery }
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.OPENAI_TIMEOUT_MS);

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CONFIG.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: CONFIG.OPENAI_MODEL,
        messages,
        temperature: 0.4
      })
    });
    clearTimeout(timer);
    const json = await resp.json();
    const txt = json?.choices?.[0]?.message?.content?.trim() || "OK.";
    return { kind: "fallback", text: txt };
  } catch {
    clearTimeout(timer);
    const msg = lang === "en"
      ? "I couldn't reach the external source right now. Please try again shortly."
      : lang === "es"
      ? "En este momento no pude consultar la fuente externa. Intenta de nuevo en unos instantes."
      : "No momento não consegui consultar a fonte externa. Tente novamente em instantes.";
    return { kind: "fallback_error", text: msg };
  }
}

// =======================
// Twilio helper
// =======================
async function twilioSend(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
    console.warn("[WARN] Twilio OFF (mensagem não enviada).");
    return;
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const params = new URLSearchParams();
  params.append("From", TWILIO_WHATSAPP_FROM);
  params.append("To", to);
  params.append("Body", body);
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  }).catch(e => console.error("Falha ao enviar WhatsApp:", e?.message || e));
}

// =======================
// Rotas
// =======================
app.get("/admin/health", (req, res) => {
  if ((req.query.token || "") !== ADMIN_TOKEN) return res.status(401).json({ ok: false });
  res.json({ status: "ok", corpus_items: CORPUS.length });
});

// Alias de webhook simplificado
app.post("/whatsapp", async (req, res, next) => {
  req.body.From = req.body.From || req.body.from;
  req.body.Body = req.body.Body || req.body.body;
  return twilioWebhook(req, res, next);
});

app.post("/twilio/whatsapp", twilioWebhook);

async function twilioWebhook(req, res, _next) {
  // ACK imediato
  res.status(200).send(""); // evita timeout do Twilio

  const from = req.body.From || req.body.from;
  const body = (req.body.Body || "").trim();
  const userId = from || "unknown";

  // Lang heurística simples
  const lang = /[a-z]/i.test(body) && /[A-Za-z]/.test(body) ? (/[áéíóúãõç]/i.test(body) ? "pt" : /[ñáéíóú]/i.test(body) ? "es" : "en") : "pt";

  // 1) tenta resolver assunto explícito na pergunta
  let subject = resolveSubjectFromText(body);

  // 2) se não tiver, tenta usar pronome + último assunto
  if (!subject && usesPronoun(body)) {
    const last = await getSubject(userId);
    if (last?.subject) subject = last.subject;
  }

  // 3) RAG
  const rag = await hybridSearch({
    query: body,
    threshold: CONFIG.RAG_THRESHOLD,
    subject
  });

  // 4) Decide resposta
  let outText = "";
  if (rag.pass) {
    // guarda assunto se o RAG já reconhecer um título forte
    if (!subject && rag?.bestTitle) subject = rag.bestTitle.split(" — ")[0];
    outText =
      (lang === "en" ? "Based on the corpus.\nSources: " :
       lang === "es" ? "Basado en el acervo.\nFuentes: " :
       "Baseado no acervo.\nFontes: ") +
      (rag.sources || "corpus");
    // prependa o texto principal do RAG
    outText = `${rag.text}\n\n${outText}`;
  } else {
    const fb = await openaiAnswer({ userQuery: body, lang, subject });
    outText = fb.text + (CONFIG.ANSWER_OUTSIDE_CORPUS ? (lang === "en" ? "\n\nGeneral answer (outside corpus)." :
                                 lang === "es" ? "\n\nRespuesta general (fuera del acervo)." :
                                 "\n\nResposta geral (fora do acervo).") : "");
  }

  // 5) **SALVA O ASSUNTO MESMO EM FALLBACK** se der para inferir
  if (!subject) subject = resolveSubjectFromText(body);
  if (subject) await setSubject(userId, subject, lang);

  // 6) Envia pelo WhatsApp
  await twilioSend(from, "✅ Received, thinking...");
  await twilioSend(from, outText);
}

// =======================
// Start
// =======================
app.listen(PORT, () => {
  console.log("[INFO] Server up", { port: String(PORT), corpus_items: CORPUS.length });
});
