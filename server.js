import express from "express";
import { sendWhatsApp } from "./services/twilioClient.js";
import { detectLang } from "./utils/lang.js";
import { chunkMessage } from "./utils/chunk.js";
import { generateResponseWithHistory, transcribeAudio } from "./services/openaiClient.js";
import { fetchTwilioMedia } from "./services/audio.js";
import { classifyScope, retrieveHybrid, ingestRSS, ingestSitemap } from "./services/hybridRag.js";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const { ADMIN_TOKEN, TWILIO_WHATSAPP_FROM, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;

const SESSIONS = new Map();
function now(){ return Date.now(); }
function ymd(){ return new Date().toISOString().slice(0,10); }
function prune(){ const DAY=86400000, cut=now()-DAY; for (const [k,v] of SESSIONS) if ((v.last||0)<cut) SESSIONS.delete(k); }
function histGet(k){ prune(); return SESSIONS.get(k)?.msgs || []; }
function histPush(k,r,c){ const s=SESSIONS.get(k)||{msgs:[],last:0,countDay:{day:ymd(),count:0}}; s.msgs=s.msgs.concat([{role:r,content:c}]).slice(-10); s.last=now(); SESSIONS.set(k,s); }
function incCount(k){ const s=SESSIONS.get(k)||{msgs:[],last:0,countDay:{day:ymd(),count:0}}; const d=ymd(); if(s.countDay.day!==d) s.countDay={day:d,count:0}; s.countDay.count++; s.last=now(); SESSIONS.set(k,s); return s.countDay.count; }
const DAILY_CAP = 150;

function detectRecencyIntent(q){ const t=(q||"").toLowerCase(); return /(hoje|agora|últimas|últimos|recentes|today|now|latest|recent)/.test(t); }
function systemPrompt(lang, scope) {
  const intro = lang==="es"?"Eres True Live, un asistente de IA en WhatsApp que responde de forma factual sobre Israel, judaísmo, sionismo y antisemitismo."
    : lang==="en"?"You are True Live, a WhatsApp AI assistant that answers factually about Israel, Judaism, Zionism, and antisemitism."
    : lang==="he"?"אתה True Live, עוזר AI ב-WhatsApp העונה בצורה עובדתית על ישראל, יהדות, ציונות ואנטישמיות."
    : "Você é o True Live, um assistente de IA no WhatsApp que responde de forma factual sobre Israel, judaísmo, sionismo e antissemitismo.";
  const base = `${intro}
- Sempre que possível, baseie-se nas fontes confiáveis do acervo (citando nomes/títulos e datas quando houver no contexto).
- Se estiver fora de escopo ou sem contexto suficiente, responda claramente e marque como fora do acervo.
- Responda no mesmo idioma do usuário (${lang}).
- Seja direto, preciso e educado; foque em fatos.`;
  return base + (scope==="in"?"\n(Pergunta classificada como DENTRO do domínio.)":"\n(Pergunta classificada como FORA/INDEFINIDA.)");
}

app.get("/", (_req, res) => res.send("True Live v2.1 running."));
app.get("/admin/health", (req, res) => { const token=req.headers["x-admin-token"]||req.query.token; if (token!==ADMIN_TOKEN) return res.status(401).json({ok:false,error:"unauthorized"}); res.json({ ok:true, from: TWILIO_WHATSAPP_FROM||null, sessions: SESSIONS.size }); });

// rota atual de ingestão (só POST)
app.post("/admin/ingest/run", async (req, res) => {
  try {
    const token = req.headers["x-admin-token"] || req.query.token;
    if (token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const mode = (req.query.mode || "rss,sitemap").split(",").map(s => s.trim());
    const out = {};
    if (mode.includes("rss")) out.rss = await ingestRSS();
    if (mode.includes("sitemap")) out.sitemap = await ingestSitemap();
    return res.json({ ok: true, result: out });
  } catch (e) {
    console.error("ingest/run error:", e);
    return res.status(500).json({ ok: false, error: "ingest-failed" });
  }
});

app.get("/health", (_req, res) => res.send("ok"));

app.post("/twilio/whatsapp", async (req, res) => {
  try {
    const from=(req.body.From||"").trim();
    const body=(req.body.Body||"").trim();
    const numMedia=Number(req.body.NumMedia||0);
    const mediaType=(req.body.MediaContentType0||"").toLowerCase();
    const lang=detectLang(body);
    const scope=classifyScope(body);

    const used=incCount(from);
    if(used>DAILY_CAP){ const msg=lang==="es"?"⛔ Límite diario alcanzado. Vuelve mañana.":lang==="en"?"⛔ Daily limit reached. Please try again tomorrow.":lang==="he"?"⛔ הגעת למכסה היומית. נסה מחר.":"⛔ Limite diário atingido. Tente novamente amanhã."; return res.set("Content-Type","application/xml").status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`); }

    const ack = lang==="es"?"✅ Recibido, pensando…" : lang==="en"?"✅ Received, thinking…" : lang==="he"?"✅ קיבלתי, חושב…" : "✅ Recebido, pensando…";
    res.set("Content-Type","application/xml").status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${ack}</Message></Response>`);

    let userText=body;
    if(!userText && numMedia>0 && req.body.MediaUrl0){
      try { const buf=await fetchTwilioMedia(req.body.MediaUrl0, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN); const txt=await transcribeAudio(buf, { basename:"voice", contentType: mediaType || "audio/ogg" }); if(txt) userText=txt; }
      catch(e){ console.error("Audio transcription failed:", e?.message||e); userText=lang==="es"?"(No pude transcribir el audio.)":lang==="en"?"(I couldn't transcribe the audio.)":lang==="he"?"(לא הצלחתי לתמלל את האודיו.)":"(Não consegui transcrever o áudio.)"; }
    }

    let ctx = { chunks: [], pass: false, chunksPassing: [] };
    if (scope==="in") ctx = await retrieveHybrid(userText, 6, detectRecencyIntent(userText));

    const hist=histGet(from);
    const chosen=ctx.pass?ctx.chunksPassing:[];
    const finalText=await generateResponseWithHistory(systemPrompt(lang, scope), hist, userText, chosen);

    const fontesList = Array.from(new Set((chosen||[]).map(c => `${c.source}${c.date? " " + c.date : ""}`))).slice(0,6);
    const label=ctx.pass?(lang==="es"?"Basado en el acervo.":(lang==="en"?"Based on the corpus.":(lang==="he"?"מבוסס מאגר.":"Baseado no acervo."))):(lang==="es"?"Respuesta fuera del acervo.":(lang==="en"?"Answer outside corpus.":(lang==="he"?"תשובה מחוץ למאגר.":"Resposta fora do acervo.")));
    const fontesBlock = fontesList.length ? "\n\nFontes: " + fontesList.join(" | ") : "";
    const toSend = finalText + "\n\n" + label + fontesBlock;

    histPush(from,"user",userText);
    histPush(from,"assistant",toSend);
    for(const part of chunkMessage(toSend,1500)) await sendWhatsApp(from, part);
  } catch(err){ console.error("Webhook error:", err); }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("True Live v2.1 listening on", port, "from", TWILIO_WHATSAPP_FROM || "n/a"));
