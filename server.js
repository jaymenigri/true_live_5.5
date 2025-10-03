// server.js — True Live v2.7.0 (RAG + Fallback + Memória + Health + Twilio duplo endpoint)

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import pkg from "twilio";
import { search as hybridSearch } from "./services/hybridRag.js";
import { fileURLToPath } from "url";
import path from "path";
import pg from "pg";

const { Client: PgClient } = pg;
const { Twilio } = pkg;

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "truelive2025";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const ANSWER_OUTSIDE = String(process.env.ANSWER_OUTSIDE_CORPUS || "1") === "1";
const APP_VERSION = process.env.APP_VERSION || "v2.7.0";

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

const WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || null;

// -------- memória em RAM + opcional Postgres --------
const memory = new Map(); // key: from -> { subject, updatedAt }

let pgClient = null;
async function pgInit() {
  if (!process.env.DATABASE_URL) return;
  try {
    pgClient = new PgClient({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pgClient.connect();
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS conversation_memory (
        sender TEXT PRIMARY KEY,
        subject TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    console.log("[INFO] Postgres conectado.");
  } catch (e) {
    console.warn("[WARN] Postgres indisponível:", e.message);
    pgClient = null;
  }
}
await pgInit();

async function getSubject(sender) {
  // 1) RAM
  const m = memory.get(sender);
  if (m && Date.now() - m.updatedAt < 24 * 60 * 60 * 1000) return m.subject;

  // 2) PG
  if (pgClient) {
    try {
      const r = await pgClient.query("SELECT subject, updated_at FROM conversation_memory WHERE sender=$1", [sender]);
      if (r.rowCount) return r.rows[0].subject || null;
    } catch {}
  }
  return null;
}

async function setSubject(sender, subject) {
  memory.set(sender, { subject, updatedAt: Date.now() });
  if (pgClient) {
    try {
      await pgClient.query(
        `INSERT INTO conversation_memory(sender, subject, updated_at)
         VALUES($1,$2, now())
         ON CONFLICT (sender) DO UPDATE SET subject=$2, updated_at=now()`,
        [sender, subject]
      );
    } catch {}
  }
}

// -------- OpenAI fallback --------
async function openaiAnswer(prompt, lang) {
  const sys =
    lang === "pt"
      ? "Você é um assistente claro e direto. Responda em português do Brasil."
      : lang === "es"
      ? "Eres un asistente claro y directo. Responde en español."
      : "You are a clear and direct assistant. Reply in English.";

  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: prompt },
    ],
    temperature: 0.4,
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  const txt = data?.choices?.[0]?.message?.content?.trim() || "OK.";
  return txt;
}

function detectLang(s) {
  const n = (s || "").toLowerCase();
  if (/[áãâéêíóôõúç]/.test(n) || / qual | quem | onde | como | por que /.test(` ${n} `)) return "pt";
  if (/\b(dónde|quién|cómo|por qué|cuál)\b/.test(n)) return "es";
  return "en";
}

// -------- WhatsApp helpers --------
async function waSend(to, text) {
  if (!twilioClient || !WHATSAPP_FROM) return;
  try {
    await twilioClient.messages.create({
      from: WHATSAPP_FROM,
      to,
      body: text,
    });
  } catch (e) {
    console.warn("[WARN] Twilio send fail:", e.message);
  }
}

function ackText(lang) {
  return lang === "pt"
    ? "✅ Recebido, pensando..."
    : lang === "es"
    ? "✅ Recibido, pensando..."
    : "✅ Received, thinking...";
}

// -------- app --------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// health
app.get("/admin/health", (_req, res) => {
  const ok = { status: "ok", version: APP_VERSION };
  // Não temos acesso ao total do corpus dentro deste arquivo;
  // o hybridRag já loga no boot. Exponho um campo “corpus_items” best-effort:
  ok.corpus_items = Number(process.env.CORPUS_ITEMS || 0) || undefined;
  ok.db = !!pgClient;
  res.json(ok);
});

// rota compat
app.get("/health", (_req, res) => res.send("ok"));

// -------- handler principal --------
async function handleIncoming(req, res) {
  // Twilio URL-encoded: Body, From
  const body = req.body || {};
  const msg = body.Body || body.text || "";
  const from = body.From || body.from || "";

  const lang = detectLang(msg);

  // ACK imediato (para UX no WhatsApp)
  if (from && twilioClient) waSend(from, ackText(lang));
  res.sendStatus(200);

  try {
    // assunto anterior (para perguntas relacionais)
    const prev = await getSubject(from);

    const rag = await hybridSearch(msg, { threshold: process.env.RAG_THRESHOLD });
    const inScope = rag.pass;

    if (inScope) {
      // atualizar assunto
      if (rag.subject) await setSubject(from, rag.subject);

      // montar resposta baseada no acervo
      let answer = "";
      if (rag.snippets?.length) answer += rag.snippets.join(" ");
      const fontes = (rag.sources || [])
        .map((s) => s.title || s.id)
        .filter(Boolean)
        .slice(0, 6)
        .join(" | ");

      const header =
        lang === "pt"
          ? "Baseado no acervo."
          : lang === "es"
          ? "Basado en el acervo."
          : "Based on the corpus.";

      if (answer) answer = `${answer}\n\n${header}`;
      if (fontes) {
        const fLine =
          lang === "pt" ? `Fontes: ${fontes}` : lang === "es" ? `Fuentes: ${fontes}` : `Sources: ${fontes}`;
        answer += `\n${fLine}`;
      }

      if (from && answer) await waSend(from, answer);
      return;
    }

    // -------- Fallback garantido --------
    const subjectNote = prev ? (lang === "pt" ? `Assunto atual: ${prev}. ` : `Current subject: ${prev}. `) : "";
    const fbPrompt =
      (lang === "pt"
        ? `${subjectNote}Responda de forma clara e factual.`
        : lang === "es"
        ? `${subjectNote}Responde de forma clara y factual.`
        : `${subjectNote}Answer clearly and factually.`) + `\n\nPergunta: ${msg}`;

    const fb = await openaiAnswer(fbPrompt, lang);
    const tail =
      ANSWER_OUTSIDE &&
      (lang === "pt"
        ? "\n\nResposta geral (fora do acervo)."
        : lang === "es"
        ? "\n\nRespuesta general (fuera del acervo)."
        : "\n\nGeneral answer (outside the corpus).");

    if (from) await waSend(from, fb + (tail || ""));
  } catch (e) {
    console.error("[ERROR] handler:", e);
    if (from) {
      const txt =
        lang === "pt"
          ? "Desculpe, tive um erro técnico. Tente novamente."
          : lang === "es"
          ? "Lo siento, tuve un error técnico. Intenta de nuevo."
          : "Sorry, I hit a technical error. Please try again.";
      await waSend(from, txt + (ANSWER_OUTSIDE ? "\n\nResposta geral (fora do acervo)." : ""));
    }
  }
}

// Twilio webhook (oficial) + alias simples
app.post("/twilio/whatsapp", handleIncoming);
app.post("/whatsapp", handleIncoming);

// -------- start --------
app.listen(PORT, () => {
  console.log("[INFO] Server up", { port: String(PORT) });
});
