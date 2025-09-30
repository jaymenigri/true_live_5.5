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
import { initMemory, readHistory, writeTurn, getSubject, setSubject } from "./services/memory.js";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

await initMemory();

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
  res.json({ ok: true, version: "5.6-MVP", rag_threshold: CONFIG.RAG_THRESHOLD, outside_corpus: !!CONFIG.ANSWER_OUTSIDE_CORPUS, corpus_count: corpusCount, aliases_count: aliasesCount, fontes_count: fontesCount, db_configured: !!CONFIG.DB_URL });
});

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

app.post(["/whatsapp", "/twilio/whatsapp"], async (req, res) => {
  const t0 = Date.now();
  res.status(200).end();
  try {
    const from = (req.body.From || "").trim();
    const userId = from || uuidv4();
    if (from) { try { await sendWhatsApp(from, "✅ Recebi, processando…"); } catch {} }
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
  } catch (e) { try { console.error("ERR /whatsapp:", e?.message || e); } catch {} }
});

app.get("/", (_req, res) => res.send("True Live 5.6-MVP up"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("True Live 5.6-MVP listening on", PORT));
