// server.js — True Live v2.3.3
import express from "express";
import fetch from "node-fetch";
import {
  classifyScope,
  retrieveHybrid,
  ingestRSS,
  ingestSitemap
} from "./services/hybridRag.js";

const {
  ADMIN_TOKEN = "truelive2025",
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  OPENAI_TIMEOUT_MS = "12000",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  RAG_THRESHOLD = "0.4",
  OFFTOPIC_MAX = "3",
  OFFTOPIC_COOLDOWN_MIN = "15",
} = process.env;

const OPENAI_TIMEOUT = Number(OPENAI_TIMEOUT_MS);
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ===== sessão =====
const sessions = new Map();
function getSession(id){ if(!sessions.has(id)) sessions.set(id,{history:[],subject:"",off:{count:0,until:0}}); return sessions.get(id); }
function setSubject(id,t){ const s=getSession(id); if(t) s.subject=t; }
function getSubject(id){ return getSession(id).subject||""; }
function nowSec(){ return Math.floor(Date.now()/1000); }

// ===== utils =====
function detectLang(t=""){t=t.toLowerCase(); if(/[áéíóúãõç]/.test(t)||t.includes(" que "))return"pt"; if(/[¿¡]/.test(t))return"es"; return"en";}
function detectRecencyIntent(t=""){t=t.toLowerCase(); return /hoje|agora|últim|ultim|recent|breaking|agora mesmo/.test(t);}
function isPronominal(t=""){return /^(quem|qual|quais|onde|quando|como|ele|ela|dele|dela|seu|sua)\b/i.test(t.trim());}
function expandIfPronominal(q="", subj=""){ return (!isPronominal(q)||!subj)? q : `${q} (referindo-se a ${subj})`; }
function footer(text,{basedOnCorpus,sources}={}){
  const lines=[];
  if(basedOnCorpus){
    lines.push("Based on the corpus.");
    const names=(sources||[]).map(s=>s.title||s.source||"corpus").slice(0,6);
    if(names.length) lines.push(`Fontes: ${names.join(" | ")}`);
  }else{
    lines.push("Resposta fora do acervo.");
  }
  return `${text}\n\n${lines.join("\n")}`;
}
function outsidePrompt(q,lang){
  const m={
    pt:"Responda de forma clara e factual. Não invente fontes. Seja conciso e útil.",
    es:"Responde de forma clara y factual. No inventes fuentes. Sé conciso y útil.",
    en:"Answer clearly and factually. Do not fabricate sources. Be concise and helpful."
  };
  return `${m[lang]||m.pt}\n\nPergunta: ${q}`;
}

// ===== OpenAI =====
async function openaiChat(messages, lang="pt"){
  const controller=new AbortController();
  const to=setTimeout(()=>controller.abort(), OPENAI_TIMEOUT);
  try{
    const res=await fetch("https://api.openai.com/1/chat/completions",{ // compat com proxy/edge; se falhar, usar /v1/
      method:"POST",
      headers:{ "authorization":`Bearer ${OPENAI_API_KEY}`, "content-type":"application/json" },
      body:JSON.stringify({ model:OPENAI_MODEL, messages, temperature:0.2 }),
      signal:controller.signal
    }).catch(()=>null);
    if(!res||!res.ok){ throw new Error(`openai http ${res?.status||"fail"}`); }
    const js=await res.json();
    const out=js?.choices?.[0]?.message?.content?.trim()||"";
    return out || (lang==="pt"?"Desculpe, não consegui gerar a resposta.":lang==="es"?"Perdón, no pude generar la respuesta.":"Sorry, I couldn’t generate the answer.");
  }catch(e){
    console.error("OpenAI error:", e?.message||e);
    return (lang==="pt"?"Desculpe, tive um problema técnico.":lang==="es"?"Perdón, tuve un problema técnico.":"Sorry, I had a technical issue.");
  }finally{ clearTimeout(to); }
}
async function answerWithHistory(userId, prompt, lang){
  const s=getSession(userId);
  const sys = lang==="pt" ? "Você é um assistente claro, conciso e factual. Não adicione rodapés."
           : lang==="es" ? "Eres un asistente claro, conciso y factual. No agregues pies de página."
                          : "You are a clear, concise, factual assistant. Do not add footers.";
  const msgs=[{role:"system",content:sys},...s.history.slice(-8),{role:"user",content:prompt}];
  const reply=await openaiChat(msgs,lang);
  s.history.push({role:"user",content:prompt});
  s.history.push({role:"assistant",content:reply});
  return reply;
}

// ===== Twilio send =====
async function sendWhatsApp(to, body){
  try{
    if(!TWILIO_ACCOUNT_SID||!TWILIO_AUTH_TOKEN||!TWILIO_WHATSAPP_FROM){ console.error("Twilio ENV missing"); return; }
    const url=`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth=Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const form=new URLSearchParams({ From:TWILIO_WHATSAPP_FROM, To:to, Body:body });
    const res=await fetch(url,{method:"POST",headers:{Authorization:`Basic ${auth}`,"Content-Type":"application/x-www-form-urlencoded"},body:form});
    const txt=await res.text();
    if(!res.ok) console.error("Twilio send error:", res.status, txt.slice(0,300));
  }catch(e){ console.error("sendWhatsApp error", e?.message||e); }
}

// ===== Core =====
async function handleIncomingText({from, body}){
  const lang=detectLang(body);
  const s=getSession(from);
  if(s.off.until>nowSec()){
    const mins=Math.max(1,Math.ceil((s.off.until-nowSec())/60));
    return lang==="pt"?`Voltamos em breve. Pausa de ${mins} min.`:lang==="es"?`Volvemos pronto. Pausa de ${mins} min.`:`We'll be back soon. Cooldown ${mins} min.`;
  }

  const scope=classifyScope(body);
  const preferRecent=detectRecencyIntent(body);
  const eff=expandIfPronominal(body, getSubject(from));
  console.log(`[IN] ${from} scope=${scope} recent=${preferRecent} q="${body}"`);
  console.log("Effective query:", eff);

  try{
    if(scope==="in"||scope==="maybe"){
      const rag=await retrieveHybrid(eff,6,preferRecent);
      if(rag?.pass && rag?.chunksPassing?.length){
        const ctx=rag.chunksPassing.map(c=>`• ${c.text} [${c.title||c.source||"corpus"}]`).join("\n");
        const p = lang==="pt" ? `Responda APENAS com base nos trechos abaixo. Seja claro e breve.\n\nTrechos:\n${ctx}\n\nPergunta: ${body}`
                : lang==="es" ? `Responde SOLO a partir de los fragmentos. Sé claro y breve.\n\nFragmentos:\n${ctx}\n\nPregunta: ${body}`
                               : `Answer ONLY from the snippets. Be clear and concise.\n\nSnippets:\n${ctx}\n\nQuestion: ${body}`;
        const r=await answerWithHistory(from,p,lang);
        const head=rag.chunksPassing[0]; if(head?.title) setSubject(from, head.title);
        return footer(r,{basedOnCorpus:true,sources:rag.chunksPassing});
      }
      const fb=await answerWithHistory(from, outsidePrompt(body,lang), lang);
      return footer(fb,{basedOnCorpus:false});
    }else{
      s.off.count+=1;
      if(s.off.count>Number(OFFTOPIC_MAX)){ s.off.until=nowSec()+Number(OFFTOPIC_COOLDOWN_MIN)*60; s.off.count=0; }
      const fb=await answerWithHistory(from, outsidePrompt(body,lang), lang);
      return footer(fb,{basedOnCorpus:false});
    }
  }catch(e){
    console.error("handleIncomingText error", e?.message||e);
    // fallback duro
    const msg = lang==="pt" ? "Desculpe, tive um problema, mas aqui vai uma explicação geral:" :
                lang==="es" ? "Perdón, tuve un problema, pero aquí va una explicación general:" :
                              "Sorry, I had an issue, but here is a general explanation:";
    const fb=await answerWithHistory(from, `${msg}\n\n${outsidePrompt(body,lang)}`, lang);
    return footer(fb,{basedOnCorpus:false});
  }
}

// ===== Webhook (ACK + watchdog) =====
app.post("/twilio/whatsapp", async (req,res)=>{
  const from=(req.body.From||"").trim();
  const body=(req.body.Body||"").trim();
  const lang=detectLang(body);
  const ack = lang==="es"?"✅ Recibido, pensando…":lang==="en"?"✅ Received, thinking…":"✅ Recebido, pensando…";

  // 1) sempre envia ACK via TwiML
  res.set("Content-Type","application/xml").status(200).send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${ack}</Message></Response>`
  );

  // 2) processa com watchdog: se passar do tempo, envia fallback genérico
  try{
    const watchdogMs = Math.max(OPENAI_TIMEOUT, 12000) + 2000; // OPENAI_TIMEOUT + 2s
    const task = (async()=> await handleIncomingText({from, body}))();
    const guard = new Promise(resolve=> setTimeout(()=> resolve("__TIMEOUT__"), watchdogMs));
    const result = await Promise.race([task, guard]);
    if(result === "__TIMEOUT__"){
      console.warn("watchdog timeout, sending safe fallback");
      const safe = lang==="pt" ? "Demorou mais que o esperado, então aqui vai um resumo geral. Se quiser, pergunte novamente." :
                   lang==="es" ? "Tardó más de lo esperado, así que aquí va un resumen general. Si quieres, pregunta de nuevo." :
                                 "Took longer than expected, so here is a general answer. You can ask again.";
      await sendWhatsApp(from, footer(safe,{basedOnCorpus:false}));
    }else{
      await sendWhatsApp(from, result);
    }
  }catch(e){
    console.error("webhook outer error", e?.message||e);
    const fallback = lang==="pt" ? "Desculpe, ocorreu um erro. Segue uma resposta geral." :
                     lang==="es" ? "Perdón, ocurrió un error. Va una respuesta general." :
                                   "Sorry, an error occurred. Here is a general answer.";
    await sendWhatsApp(from, footer(fallback,{basedOnCorpus:false}));
  }
});

// ===== Admin =====
app.get("/health",(_req,res)=>res.send("ok"));
app.all("/admin/health",(req,res)=>{
  const token=req.query.token||req.headers["x-admin-token"];
  if(token!==ADMIN_TOKEN) return res.status(401).json({ok:false,error:"unauthorized"});
  res.json({ ok:true, model:OPENAI_MODEL, rag_threshold:Number(RAG_THRESHOLD), openai_timeout_ms: OPENAI_TIMEOUT });
});
app.all("/admin/ingest/run", async (req,res)=>{
  const token=req.query.token||req.headers["x-admin-token"];
  if(token!==ADMIN_TOKEN) return res.status(401).json({ok:false,error:"unauthorized"});
  const mode=String(req.query.mode||"rss,sitemap").split(",").map(s=>s.trim());
  const out={};
  try{
    if(mode.includes("rss")) out.rss=await ingestRSS();
    if(mode.includes("sitemap")) out.sitemap=await ingestSitemap();
    res.json({ok:true,result:out});
  }catch(e){ console.error("ingest error",e); res.status(500).json({ok:false,error:String(e?.message||e)}); }
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log("True Live up on",PORT));
