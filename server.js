// server.js — True Live v2.6.0 (definitivo)
// - ACK imediato via TwiML
// - Watchdog + fallback garantido (nunca silencia)
// - OpenAI /v1/chat/completions
// - Integra com services/hybridRag.js (funciona com retrieveHybrid() OU search()+loadCorpus())
// - /admin/health retorna corpus_items (sem precisar de terminal)
// - Logs claros com LOG_LEVEL (debug|info|warn|error)

import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import * as rag from "./services/hybridRag.js";

// ===== ENV =====
const {
  ADMIN_TOKEN = "truelive2025",
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  OPENAI_TIMEOUT_MS = "12000",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM, // "whatsapp:+18706068686"
  RAG_THRESHOLD = "0.4",
  OFFTOPIC_MAX = "3",
  OFFTOPIC_COOLDOWN_MIN = "15",
  LOG_LEVEL = "info", // debug|info|warn|error
} = process.env;

const OPENAI_TIMEOUT = Number(OPENAI_TIMEOUT_MS);

// ===== LOGGING =====
const LVL = { debug: 10, info: 20, warn: 30, error: 40 }[LOG_LEVEL] ?? 20;
const log = {
  debug: (...a) => { if (LVL <= 10) console.log("[DEBUG]", ...a); },
  info:  (...a) => { if (LVL <= 20) console.log("[INFO] ", ...a); },
  warn:  (...a) => { if (LVL <= 30) console.warn("[WARN] ", ...a); },
  error: (...a) => console.error("[ERROR]", ...a),
};

// ===== APP =====
const app = express();
app.use(express.urlencoded({ extended: true })); // Twilio usa x-www-form-urlencoded
app.use(express.json());

// ===== Sessões (contexto leve ~24h) =====
const sessions = new Map(); // from -> { history:[], subject:"", off:{count,until}, ts }
const DAY_MS = 24 * 3600 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions.entries()) if ((v.ts || 0) + DAY_MS < now) sessions.delete(k);
}, 60 * 60 * 1000);

function getSession(from) {
  const s = sessions.get(from) || { history: [], subject: "", off: { count: 0, until: 0 }, ts: Date.now() };
  s.ts = Date.now();
  sessions.set(from, s);
  return s;
}
function nowSec(){ return Math.floor(Date.now()/1000); }
function setSubject(from, title){ const s=getSession(from); if(title) s.subject=title; }
function getSubject(from){ return getSession(from).subject || ""; }
function reqId(){ return crypto.randomBytes(6).toString("hex"); }

// ===== Utils de linguagem / prompt =====
function detectLang(text=""){
  const t=text.toLowerCase();
  if (/[áéíóúãõç]/.test(t) || t.includes(" que ")) return "pt";
  if (/[¿¡]/.test(t)) return "es";
  return "en";
}
function isPronominal(text=""){ return /^(quem|qual|quais|onde|quando|como|ele|ela|dele|dela|seu|sua)\b/i.test(text.trim()); }
function expandIfPronominal(text="", subject=""){ return (!isPronominal(text)||!subject)? text : `${text} (referindo-se a ${subject})`; }

function footer(text, { basedOnCorpus, sources } = {}){
  const lines=[];
  if(basedOnCorpus){
    lines.push("Based on the corpus.");
    const names=(sources||[]).map(s=>s.title||s.source||"corpus").slice(0,6);
    if(names.length) lines.push(`Fontes: ${names.join(" | ")}`);
  }else{
    lines.push("Resposta geral (fora do acervo).");
  }
  return `${text}\n\n${lines.join("\n")}`;
}
function outsidePrompt(q, lang){
  const m = {
    pt: "Responda de forma clara e factual. Não invente fontes. Seja conciso e útil.",
    es: "Responde de forma clara y factual. No inventes fuentes. Sé conciso y útil.",
    en: "Answer clearly and factually. Do not fabricate sources. Be concise and helpful."
  };
  return `${m[lang]||m.pt}\n\nPergunta: ${q}`;
}

// ===== OpenAI =====
async function openaiChat(messages, lang="pt", rid="-"){
  const controller = new AbortController();
  const to = setTimeout(()=>controller.abort(), OPENAI_TIMEOUT);
  try{
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature: 0.2 }),
      signal: controller.signal,
    });
    if(!res.ok){
      const body = await res.text();
      throw new Error(`OpenAI HTTP ${res.status} — ${body.slice(0,500)}`);
    }
    const js = await res.json();
    const out = js?.choices?.[0]?.message?.content?.trim() || "";
    log.debug(rid, "OpenAI ok");
    return out || (lang==="pt"?"Desculpe, não consegui gerar a resposta.":lang==="es"?"Perdón, no pude generar la respuesta.":"Sorry, I couldn’t generate the answer.");
  }catch(e){
    log.error(rid, "OpenAI error:", e?.message||e);
    return (lang==="pt"?"Desculpe, tive um problema técnico.":lang==="es"?"Perdón, tuve un problema técnico.":"Sorry, I had a technical issue.");
  }finally{ clearTimeout(to); }
}
async function answerWithHistory(userId, prompt, lang, rid="-"){
  const s=getSession(userId);
  const sys = lang==="pt" ? "Você é um assistente claro, conciso e factual. Não adicione rodapés."
           : lang==="es" ? "Eres un asistente claro, conciso y factual. No agregues pies de página."
                          : "You are a clear, concise, factual assistant. Do not add footers.";
  const msgs=[{role:"system",content:sys},...s.history.slice(-8),{role:"user",content:prompt}];
  const reply=await openaiChat(msgs,lang,rid);
  s.history.push({role:"user",content:prompt});
  s.history.push({role:"assistant",content:reply});
  return reply;
}

// ===== Twilio: enviar WhatsApp =====
async function sendWhatsApp(to, body, rid="-"){
  try{
    if(!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM){
      log.error(rid,"Twilio ENV missing; cannot send message."); return;
    }
    const url=`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth=Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const form=new URLSearchParams({ From:TWILIO_WHATSAPP_FROM, To:to, Body:body });
    const res=await fetch(url,{method:"POST",headers:{Authorization:`Basic ${auth}`,"Content-Type":"application/x-www-form-urlencoded"},body:form});
    const txt=await res.text();
    if(!res.ok) log.error(rid,"Twilio send error:", res.status, txt.slice(0,400));
    else log.debug(rid,"Twilio sent");
  }catch(e){ log.error(rid,"sendWhatsApp error", e?.message||e); }
}

// ===== Integração com o RAG (compatível com v2.5 e v2.5.1+) =====
function classifyScopeCompat(text){
  if (typeof rag.classifyScope === "function") return rag.classifyScope(text);
  // fallback de alto recall
  const t = (text||"").toLowerCase();
  const keys = ["israel","juda","sion","zion","holocausto","shoah","antisemit","gaza","cisjord","jerusal","hamas","hezbol","idf","knesset","rabin","ben gurion","ben-gurion","golda","yom kipur","sei dias","nakba","west bank","faixa de gaza","judeia","samaria"];
  return keys.some(k=>t.includes(k)) ? "in" : "out";
}

async function runRagCompat(query, preferRecent=false){
  // Caminho 1: retrieveHybrid(query, k, preferRecent)
  if (typeof rag.retrieveHybrid === "function") {
    const r = await rag.retrieveHybrid(query, 6, preferRecent);
    return {
      pass: !!r?.pass,
      chunks: (r?.chunksPassing || r?.chunks || []).map(c => ({
        text: c.text, title: c.title || c.source || "corpus", source: c.source || "corpus", date: c.date || null
      })),
      debug: r?.debug || null
    };
  }
  // Caminho 2: search(query, {threshold})
  if (typeof rag.search === "function") {
    const r = rag.search(query, { threshold: Number(RAG_THRESHOLD) });
    return {
      pass: !!r?.pass,
      chunks: (r?.chunks || []).map(c => ({
        text: c.snippet || c.text, title: c.title || c.source || "corpus", source: c.source || "corpus", date: c.date || null
      })),
      debug: r?.debug || null
    };
  }
  return { pass: false, chunks: [], debug: null };
}

function getCorpusItemsCount(){
  // Se o services/hybridRag.exportar loadCorpus(), usamos para saber N itens
  if (typeof rag.loadCorpus === "function") {
    const st = rag.loadCorpus();
    if (st && Array.isArray(st.docs)) return st.docs.length;
  }
  // Sem loadCorpus: não conseguimos contar; retornamos null
  return null;
}

// ===== Core de processamento =====
async function handleIncomingText({from, body, rid}){
  const lang=detectLang(body);
  const s=getSession(from);

  // cooldown simples para spam off-topic
  if (s.off.until > nowSec()){
    const mins=Math.max(1, Math.ceil((s.off.until-nowSec())/60));
    return lang==="pt"?`Voltamos em breve. Pausa de ${mins} min.`:lang==="es"?`Volvemos pronto. Pausa de ${mins} min.`:`We'll be back soon. Cooldown ${mins} min.`;
  }

  const scope = classifyScopeCompat(body); // "in" | "out" | "maybe"
  const subject = getSubject(from);
  const effectiveQuery = expandIfPronominal(body, subject);

  log.info(rid, `IN scope=${scope} lang=${lang}`);
  log.debug(rid, "Q:", body);
  log.debug(rid, "Effective:", effectiveQuery);

  try{
    const preferRecent = /\b(hoje|agora|últim|ultim|recent|breaking|agora mesmo|today|now|latest|recent)\b/i.test(body);

    if (scope === "in" || scope === "maybe") {
      const r = await runRagCompat(effectiveQuery, preferRecent);
      if (r.pass && r.chunks.length){
        const ctx = r.chunks.map(c=>`• ${c.text} [${c.title||c.source||"corpus"}]`).join("\n");
        const prompt = lang==="pt"
          ? `Responda APENAS com base nos trechos abaixo. Seja claro e breve.\n\nTrechos:\n${ctx}\n\nPergunta: ${body}`
          : lang==="es"
          ? `Responde SOLO a partir de los fragmentos. Sé claro y breve.\n\nFragmentos:\n${ctx}\n\nPregunta: ${body}`
          : `Answer ONLY from the snippets. Be clear and concise.\n\nSnippets:\n${ctx}\n\nQuestion: ${body}`;

        const reply = await answerWithHistory(from, prompt, lang, rid);
        if (r.chunks[0]?.title) setSubject(from, r.chunks[0].title);
        return footer(reply, { basedOnCorpus: true, sources: r.chunks });
      }
      // sem passagem no corpus → FALLBACK
      const fb=await answerWithHistory(from, outsidePrompt(body,lang), lang, rid);
      return footer(fb, { basedOnCorpus:false });
    }

    // fora de escopo → FALLBACK sempre (sem recusar)
    s.off.count += 1;
    if (s.off.count > Number(OFFTOPIC_MAX)) { s.off.until = nowSec() + Number(OFFTOPIC_COOLDOWN_MIN)*60; s.off.count = 0; }
    const fb=await answerWithHistory(from, outsidePrompt(body,lang), lang, rid);
    return footer(fb, { basedOnCorpus:false });

  }catch(e){
    log.error(rid,"handleIncomingText error:", e?.message||e);
    const msg = lang==="pt" ? "Desculpe, tive um problema, mas aqui vai uma explicação geral:"
              : lang==="es" ? "Perdón, tuve un problema, pero aquí va una explicación general:"
                             : "Sorry, I had an issue, but here is a general explanation:";
    const fb=await answerWithHistory(from, `${msg}\n\n${outsidePrompt(body,lang)}`, lang, rid);
    return footer(fb,{basedOnCorpus:false});
  }
}

// ===== Webhook do Twilio — ACK + watchdog =====
app.post("/twilio/whatsapp", async (req,res)=>{
  const rid = reqId();
  const from=(req.body.From||"").trim();
  const body=(req.body.Body||"").trim();
  const lang=detectLang(body);

  // 1) ACK imediato (TwiML)
  const ack = lang==="es"?"✅ Recibido, pensando…":lang==="en"?"✅ Received, thinking…":"✅ Recebido, pensando…";
  res.set("Content-Type","application/xml").status(200).send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${ack}</Message></Response>`
  );
  log.info(rid, "ACK sent", { from });

  // 2) Pipeline com watchdog
  try{
    const watchdogMs = Math.max(OPENAI_TIMEOUT, 12000) + 2000;
    const task = (async()=> await handleIncomingText({from, body, rid}))();
    const guard = new Promise(resolve => setTimeout(()=>resolve("__TIMEOUT__"), watchdogMs));
    const result = await Promise.race([task, guard]);

    if(result === "__TIMEOUT__"){
      log.warn(rid, "watchdog timeout → sending safe fallback");
      const safe = lang==="pt"
        ? "Demorou mais que o esperado, então aqui vai uma resposta geral. Pode perguntar novamente."
        : lang==="es"
        ? "Tardó más de lo esperado, así que aquí va una respuesta general. Puedes preguntar de nuevo."
        : "Took longer than expected, so here is a general answer. You can ask again.";
      await sendWhatsApp(from, footer(safe,{basedOnCorpus:false}), rid);
    }else{
      await sendWhatsApp(from, result, rid);
    }
  }catch(e){
    log.error(rid,"webhook outer error:", e?.message||e);
    const fallback = lang==="pt" ? "Desculpe, ocorreu um erro. Aqui vai uma resposta geral."
                   : lang==="es" ? "Perdón, ocurrió un error. Aquí va una respuesta general."
                                  : "Sorry, an error occurred. Here is a general answer.";
    await sendWhatsApp(from, footer(fallback,{basedOnCorpus:false}), rid);
  }
});

// ===== Admin =====
app.get("/health", (_req,res)=>res.send("ok"));

app.all("/admin/health", (_req,res)=>{
  const token = _req.query.token || _req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });

  const corpusItems = getCorpusItemsCount();
  res.json({
    status: "ok",
    ok: true,
    model: OPENAI_MODEL,
    rag_threshold: Number(RAG_THRESHOLD),
    openai_timeout_ms: OPENAI_TIMEOUT,
    corpus_items: corpusItems, // pode ser null se services não expor loadCorpus()
    log_level: LOG_LEVEL
  });
});

app.all("/admin/ingest/run", async (_req,res)=>{
  const token = _req.query.token || _req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
  // Placeholders (seus services podem implementar ingestRSS/ingestSitemap futuramente)
  const out = {};
  try{
    if (typeof rag.ingestRSS === "function") out.rss = await rag.ingestRSS();
    if (typeof rag.ingestSitemap === "function") out.sitemap = await rag.ingestSitemap();
    if (!Object.keys(out).length) return res.status(501).json({ ok:false, error:"ingest not available in this build" });
    res.json({ ok:true, result: out });
  }catch(e){
    log.error("ingest error", e?.message||e);
    res.status(500).json({ ok:false, error: String(e?.message||e) });
  }
});

// ===== Start =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("True Live up on", PORT));
