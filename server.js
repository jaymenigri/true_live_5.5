// server.js — True Live v2.10.6 (estável, sem morgan)

import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// -------------------------------------------------
// 1) Express básico + logger embutido
// -------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "truelive2025";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

function log(level, ...args) {
  const order = { error: 0, warn: 1, info: 2, debug: 3 };
  if (order[level] <= order[LOG_LEVEL]) {
    console.log(`[${level.toUpperCase()}]`, ...args);
  }
}

// Logger HTTP simples (substitui morgan)
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    log("info", "[REQ]", req.method, req.originalUrl, "->", res.statusCode, `(${Date.now() - t0}ms)`);
  });
  next();
});

// -------------------------------------------------
/** 2) Corpus: tenta ./corpus/corpus.json, depois ./corpus.json */
// -------------------------------------------------
function readJsonSafe(p) {
  try {
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, "utf8");
      return JSON.parse(txt);
    }
  } catch (e) {
    log("warn", "Falha ao ler JSON:", p, e.message);
  }
  return null;
}

let corpusItems = [];
const corpusPath1 = path.join(__dirname, "corpus", "corpus.json");
const corpusPath2 = path.join(__dirname, "corpus.json");
corpusItems = readJsonSafe(corpusPath1) || readJsonSafe(corpusPath2) || [];
log("info", `Corpus loaded: ${corpusItems.length} items.`);

// -------------------------------------------------
// 3) Twilio: cliente + guardião (bloqueia campo inválido)
// -------------------------------------------------
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || "";

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  const originalCreate = twilioClient.messages.create;
  twilioClient.messages.create = async (args) => {
    // Guardião: Twilio NÃO aceita 'timeout' no payload
    if (args && Object.prototype.hasOwnProperty.call(args, "timeout")) {
      throw new Error("[Guard] Campo inválido no Twilio payload: 'timeout'");
    }
    return originalCreate.call(twilioClient.messages, args);
  };
  log("info", "Twilio client pronto.");
} else {
  log("warn", "Twilio DESABILITADO (credenciais ausentes).");
}

// Envio WhatsApp com timeout externo
async function waSend(to, body) {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) {
    log("warn", "Twilio não configurado; pular envio WhatsApp.");
    return { ok: false, reason: "twilio_not_configured" };
  }
  if (!to || !to.startsWith("whatsapp:")) {
    log("warn", "Número 'to' inválido para WhatsApp:", to);
    return { ok: false, reason: "invalid_to" };
  }

  const sendPromise = twilioClient.messages.create({ from: TWILIO_WHATSAPP_FROM, to, body });
  const result = await Promise.race([
    sendPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("twilio_timeout")), 15000)),
  ]);

  if (result && result.sid) {
    log("debug", "Twilio send OK", { sid: result.sid });
    return { ok: true, sid: result.sid };
  }
  return { ok: false, reason: "unknown" };
}

// -------------------------------------------------
// 4) RAG: import robusto (hybridSearch | search | default)
// -------------------------------------------------
let doSearch = null;
try {
  const rag = await import("./services/hybridRag.js");
  doSearch = rag.hybridSearch || rag.search || rag.default || null;
} catch (e) {
  log("error", "Falha importando services/hybridRag.js:", e.message);
}
if (!doSearch) {
  throw new Error("hybridRag.js não expõe search/hybridSearch/default.");
}

// -------------------------------------------------
// 5) Contexto: tenta Postgres (services/context.js), senão memória
// -------------------------------------------------
let loadContext = async () => ({});
let saveContext = async () => {};
let HAS_DB = false;

try {
  const ctx = await import("./services/context.js");
  loadContext = ctx.loadContext || (ctx.default && ctx.default.loadContext) || loadContext;
  saveContext = ctx.saveContext || (ctx.default && ctx.default.saveContext) || saveContext;
  HAS_DB = true;
  log("info", "Contexto: Postgres habilitado.");
} catch {
  const mem = new Map();
  loadContext = async (key) => mem.get(key) || {};
  saveContext = async (key, subject) => mem.set(key, { subject, ts: Date.now() });
  HAS_DB = false;
  log("warn", "Contexto: usando memória local (sem Postgres).");
}

// -------------------------------------------------
// 6) Admin: /admin/health
// -------------------------------------------------
app.get("/admin/health", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "forbidden" });
  }
  return res.json({
    status: "ok",
    version: "v2.10.6",
    corpus_items: corpusItems.length,
    db: HAS_DB,
  });
});

// -------------------------------------------------
// 7) Webhook WhatsApp (ACK imediato; envio assíncrono)
// -------------------------------------------------
app.post("/twilio/whatsapp", async (req, res) => {
  const from = (req.body && req.body.From) || "";
  const text = (req.body && req.body.Body ? String(req.body.Body) : "").trim();

  log("info", "[IN]", from, "->", text || "(vazio)");

  // ACK imediato pro Twilio/WhatsApp
  res.sendStatus(200);

  try {
    const ctx = await loadContext(from);
    const threshold = Number(process.env.RAG_THRESHOLD || "0.5");

    const result = await doSearch(text, {
      corpus: corpusItems,
      context: ctx,
      threshold,
    });

    // Esperado: { reply, scope, subject, score, pass, resolvedQuery, sources }
    log("info", "[RAG]", {
      score: result?.score?.toFixed ? result.score.toFixed(3) : String(result?.score ?? "?"),
      pass: !!result?.pass,
      subject: result?.subject || null,
      resolvedQuery: result?.resolvedQuery || text,
    });

    if (result?.subject) {
      await saveContext(from, result.subject);
    }

    const reply = (result && result.reply) ? String(result.reply).trim() : "";
    const finalReply = reply || "Desculpe, não encontrei nada agora.";

    log("info", "[SEND] reply:", finalReply.slice(0, 140));

    const sent = await waSend(from, finalReply);
    if (!sent.ok) {
      log("warn", "[SEND] WhatsApp não enviado:", sent.reason || "desconhecido");
    }
  } catch (err) {
    log("error", "/twilio/whatsapp falhou:", err?.message || err);
  }
});

// -------------------------------------------------
// 8) Start
// -------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log("info", `Server up { port: ${PORT}, corpus_items: ${corpusItems.length} }`);
});
