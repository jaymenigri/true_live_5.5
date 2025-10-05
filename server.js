// server.js — True Live (rollback estável + Postgres obrigatório)

import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// 0) Configs básicas
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "truelive2025";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
function log(level, ...args) {
  const order = { error: 0, warn: 1, info: 2, debug: 3 };
  if (order[level] <= order[LOG_LEVEL]) console.log(`[${level.toUpperCase()}]`, ...args);
}

// 1) Logger HTTP simples
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => log("info", "[REQ]", req.method, req.originalUrl, "->", res.statusCode, `(${Date.now()-t0}ms)`));
  next();
});

// 2) Carrega corpus (aceita ./corpus/corpus.json OU ./corpus.json)
function readJsonSafe(p) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    log("warn", "Falha ao ler JSON:", p, e.message);
  }
  return null;
}
const corpusPath1 = path.join(__dirname, "corpus", "corpus.json");
const corpusPath2 = path.join(__dirname, "corpus.json");
const corpusItems = readJsonSafe(corpusPath1) || readJsonSafe(corpusPath2) || [];
log("info", `Corpus loaded: ${corpusItems.length} items.`);

// 3) Twilio (sem 'timeout' no payload)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || "";
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
  throw new Error("Twilio credenciais ausentes. Este rollback exige envio via WhatsApp funcional.");
}
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const originalCreate = twilioClient.messages.create;
twilioClient.messages.create = async (args) => {
  if (args && Object.prototype.hasOwnProperty.call(args, "timeout")) {
    throw new Error("[Guard] Campo inválido no Twilio payload: 'timeout'");
  }
  return originalCreate.call(twilioClient.messages, args);
};

async function waSend(to, body) {
  if (!to || !to.startsWith("whatsapp:")) {
    log("warn", "Número 'to' inválido:", to);
    return { ok: false, reason: "invalid_to" };
  }
  const sendPromise = twilioClient.messages.create({ from: TWILIO_WHATSAPP_FROM, to, body });
  const result = await Promise.race([
    sendPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("twilio_timeout")), 15000)),
  ]);
  if (result && result.sid) return { ok: true, sid: result.sid };
  return { ok: false, reason: "unknown" };
}

// 4) RAG (import robusto)
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

// 5) Contexto **OBRIGATÓRIO** em Postgres
import { loadContext, saveContext } from "./services/context.js";
log("info", "Contexto: Postgres habilitado (obrigatório).");

// 6) Admin health
app.get("/admin/health", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(403).json({ error: "forbidden" });
  return res.json({
    status: "ok",
    version: "v2.10.6-pg",
    corpus_items: corpusItems.length,
    db: true
  });
});

// 7) Webhook WhatsApp (ACK imediato + envio assíncrono)
app.post("/twilio/whatsapp", async (req, res) => {
  const from = (req.body && req.body.From) || "";
  const text = (req.body && req.body.Body ? String(req.body.Body) : "").trim();
  log("info", "[IN]", from, "->", text || "(vazio)");

  // ACK imediato
  res.sendStatus(200);

  try {
    const ctx = await loadContext(from);
    const threshold = Number(process.env.RAG_THRESHOLD || "0.5");

    const result = await doSearch(text, {
      corpus: corpusItems,
      context: ctx,
      threshold
    });

    log("info", "[RAG]", {
      score: result?.score?.toFixed ? result.score.toFixed(3) : String(result?.score ?? "?"),
      pass: !!result?.pass,
      subject: result?.subject || null,
      resolvedQuery: result?.resolvedQuery || text
    });

    if (result?.subject) {
      await saveContext(from, result.subject);
    }

    const reply = (result && result.reply) ? String(result.reply).trim() : "Desculpe, não encontrei nada agora.";
    log("info", "[SEND] reply:", reply.slice(0, 140));

    const sent = await waSend(from, reply);
    if (!sent.ok) log("warn", "[SEND] WhatsApp não enviado:", sent.reason || "desconhecido");
  } catch (err) {
    log("error", "/twilio/whatsapp falhou:", err?.message || err);
  }
});

// 8) Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log("info", `Server up { port: ${PORT}, corpus_items: ${corpusItems.length} }`);
});
