// server.js — True Live v2.10.8 (Heroku final)
import express from "express";
import bodyParser from "body-parser";
import morgan from "morgan";
import fetch from "node-fetch";
import OpenAI from "openai";
import twilio from "twilio";

import { search as hybridSearch, loadAll as loadCorpus } from "./services/rag.js";
import { ingestAll } from "./services/ingest.js";
import { init as ctxInit, get as ctxGet, remember as ctxRemember } from "./services/context.js";
import { pgPool } from "./db.js";
import { simpleAnswer } from "./embeddingUtils.js";

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "truelive2025";
const RAG_THRESHOLD = Number(process.env.RAG_THRESHOLD || "0.5");
const ANSWER_OUTSIDE_CORPUS = process.env.ANSWER_OUTSIDE_CORPUS !== "false";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(morgan(":method :url :status :response-time ms"));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log("[INFO] Twilio client pronto.");
}

const pool = pgPool();
let dbReady = false;
if (pool) {
  try { await ctxInit(); dbReady = true; }
  catch (e) { console.log("[WARN] Contexto: falha ao iniciar Postgres:", e.message); }
} else {
  console.log("[WARN] Contexto: usando memória local (sem Postgres).");
}

const ALL = loadCorpus();
console.log(`[INFO] Corpus loaded: ${ALL.length} items.`);

function ok(res, payload){ return res.json(payload); }
function unauthorized(res){ return res.status(401).json({ ok:false, error:"unauthorized" }); }

app.get("/admin/health", (req, res) => {
  if ((req.query.token||"") !== ADMIN_TOKEN) return unauthorized(res);
  ok(res, { status:"ok", version:"v2.10.8-heroku-final", corpus_items: ALL.length, db: !!dbReady });
});

app.get("/admin/ingest/run", async (req,res) => {
  if ((req.query.token||"") !== ADMIN_TOKEN) return unauthorized(res);
  const max = Number(req.query.max||"50");
  const out = await ingestAll({ max });
  ok(res, { ok:true, result: out, corpus_items: ALL.length + out.added });
});

app.get("/admin/ingest/status", (req,res) => {
  if ((req.query.token||"") !== ADMIN_TOKEN) return unauthorized(res);
  ok(res, { ok:true, corpus_items: ALL.length });
});

app.post("/twilio/whatsapp", async (req, res) => {
  res.status(200).send("OK");
  try {
    const from = req.body.From || req.body.from;
    const body = (req.body.Body || req.body.body || "").trim();
    if (!from || !body) return;

    const prev = await ctxGet(from);
    const subject = prev?.subject || null;
    const resolvedQuery = subject && !/^(quem|o que|onde|quando|qual|quais|como)/i.test(body)
      ? `${body} — assunto atual: ${subject}` : body;

    const rag = hybridSearch(resolvedQuery, { threshold: RAG_THRESHOLD, topK: 3 });
    console.log("[INFO] RAG", { score: rag.best?.score?.toFixed?.(3) || "0.000", pass: rag.pass, subject, resolvedQuery });

    let reply, scope;
    if (rag.pass && rag.best) {
      reply = `${rag.best.snippet}\n\nBaseado no acervo.\nFontes: ${"${rag.top.map(t=>t.title).join(' | ')}"}`;
      scope = "in";
      await ctxRemember(from, rag.best.title, { at: Date.now() });
    } else {
      const prompt = `Pergunta: ${"${body}"}\n\nSe souber, responda de forma direta e curta. Não invente referência.`;
      const out = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: [
          { role: "system", content: "Você responde em português (Brasil) de forma clara e direta."},
          { role: "user", content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 350,
      });
      reply = out.choices[0].message.content.trim();
      if (ANSWER_OUTSIDE_CORPUS) reply += `\n\nResposta geral (fora do acervo).`;
      scope = "out";
    }

    if (twilioClient && process.env.TWILIO_MESSAGING_SERVICE_SID) {
      await twilioClient.messages.create({
        to: from,
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
        body: reply
      });
    }
  } catch (e) {
    console.log("[ERROR] /twilio/whatsapp:", e.message || e);
  }
});

app.post("/whatsapp", express.json(), async (req,res)=>{
  try{
    const from = req.body.from || "test";
    const body = (req.body.text||req.body.body||"").trim();
    if (!body) return ok(res, { ok:false, error:"empty" });

    const prev = await ctxGet(from);
    const subject = prev?.subject || null;
    const resolvedQuery = subject && !/^(quem|o que|onde|quando|qual|quais|como)/i.test(body)
      ? `${body} — assunto atual: ${subject}` : body;

    const rag = hybridSearch(resolvedQuery, { threshold: RAG_THRESHOLD, topK: 3 });
    let reply, scope;
    if (rag.pass && rag.best) {
      reply = `${rag.best.snippet}\n\nBaseado no acervo.\nFontes: ${"${rag.top.map(t=>t.title).join(' | ')}"}`;
      scope = "in";
      await ctxRemember(from, rag.best.title, { at: Date.now() });
    } else {
      const ans = await (await import("./embeddingUtils.js")).simpleAnswer(body);
      reply = ans + (ANSWER_OUTSIDE_CORPUS ? `\n\nResposta geral (fora do acervo).` : "");
      scope = "out";
    }
    ok(res, { ok:true, reply, scope, rag });
  } catch(e){
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

app.get("/", (_req,res)=> res.send("True Live — OK"));
app.get("/health", (_req,res)=> res.send("ok"));

app.listen(process.env.PORT || 3000, ()=>{
  console.log("[INFO] Server up", { port: process.env.PORT || 3000, corpus_items: loadCorpus().length });
});