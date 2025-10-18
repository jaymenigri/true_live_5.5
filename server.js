import express from "express";
import { search as hybridSearch, reloadCorpus } from "./services/hybridRag.js";
import { ingestAll, tryLoadGenerated } from "./services/ingest.js";
import * as ctx from "./services/context.js";
import { complete } from "./services/openaiClient.js";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "truelive2025";
const RAG_THRESHOLD = Number(process.env.RAG_THRESHOLD || 0.4);
const ANSWER_OUTSIDE_CORPUS = process.env.ANSWER_OUTSIDE_CORPUS !== "false";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || "";

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log("[INFO] Twilio client pronto.");
  } catch (e) {
    console.warn("[WARN] Twilio não inicializado:", e?.message);
  }
}

await ctx.init();
const generated = tryLoadGenerated();
const corpusCount = reloadCorpus(generated);
console.log("[INFO] Corpus loaded:", corpusCount, "items.");

async function waSend(to, body) {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM || !to) return false;
  try {
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to,
      body
    });
    return true;
  } catch (e) {
    console.error("[ERROR] Twilio send:", e?.message || e);
    return false;
  }
}

function safeLang(s) {
  return /[\u0400-\u04FF]/.test(s) ? "ru" : /[a-z]/i.test(s) ? "pt" : "pt";
}

app.get("/admin/health", (req, res) => {
  const token = req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
  return res.json({
    status: "ok",
    version: "v2.10.7-pg-stable",
    corpus_items: corpusCount,
    db: Boolean(process.env.DATABASE_URL)
  });
});

app.get("/admin/ingest/run", async (req, res) => {
  const token = req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
  const mode = req.query.mode || "rss,sitemap";
  const max = Number(req.query.max || 80);
  const result = await ingestAll({ mode, max });
  const newCount = reloadCorpus(tryLoadGenerated());
  return res.json({ ok: true, result, corpus_items: newCount });
});

app.get("/admin/ingest/status", (req, res) => {
  const token = req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
  const gen = tryLoadGenerated();
  return res.json({ ok:true, corpus_items: reloadCorpus(gen), base: undefined, generated: gen.length });
});

app.post(["/twilio/whatsapp","/whatsapp"], async (req, res) => {
  const from = req.body.From || req.body.from || "";
  const body = (req.body.Body || req.body.body || "").trim();
  if (!body) return res.sendStatus(200);

  // ACK rápido
  res.status(200).send("OK");

  const relational = /esposa|marido|filh|mae|mãe|pai|onde nasceu|quando nasceu|onde fica|capital/i.test(body);
  let subject = await ctx.getSubject(from);
  let query = body;
  if (relational && subject) query = `${body} — contexto: ${subject}`;

  const rag = hybridSearch(query, { threshold: RAG_THRESHOLD });
  console.log("[INFO] RAG", { score: rag.score.toFixed(3), pass: rag.pass, subject, resolvedQuery: query });

  let reply = "";
  if (rag.pass) {
    const bullets = rag.top.map(r => `• ${r.snippet}`).join("\n");
    const fontes = rag.top.map(r => r.title).slice(0,3).join(" | ");
    reply = `${bullets}\n\nBaseado no acervo.\nFontes: ${fontes}`;
    const main = rag.top[0]?.title;
    if (from && main) await ctx.setSubject(from, main.replace(/ — .*$/, ""));
  } else {
    try {
      const sys = "Você é o True Live. Responda de forma clara, respeitosa e factual. Se o tema for Israel/judaísmo/antissemitismo, responda normalmente. Caso seja fora do escopo, responda assim mesmo, mas indique: 'Resposta geral (fora do acervo).'";
      const ai = await complete([
        { role: "system", content: sys },
        { role: "user", content: body }
      ]);
      reply = ai ? ai : "Desculpe, não encontrei.";
      if (ANSWER_OUTSIDE_CORPUS && !rag.pass) reply += "\n\nResposta geral (fora do acervo).";
    } catch (e) {
      reply = "Não consegui gerar a resposta agora.";
    }
  }

  await waSend(from, reply);
});

app.get("/", (_req, res) => res.send("True Live API"));
app.get("/health", (_req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("[INFO] Server up", { port: PORT, corpus_items: corpusCount }));
