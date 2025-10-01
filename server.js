import express from "express";
import bodyParser from "body-parser";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";

import { CONFIG } from "./config/appConfig.js";
import { detectLang } from "./utils/langDetect.js";
import { splitForWhatsApp } from "./utils/splitMessage.js";

import { sendWhatsApp } from "./services/twilioClient.js";
import { maybeTranscribeWhatsApp } from "./services/audio.js";
import { answerWithRAG } from "./services/hybridRag.js";
import { initMemory, writeTurn, getSubject, setSubject } from "./services/memory.js";

/* Guard-rails: não deixe o processo cair sem log */
process.on("uncaughtException", (e) => console.error("[FATAL] uncaughtException:", e));
process.on("unhandledRejection",  (e) => console.error("[FATAL] unhandledRejection:", e));

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get("/", (_req, res) => res.send("True Live 5.6-MVP up"));

app.get("/admin/health", (req, res) => {
  if (req.headers["x-admin-token"] !== CONFIG.ADMIN_TOKEN) return res.json({ ok: false });

  let corpusCount = 0, aliasesCount = 0, fontesCount = 0;
  try { corpusCount = JSON.parse(fs.readFileSync("./corpus/corpus.json","utf8")).length || 0; } catch {}
  try { aliasesCount = Object.keys(JSON.parse(fs.readFileSync("./config/aliases.json","utf8"))||{}).length; } catch {}
  try {
    const f = JSON.parse(fs.readFileSync("./data/fontes.json","utf8"));
    const ws = (f?.sources?.websites || []).length;
    const rss = (f?.sources?.rss || []).length;
    const pdfs = (f?.sources?.pdfs || []).length;
    const yt = (f?.sources?.youtube || []).length;
    fontesCount = ws + rss + pdfs + yt;
  } catch {}

  res.json({
    ok: true,
    version: "5.6-MVP",
    rag_threshold: CONFIG.RAG_THRESHOLD,
    outside_corpus: !!CONFIG.ANSWER_OUTSIDE_CORPUS,
    corpus_count: corpusCount,
    aliases_count: aliasesCount,
    fontes_count: fontesCount,
    db_configured: !!CONFIG.DB_URL
  });
});

/* Helpers para pronomes/sujeito */
function needsSubject(text, lang) {
  const t = (text || "").toLowerCase();
  const pt = ["ele","ela","dele","dela","esposa","marido","onde","quando","nasceu","morreu","filhos","pais"];
  const es = ["él","ella","de él","de ella","esposa","esposo","donde","cuando","nació","murió","hijos","padres"];
  const en = ["he","she","his","her","wife","husband","where","when","born","died","children","parents"];
  const bag = lang==="pt"?pt: lang==="es"?es: en;
  return bag.some(w => t.includes(w));
}
function resolveWithSubject(text, subject, lang) {
  if (!subject) return text;
  if (!needsSubject(text, lang)) return text;
  return `${text}\n\n(Contexto: estamos falando de ${subject})`;
}

/* Webhook */
app.post(["/whatsapp", "/twilio/whatsapp"], async (req, res) => {
  const t0 = Date.now();
  res.status(200).end();

  try {
    const from = (req.body.From || "").trim();
    const userId = from || uuidv4();
    console.log(`[INBOUND] From=${from} NumMedia=${req.body.NumMedia || 0} BodyLen=${(req.body.Body||"").length}`);

    if (from) {
      try { await sendWhatsApp(from, "✅ Recebi, processando…"); }
app.post(["/whatsapp", "/twilio/whatsapp"]
    const audioText = await maybeTranscribeWhatsApp(req.body);
    const userText = (audioText || req.body.Body || "").trim();
    if (!userText) return;

    const lang = detectLang(userText);
    const lastSubject = await getSubject(userId);
    const enriched = resolveWithSubject(userText, lastSubject, lang);

    const { text, kind, score, subject } = await answerWithRAG(enriched, lang);

    await writeTurn(userId, "user", userText);
    await writeTurn(userId, "assistant", text);
    if (subject) await setSubject(userId, subject);

    for (const part of splitForWhatsApp(text)) await sendWhatsApp(from, part);

    const ms = Date.now() - t0;
    console.log(`[WHATSAPP] from=${from} lang=${lang} kind=${kind} score=${(score||0).toFixed(3)} ms=${ms} subject=${subject || lastSubject || "n/a"}`);
  } catch (e) {
    console.error("ERR /whatsapp:", e?.message || e);
  }
});

/* Teste simples de envio */
app.get("/admin/test-whatsapp", async (req, res) => {
  if ((req.query.token || "") !== CONFIG.ADMIN_TOKEN) {
    return res.json({ ok: false, error: "unauthorized" });
  }
  const to = (req.query.to || "").trim();
  if (!to) return res.json({ ok: false, error: "missing 'to' (ex.: whatsapp:+55...)" });
  try {
    const r = await sendWhatsApp(to, "Ping True Live 5.6 ✅");
    return res.json({ ok: true, sid: r.sid });
  } catch (e) {
    return res.json({ ok: false, error: e?.message || String(e) });
  }
});

/* Start sem await no topo */
async function start() {
  try { await initMemory(); }
  catch (e) { console.error("[INIT] falha initMemory (segue):", e?.message || e); }
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log("True Live 5.6-MVP listening on", PORT));
}
start();
