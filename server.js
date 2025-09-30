// server.js — True Live v2.6 (final)
// - Webhook WhatsApp (Twilio) com ACK imediato
// - RAG híbrido + fallback SEM recusa
// - Histórico por usuário para perguntas relacionais (coref)
// - /health com contagem do corpus
// ------------------------------------------------------------------

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import Twilio from "twilio";
import path from "path";
import { fileURLToPath } from "url";
import { hybridSearch, corpusCount } from "./services/hybridRag.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------- ENV -----------------------------------
const {
  PORT = 3000,
  ADMIN_TOKEN = "truelive2025",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  OPENAI_TIMEOUT_MS = "8000",
  RAG_THRESHOLD = "0.40",
  LOG_LEVEL = "info"
} = process.env;

const RAG_THR = Math.max(0, Math.min(1, Number(RAG_THRESHOLD) || 0.4));
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ------------------------- Twilio --------------------------------
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// --------------------- Memória por usuário ------------------------
/**
 * sessions[from] = {
 *   lang: 'pt'|'en'|'es',
 *   lastSubject: 'David Ben-Gurion',
 *   lastWasCorpus: true|false,
 *   lastAt: Date.now()
 * }
 */
const sessions = Object.create(null);
const ttlMs = 24 * 60 * 60 * 1000; // 24h

function touchSession(from) {
  const s = sessions[from] || {};
  s.lastAt = Date.now();
  sessions[from] = s;
  return s;
}

function detectLang(text = "") {
  // heurística simples
  const t = (text || "").toLowerCase();
  if (/[áéíóúãõç]/.test(t) || /\b(quem|onde|quando|qual|sobre|é|foi|de|do|da)\b/.test(t)) return "pt";
  if (/\b(qué|dónde|cuándo|quién|sobre|es|fue|de|del|la|el)\b/.test(t)) return "es";
  return "en";
}

async function sendTwilio(to, body) {
  if (!twilioClient) return;
  try {
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to,
      body
    });
  } catch (err) {
    log("error", "Twilio send failed", { to, err: String(err?.message || err) });
  }
}

function log(level, msg, extra = {}) {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const want = levels[LOG_LEVEL] ?? 2;
  const have = levels[level] ?? 2;
  if (have <= want) {
    console.log(`[${level.toUpperCase()}]`, msg, Object.keys(extra).length ? extra : "");
  }
}

// ------------------------ OpenAI fallback -------------------------
async function callOpenAI(prompt, lang = "pt") {
  const sys = {
    pt: "Você é um assistente factual e claro. Responda em português.",
    en: "You are a factual, clear assistant. Reply in English.",
    es: "Eres un asistente factual y claro. Responde en español."
  }[lang] || "You are a helpful assistant.";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(OPENAI_TIMEOUT_MS) || 8000);

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: prompt }
        ],
        temperature: 0.4
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text || "";
  } catch (err) {
    log("error", "OpenAI error", { err: String(err?.message || err) });
    return "";
  }
}

// --------------------------- Health --------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", corpus_items: corpusCount() });
});

// --------------- WhatsApp Webhook (Twilio) -------------------------
app.post("/twilio/whatsapp", async (req, res) => {
  // Twilio sempre espera uma resposta HTTP 200 rapidamente
  res.status(200).send(""); // ACK HTTP imediato
  const from = req.body?.From;
  const body = (req.body?.Body || "").trim();

  if (!from || !body) return;

  // ACK visual no WhatsApp (opcional)
  await sendTwilio(from, "✅ Received, thinking...");

  const sess = touchSession(from);
  sess.lang = detectLang(body);

  // --------- RAG híbrido com contexto de histórico ---------
  const rag = await hybridSearch(body, {
    lang: sess.lang,
    prevSubject: sess.lastSubject || null,
    threshold: RAG_THR
  });

  log("info", "RAG result", {
    from,
    scope: rag.pass ? "in" : "out",
    score: rag.topScore?.toFixed(3),
    prevSubject: sess.lastSubject || null,
    resolvedQuery: rag.resolvedQuery
  });

  if (rag.pass) {
    // guardar sujeito para perguntas relacionais futuras
    sess.lastSubject = rag.subject || rag.topTitle || sess.lastSubject || null;
    sess.lastWasCorpus = true;

    const lang = sess.lang;
    const basedOn =
      lang === "pt" ? "Baseado no acervo." :
      lang === "es" ? "Basado en el acervo." :
      "Based on the corpus.";

    const fontes =
      lang === "pt" ? "Fontes:" :
      lang === "es" ? "Fuentes:" :
      "Sources:";

    const msg =
      rag.answer +
      `\n\n${basedOn}\n${fontes} ${rag.sources.join(" | ")}`;

    await sendTwilio(from, msg);
    return;
  }

  // --------- Fallback SEM recusa ---------
  const fb = await callOpenAI(body, sess.lang);
  sess.lastWasCorpus = false;
  // Não “ensina” um novo sujeito no histórico quando vier de fallback
  const tag =
    sess.lang === "pt" ? "Resposta geral (fora do acervo)." :
    sess.lang === "es" ? "Respuesta general (fuera del acervo)." :
    "General answer (outside the corpus).";

  await sendTwilio(from, `${fb}\n\n${tag}`);
});

// ---------------------- Admin opcional ------------------------------
app.get("/admin/health", (req, res) => {
  if ((req.query?.token || "") !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });
  return res.json({ ok: true, status: "ok", corpus_items: corpusCount(), now: new Date().toISOString() });
});

// -------------------------- Start ----------------------------------
app.listen(PORT, () => {
  log("info", "Server up", { port: PORT, corpus_items: corpusCount() });
});
