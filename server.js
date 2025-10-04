// server.js — True Live v2.9.3 (final)
// Fixes:
// 1) Coreferência no RAG: reforça a query com o assunto atual quando há pronomes (“sua/esposa dele/etc.”).
// 2) Assunto explícito fora do corpus: grava “Latvia/Letônia”, etc., mesmo sem RAG, e usa na próxima pergunta.
// 3) Não herda assunto antigo quando uma nova entidade/country aparece na pergunta atual.

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import pkg from "twilio";
import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { search as hybridSearch } from "./services/hybridRag.js";
import { ingestAll, tryLoadGenerated } from "./services/ingest.js";
import { maybeAnswerRealtime } from "./services/realtime.js";

const { Twilio } = pkg;
const { Client: PgClient } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "truelive2025";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const ANSWER_OUTSIDE = String(process.env.ANSWER_OUTSIDE_CORPUS || "1") === "1";
const APP_VERSION = process.env.APP_VERSION || "v2.9.3";
const RAG_THRESHOLD = Number(process.env.RAG_THRESHOLD || "0.4");
const WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || null;

const INGEST_INTERVAL_MIN = Number(process.env.INGEST_INTERVAL_MIN || "0");
const INGEST_MAX_PER_DOMAIN = Number(process.env.INGEST_MAX_PER_DOMAIN || "120");

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

// ---------- Corpus base + gerado (/corpus + /tmp) ----------
let BASE_CORPUS = [];
try {
  const corpusPath = path.join(__dirname, "corpus", "corpus.json");
  if (fs.existsSync(corpusPath)) {
    BASE_CORPUS = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  }
} catch {}
let GENERATED = tryLoadGenerated(); // /tmp/corpus.generated.json
let CORPUS_ITEMS = (BASE_CORPUS?.length || 0) + (GENERATED?.length || 0);
console.log("[INFO] Corpus (base + gerado):", CORPUS_ITEMS, "items.");

// ---------- Memória (RAM + Postgres) ----------
let pgClient = null;
async function pgInit() {
  if (!process.env.DATABASE_URL) return;
  try {
    pgClient = new PgClient({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
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

const memory = new Map(); // sender -> { subject, updatedAt }
async function getSubject(sender) {
  const m = memory.get(sender);
  if (m && Date.now() - m.updatedAt < 24 * 60 * 60 * 1000) return m.subject;
  if (pgClient) {
    try {
      const r = await pgClient.query(
        "SELECT subject FROM conversation_memory WHERE sender=$1",
        [sender]
      );
      if (r.rowCount) return r.rows[0].subject || null;
    } catch {}
  }
  return null;
}
async function setSubject(sender, subject) {
  if (!subject) return;
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

// ---------- OpenAI fallback ----------
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
  return data?.choices?.[0]?.message?.content?.trim() || "OK.";
}

// ---------- Auxiliares ----------
function detectLang(s) {
  const n = (s || "").toLowerCase();
  if (
    /[áãâéêíóôõúç]/.test(n) ||
    /\b(qual|quem|onde|como|por que|quando)\b/.test(n)
  )
    return "pt";
  if (/\b(dónde|quién|cómo|por qué|cuándo|cuál)\b/.test(n)) return "es";
  return "en";
}

// Heurística de coreferência: pergunta com pronomes/anáforas?
function isCorefQuestion(q) {
  const n = (q || "").toLowerCase();
  return /\b(ele|ela|dele|dela|seu|sua|seus|suas|lá|isso|aquilo)\b/.test(n);
}

// Detecta assunto explícito (país/entidade) mesmo fora do corpus
function explicitSubject(q) {
  const n = (q || "").toLowerCase();

  // Países e entidades comuns (pode expandir depois)
  const MAP = [
    ["letônia", "Letônia"],
    ["latvia", "Letônia"],
    ["lituânia", "Lituânia"],
    ["lithuania", "Lituânia"],
    ["israel", "Israel"],
    ["faixa de gaza", "Faixa de Gaza"],
    ["gaza", "Faixa de Gaza"],
    ["cisjordânia", "Cisjordânia"],
    ["west bank", "Cisjordânia"],
    ["jerusalém", "Jerusalém"],
    ["jerusalem", "Jerusalém"],
    ["ben-gurion", "David Ben-Gurion"],
    ["ben gurion", "David Ben-Gurion"],
    ["golda meir", "Golda Meir"],
    ["itzhak rabin", "Itzhak Rabin"],
    ["yitzhak rabin", "Itzhak Rabin"]
  ];

  for (const [k, v] of MAP) {
    if (n.includes(k)) return v;
  }
  return null;
}

async function waSend(to, text) {
  if (!twilioClient || !WHATSAPP_FROM) return;
  try {
    await twilioClient.messages.create({ from: WHATSAPP_FROM, to, body: text });
  } catch (e) {
    console.warn("[WARN] Twilio send fail:", e.message);
  }
}

// ---------- Express ----------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health check
app.get("/health", (_req, res) => res.send("ok"));
app.get("/admin/health", (req, res) => {
  const token = req.query.token;
  if (token !== ADMIN_TOKEN)
    return res.status(401).json({ status: "unauthorized" });
  res.json({
    status: "ok",
    version: APP_VERSION,
    corpus_items: CORPUS_ITEMS,
    base: BASE_CORPUS?.length || 0,
    generated: GENERATED?.length || 0,
    db: !!pgClient,
  });
});

// ---------- Ingestão (GET e POST) ----------
async function runIngestHandler(req, res) {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (token !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });

  const modeStr = req.query.mode || "rss,sitemap";
  const modes = modeStr.split(",").map((s) => s.trim());
  const max = Number(req.query.max || INGEST_MAX_PER_DOMAIN || 120);

  try {
    const r = await ingestAll({ modes, maxPerDomain: max });

    // Proteção: só atualiza o corpus gerado se houver novos itens
    if (r && r.added > 0) {
      const fresh = tryLoadGenerated();
      if (Array.isArray(fresh) && fresh.length) {
        GENERATED = fresh;
      }
    }

    CORPUS_ITEMS = (BASE_CORPUS?.length || 0) + (GENERATED?.length || 0);
    return res.json({ ok: true, result: r, corpus_items: CORPUS_ITEMS });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
app.post("/admin/ingest/run", runIngestHandler);
app.get("/admin/ingest/run", runIngestHandler);

app.get("/admin/ingest/status", (req, res) => {
  const token = req.query.token;
  if (token !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });
  res.json({
    ok: true,
    corpus_items: CORPUS_ITEMS,
    base: BASE_CORPUS.length,
    generated: GENERATED.length,
  });
});

// ---------- Webhooks WhatsApp ----------
app.post("/twilio/whatsapp", handleIncoming);
app.post("/whatsapp", handleIncoming);

async function handleIncoming(req, res) {
  const body = req.body || {};
  const msg = (body.Body || body.text || "").trim();
  const from = body.From || body.from || "";

  const lang = detectLang(msg);
  if (from && twilioClient)
    waSend(
      from,
      lang === "pt"
        ? "✅ Recebido, pensando..."
        : lang === "es"
        ? "✅ Recibido, pensando..."
        : "✅ Received, thinking..."
    );
  res.sendStatus(200);

  try {
    // 0) Atualizar assunto explícito (mesmo fora do corpus)
    const explicit = explicitSubject(msg);
    if (explicit) {
      await setSubject(from, explicit);
    }

    // 1) Atualidade (feeds confiáveis)
    try {
      const live = await maybeAnswerRealtime(msg, lang);
      if (live && live.ok) {
        const tail =
          String(process.env.ANSWER_OUTSIDE_CORPUS || "1") === "1"
            ? lang === "pt"
              ? "\n\n(Atualidade via fontes externas)"
              : lang === "es"
              ? "\n\n(Actualidad vía fuentes externas)"
              : "\n\n(Live via external sources)"
            : "";
        if (from) await waSend(from, live.text + tail);
        return;
      }
    } catch {}

    // 2) RAG (corpus) — com coreferência
    const prev = await getSubject(from);
    const useCoref = isCorefQuestion(msg);
    const ragQuery =
      // se houver entidade explícita agora, não poluo a query com assunto antigo
      explicit ? msg : (useCoref && prev ? `${msg} (referente a: ${prev})` : msg);

    const rag = await hybridSearch(ragQuery, { threshold: RAG_THRESHOLD });

    if (rag?.pass) {
      // Se o RAG identificou um subject, atualiza; senão, mantém o explicit/prev
      if (rag.subject) {
        await setSubject(from, rag.subject);
      } else if (explicit) {
        await setSubject(from, explicit);
      }

      const fontes = (rag.sources || [])
        .map((s) => s.title || s.id)
        .filter(Boolean)
        .slice(0, 6)
        .join(" | ");
      let answer = (rag.snippets || []).join(" ");
      const tag =
        lang === "pt"
          ? "Baseado no acervo."
          : lang === "es"
          ? "Basado en el acervo."
          : "Based on the corpus.";
      answer = answer ? `${answer}\n\n${tag}` : tag;
      if (fontes) {
        const fl =
          lang === "pt"
            ? `Fontes: ${fontes}`
            : lang === "es"
            ? `Fuentes: ${fontes}`
            : `Sources: ${fontes}`;
        answer += `\n${fl}`;
      }
      if (from) await waSend(from, answer);
      console.log("[INFO] RAG result", {
        scope: "in",
        score: rag.score,
        resolvedQuery: ragQuery,
      });
      return;
    }

    // 3) Fallback (sempre responde)
    const subjectForFb = explicit || (useCoref ? await getSubject(from) : null);
    const prefix =
      lang === "pt"
        ? subjectForFb
          ? `Assunto atual: ${subjectForFb}. `
          : ""
        : lang === "es"
        ? subjectForFb
          ? `Tema actual: ${subjectForFb}. `
          : ""
        : subjectForFb
        ? `Current subject: ${subjectForFb}. `
        : "";

    const fb = await openaiAnswer(`${prefix}${msg}`, lang);
    const tail = ANSWER_OUTSIDE
      ? lang === "pt"
        ? "\n\nResposta geral (fora do acervo)."
        : lang === "es"
        ? "\n\nRespuesta general (fuera del acervo)."
        : "\n\nGeneral answer (outside the corpus)."
      : "";
    if (from) await waSend(from, fb + tail);
    console.log("[INFO] RAG result", {
      scope: "out",
      score: rag?.score ?? 0,
      resolvedQuery: ragQuery,
    });
  } catch (e) {
    console.error("[ERROR] handler:", e);
    if (from)
      await waSend(
        from,
        lang === "pt"
          ? "Erro técnico. Tente novamente."
          : lang === "es"
          ? "Error técnico. Intenta de nuevo."
          : "Technical error. Please try again."
      );
  }
}

// ---------- Ingestão automática opcional ----------
if (INGEST_INTERVAL_MIN > 0) {
  const ms = INGEST_INTERVAL_MIN * 60 * 1000;
  setInterval(async () => {
    try {
      console.log("[INFO] Auto-ingest tick...");
      const r = await ingestAll({ modes: ["rss"], maxPerDomain: INGEST_MAX_PER_DOMAIN });
      if (r && r.added > 0) {
        const fresh = tryLoadGenerated();
        if (Array.isArray(fresh) && fresh.length) GENERATED = fresh;
      }
      CORPUS_ITEMS = (BASE_CORPUS?.length || 0) + (GENERATED?.length || 0);
      console.log("[INFO] Auto-ingest done. corpus_items:", CORPUS_ITEMS);
    } catch (e) {
      console.warn("[WARN] Auto-ingest failed:", e.message);
    }
  }, ms);
}

// ---------- Start ----------
app.listen(PORT, () => {
  console.log("[INFO] Server up", { port: String(PORT) });
});
