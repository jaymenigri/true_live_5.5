// server.js — True Live v2.3.2
// Correções: TwiML no ACK + envio ativo via Twilio Messages API + logs

import express from "express";
import fetch from "node-fetch";

// === Serviços internos ===
import {
  classifyScope,
  retrieveHybrid,
  ingestRSS,
  ingestSitemap
} from "./services/hybridRag.js";

// === ENV ===
const {
  ADMIN_TOKEN = "truelive2025",
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  OPENAI_TIMEOUT_MS = "10000",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM, // ex.: "whatsapp:+18706068686"
  RAG_THRESHOLD = "0.4",
  ANSWER_OUTSIDE_CORPUS_FIRST_N = "0",
  OFFTOPIC_MAX = "3",
  OFFTOPIC_COOLDOWN_MIN = "15"
} = process.env;

const OPENAI_TIMEOUT = Number(OPENAI_TIMEOUT_MS);

// === Memória de sessão (leve) ===
const sessions = new Map(); // from -> { history:[], subject:"", off:{count, until} }
function getSession(from) {
  if (!sessions.has(from)) sessions.set(from, { history: [], subject: "", off: { count: 0, until: 0 } });
  return sessions.get(from);
}
function setSubject(from, title) { const s = getSession(from); if (title) s.subject = title; }
function getSubject(from) { return getSession(from).subject || ""; }
function nowSec(){ return Math.floor(Date.now()/1000); }

// === App ===
const app = express();
// Twilio manda application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// === Utils ===
function detectLang(text=""){
  const t=(text||"").toLowerCase();
  if (/[áéíóúãõç]/.test(t) || t.includes(" que ")) return "pt";
  if (/[¿¡]/.test(t)) return "es";
  return "en";
}
function detectRecencyIntent(text=""){
  const t=(text||"").toLowerCase();
  return /hoje|agora|últim|ultim|recent|breaking|agora mesmo/.test(t);
}
function isPronominal(text=""){
  return /^(quem|qual|quais|onde|quando|como|ele|ela|dele|dela|seu|sua)\b/i.test(text.trim());
}
function expandIfPronominal(text="", subject=""){
  if (!isPronominal(text) || !subject) return text;
  return `${text} (referindo-se a ${subject})`;
}
function shortOutsidePreface(lang){
  const m = {
    pt: "Esta pergunta está fora do acervo. Ainda assim, segue uma resposta geral:",
    en: "This is outside the curated corpus. Still, here is a general answer:",
    es: "Esta pregunta está fuera del acervo. Aun así, va una respuesta general:"
  };
  return m[lang] || m.pt;
}
function markAsOutsideCorpus(q, lang){
  const instr = {
    pt: "Responda clara e diretamente. Não invente fontes. Seja conciso e útil.",
    en: "Answer clearly and directly. Do not fabricate sources. Be concise and helpful.",
    es: "Responde con claridad y sin inventar fuentes. Sé conciso y útil."
  };
  return `${instr[lang] || instr.pt}\n\nPergunta: ${q}`;
}
function withBadges(text, { basedOnCorpus, sources } = {}){
  const lines = [];
  if (basedOnCorpus) {
    lines.push("Based on the corpus.");
    const names = (sources || []).map(s => s.title || s.source || "corpus").slice(0,6);
    if (names.length) lines.push(`Fontes: ${names.join(" | ")}`);
  } else {
    lines.push("Resposta fora do acervo.");
  }
  return `${text}\n\n${lines.join("\n")}`;
}

// === OpenAI chat mínimo ===
async function openaiChat(messages, lang="pt"){
  const controller = new AbortController();
  const to = setTimeout(()=>controller.abort(), OPENAI_TIMEOUT);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${OPENAI_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature: 0.2 }),
      signal: controller.signal
    });
    const json = await res.json();
    const out = json?.choices?.[0]?.message?.content?.trim() || "";
    return out || (lang==="pt" ? "Desculpe, não consegui gerar a resposta." : lang==="es" ? "Perdón, no pude generar la respuesta." : "Sorry, I couldn’t generate the answer.");
  } catch (e) {
    console.error("OpenAI error", e?.message || e);
    return (lang==="pt" ? "Desculpe, tive um problema técnico." : lang==="es" ? "Perdón, tuve un problema técnico." : "Sorry, I had a technical issue.");
  } finally {
    clearTimeout(to);
  }
}
async function generateResponseWithHistory(userId, userPrompt, lang){
  const s = getSession(userId);
  const system =
    lang==="pt" ? "Você é um assistente claro, conciso e factual. Não adicione rodapés; o servidor cuida disso."
    : lang==="es" ? "Eres un asistente claro, conciso y factual. No agregues pies de página; el servidor se encarga."
    : "You are a clear, concise, factual assistant. Do not add footers; the server will handle them.";
  const msgs = [{ role:"system", content: system }, ...s.history.slice(-8), { role:"user", content: userPrompt }];
  const reply = await openaiChat(msgs, lang);
  s.history.push({ role:"user", content: userPrompt });
  s.history.push({ role:"assistant", content: reply });
  return reply;
}

// === Twilio: envio ativo via API ===
async function sendWhatsApp(to, body){
  try {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
      console.error("Twilio ENV missing; cannot send message.");
      return;
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const form = new URLSearchParams({
      From: TWILIO_WHATSAPP_FROM,
      To: to,
      Body: body
    });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form
    });
    const txt = await res.text();
    if (!res.ok) console.error("Twilio send error:", res.status, txt.slice(0,300));
  } catch (e) {
    console.error("sendWhatsApp error", e?.message || e);
  }
}

// === Core de processamento ===
async function handleIncomingText({ from, body }){
  const userText = (body || "").trim();
  const lang = detectLang(userText);

  // cooldown simples
  const s = getSession(from);
  if (s.off.until > nowSec()) {
    const mins = Math.max(1, Math.ceil((s.off.until - nowSec())/60));
    return lang==="pt" ? `Voltamos em breve. Pausa de ${mins} min por muitas mensagens fora do tema.`
         : lang==="es" ? `Volvemos pronto. Pausa de ${mins} min por muchos mensajes fuera del tema.`
         : `We'll be back soon. Cooldown ${mins} min due to off-topic messages.`;
  }

  const scope = classifyScope(userText); // "in" | "maybe" | "out"
  const preferRecent = detectRecencyIntent(userText);
  const subjectHint = getSubject(from);
  const effectiveQuery = expandIfPronominal(userText, subjectHint);

  console.log(`[IN] from=${from} text="${userText}" scope=${scope} recent=${preferRecent}`);
  console.log("Effective query:", effectiveQuery);

  // Dentro ou maybe → tenta RAG primeiro
  if (scope === "in" || scope === "maybe") {
    const rag = await retrieveHybrid(effectiveQuery, 6, preferRecent);
    if (rag?.pass && rag?.chunksPassing?.length) {
      const context = rag.chunksPassing
        .map(c => `• ${c.text} [${c.title || c.source || "corpus"}]`)
        .join("\n");
      const prompt =
        lang==="pt" ? `Responda APENAS com base nos trechos abaixo. Seja claro e breve.\n\nTrechos:\n${context}\n\nPergunta: ${userText}`
      : lang==="es" ? `Responde SOLO a partir de los fragmentos. Sé claro y breve.\n\nFragmentos:\n${context}\n\nPregunta: ${userText}`
      : `Answer ONLY from the snippets. Be clear and concise.\n\nSnippets:\n${context}\n\nQuestion: ${userText}`;

      const reply = await generateResponseWithHistory(from, prompt, lang);
      const head = rag.chunksPassing[0];
      if (head?.title) setSubject(from, head.title);
      return withBadges(reply, { basedOnCorpus: true, sources: rag.chunksPassing });
    }

    // RAG falhou → FALLBACK
    const fb = await generateResponseWithHistory(from, markAsOutsideCorpus(userText, lang), lang);
    return withBadges(fb, { basedOnCorpus: false });
  }

  // Fora de escopo → FALLBACK SEMPRE (nunca recusar)
  s.off.count += 1;
  if (s.off.count > Number(OFFTOPIC_MAX)) {
    s.off.until = nowSec() + Number(OFFTOPIC_COOLDOWN_MIN) * 60;
    s.off.count = 0;
  }
  const preface = Number(ANSWER_OUTSIDE_CORPUS_FIRST_N) > 0 && s.off.count <= Number(ANSWER_OUTSIDE_CORPUS_FIRST_N)
    ? shortOutsidePreface(lang) + "\n\n" : "";
  const fb = await generateResponseWithHistory(from, preface + markAsOutsideCorpus(userText, lang), lang);
  return withBadges(fb, { basedOnCorpus: false });
}

// === Webhook (Twilio) ===
app.post("/twilio/whatsapp", async (req, res) => {
  try {
    const from = (req.body.From || "").trim();
    const body = (req.body.Body || "").trim();

    // 1) TwiML imediato → garante resposta no WhatsApp
    const ack =
      detectLang(body)==="es" ? "✅ Recibido, pensando…"
      : detectLang(body)==="en" ? "✅ Received, thinking…"
      : "✅ Recebido, pensando…";
    res.set("Content-Type","application/xml").status(200).send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${ack}</Message></Response>`
    );

    // 2) Processa e envia a resposta final via API do Twilio
    if (from && body) {
      const reply = await handleIncomingText({ from, body });
      await sendWhatsApp(from, reply);
    }
  } catch (e) {
    console.error("Webhook error:", e?.message || e);
    // Não dá pra responder aqui porque já enviamos TwiML
  }
});

// === Admin ===
app.get("/health", (_req,res) => res.send("ok"));

app.all("/admin/health", (req,res) => {
  const token = req.query.token || req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
  res.json({
    ok:true,
    model: OPENAI_MODEL,
    rag_threshold: Number(RAG_THRESHOLD),
    offtopic_max: Number(OFFTOPIC_MAX)
  });
});

app.all("/admin/ingest/run", async (req,res) => {
  const token = req.query.token || req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
  const mode = String(req.query.mode || "rss,sitemap").split(",").map(s=>s.trim().toLowerCase());
  const out = {};
  try {
    if (typeof ingestRSS === "function" && mode.includes("rss")) out.rss = await ingestRSS();
    if (typeof ingestSitemap === "function" && mode.includes("sitemap")) out.sitemap = await ingestSitemap();
    if (!Object.keys(out).length) return res.status(501).json({ ok:false, error:"ingest not available" });
    res.json({ ok:true, result: out });
  } catch (e) {
    console.error("ingest error", e);
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

// === Start ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("True Live up on", PORT));
