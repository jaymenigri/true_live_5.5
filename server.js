// server.js — True Live v2.3.1 (fix: fallback sempre que fora de escopo)
// ESM (type: module no package.json)

import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

// ===== serviços RAG =====
import {
  classifyScope,          // "in" | "maybe" | "out"
  retrieveHybrid,         // (query, k, preferRecent) -> { pass, chunksPassing, chunks }
  ingestRSS, ingestSitemap
} from "./services/hybridRag.js";

// ===== OpenAI client mínimo (chat) =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_TIMEOUT = Number(process.env.OPENAI_TIMEOUT_MS || "10000");

// ===== Twilio =====
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || ""; // "whatsapp:+18706068686"

// ===== Admin =====
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "truelive2025";

// ===== RAG threshold =====
const RAG_THRESHOLD = Number(process.env.RAG_THRESHOLD || "0.4");

// ===== Off-topic / Fallback tuning =====
const ANSWER_OUTSIDE_CORPUS_FIRST_N = Number(process.env.ANSWER_OUTSIDE_CORPUS_FIRST_N || "0"); // 0 = nunca suprimir
const OFFTOPIC_MAX = Number(process.env.OFFTOPIC_MAX || "3");
const OFFTOPIC_COOLDOWN_MIN = Number(process.env.OFFTOPIC_COOLDOWN_MIN || "15");

// ===== memória curtíssima na RAM (24h seria banco; aqui só mapa simples) =====
const sessions = new Map(); // key: from -> { history:[...], subject:string, off:{count, until:number} }
function getSession(from) {
  if (!sessions.has(from)) sessions.set(from, { history: [], subject: "", off: { count: 0, until: 0 } });
  return sessions.get(from);
}
function setSubject(from, title = "") {
  const s = getSession(from);
  if (title) s.subject = title;
}
function getSubject(from) {
  return getSession(from).subject || "";
}
function nowSec() { return Math.floor(Date.now() / 1000); }

// ===== Express =====
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------- util ----------
function detectLang(text = "") {
  const t = (text || "").toLowerCase();
  if (/[áéíóúãõç]/.test(t) || t.includes("que ")) return "pt";
  if (/[¿¡]/.test(t)) return "es";
  return "en";
}
function shortOutsidePreface(lang) {
  const m = {
    pt: "Esta pergunta está fora do acervo. Ainda assim, segue uma resposta geral:",
    en: "This is outside the curated corpus. Still, here is a general answer:",
    es: "Esta pregunta está fuera del acervo. Aun así, va una respuesta general:"
  };
  return m[lang] || m.pt;
}
function markAsOutsideCorpus(q, lang) {
  const instr = {
    pt: "Responda clara e diretamente. Não invente fontes. Seja conciso e útil.",
    en: "Answer clearly and directly. Do not fabricate sources. Be concise and helpful.",
    es: "Responde con claridad y sin inventar fuentes. Sé conciso y útil."
  };
  return `${instr[lang] || instr.pt}\n\nPergunta: ${q}`;
}
function withBadges(text, { basedOnCorpus, sources } = {}) {
  const lines = [];
  if (basedOnCorpus) {
    lines.push("Based on the corpus.");
    const names = (sources || []).map(s => s.title || s.source || "corpus").slice(0, 6);
    if (names.length) lines.push(`Fontes: ${names.join(" | ")}`);
  } else {
    lines.push("Resposta fora do acervo.");
  }
  return `${text}\n\n${lines.join("\n")}`;
}
function detectRecencyIntent(text = "") {
  const t = (text || "").toLowerCase();
  return /hoje|agora|última|ultimas|últimas|ultimos|últimos|recent|breaking|agora mesmo/.test(t);
}
function isPronominal(text = "") {
  return /^(quem|qual|quais|onde|quando|como|ele|ela|dele|dela|seu|sua)\b/i.test(text.trim());
}
function expandIfPronominal(text = "", subject = "") {
  if (!isPronominal(text) || !subject) return text;
  // Ex.: "Qual o nome da esposa dele?" -> "Qual o nome da esposa de David Ben-Gurion?"
  return `${text} (referindo-se a ${subject})`;
}

// ---------- OpenAI ----------
async function openaiChat(messages) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), OPENAI_TIMEOUT);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${OPENAI_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.2
      }),
      signal: controller.signal
    });
    const json = await res.json();
    const out = json?.choices?.[0]?.message?.content?.trim() || "";
    return out || "(no content)";
  } finally {
    clearTimeout(to);
  }
}
async function generateResponseWithHistory(userId, userPrompt, lang) {
  const s = getSession(userId);
  const system = {
    role: "system",
    content:
      lang === "pt"
        ? "Você é um assistente claro, conciso e factual. Se o rodapé disser 'Based on the corpus.' ou 'Resposta fora do acervo.', NÃO repita isso; o servidor adiciona o rodapé. Não invente fontes."
        : lang === "es"
        ? "Eres un asistente claro, conciso y factual. Si el pie de página dice 'Based on the corpus.' o 'Respuesta fuera del acervo.', NO lo repitas; el servidor lo añade. No inventes fuentes."
        : "You are a clear, concise, factual assistant. If a footer like 'Based on the corpus.' or 'Resposta fora do acervo.' is appended by the server, do NOT repeat it. Do not invent sources."
  };
  const msgs = [system];
  // Historico curto (últimas 8)
  const hist = s.history.slice(-8);
  msgs.push(...hist);
  msgs.push({ role: "user", content: userPrompt });
  const reply = await openaiChat(msgs);
  // salva
  s.history.push({ role: "user", content: userPrompt });
  s.history.push({ role: "assistant", content: reply });
  return reply;
}

// ---------- Core de processamento ----------
async function handleIncomingText({ from, body }) {
  const userText = (body || "").trim();
  const lang = detectLang(userText);

  // cooldown off-topic?
  const session = getSession(from);
  if (session.off.until > nowSec()) {
    const mins = Math.max(1, Math.ceil((session.off.until - nowSec()) / 60));
    const msg =
      lang === "pt"
        ? `Voltamos em breve. Pausa de ${mins} min por muitas mensagens fora do tema.`
        : lang === "es"
        ? `Volvemos pronto. Pausa de ${mins} min por muchos mensajes fuera del tema.`
        : `We'll be back soon. Cooldown ${mins} min due to off-topic messages.`;
    return msg;
  }

  // 1) escopo
  const scope = classifyScope(userText); // "in" | "maybe" | "out"

  // 2) recência e sujeito
  const preferRecent = detectRecencyIntent(userText);
  const subjectHint = getSubject(from);
  const effectiveQuery = expandIfPronominal(userText, subjectHint);
  console.log("Effective query:", effectiveQuery);

  // 3) Regras
  if (scope === "in" || scope === "maybe") {
    // tentar RAG
    const rag = await retrieveHybrid(effectiveQuery, 6, preferRecent);
    if (rag?.pass && rag?.chunksPassing?.length) {
      // compor prompt “apoiado” nos trechos
      const context = rag.chunksPassing
        .map(c => `• ${c.text} [${c.title || c.source || "corpus"}]`)
        .join("\n");
      const prompt =
        (lang === "pt"
          ? `Responda com base APENAS nos trechos abaixo. Seja claro e breve.\n\nTrechos:\n${context}\n\nPergunta: ${userText}`
          : lang === "es"
          ? `Responde SOLO a partir de los fragmentos. Sé claro y breve.\n\nFragmentos:\n${context}\n\nPregunta: ${userText}`
          : `Answer ONLY from the snippets. Be clear and concise.\n\nSnippets:\n${context}\n\nQuestion: ${userText}`);

      const reply = await generateResponseWithHistory(from, prompt, lang);
      // memoriza “sujeito”
      const head = rag.chunksPassing[0];
      if (head?.title) setSubject(from, head.title);
      return withBadges(reply, { basedOnCorpus: true, sources: rag.chunksPassing });
    }

    // RAG falhou → FALLBACK (sempre responde)
    const fb = await generateResponseWithHistory(
      from,
      markAsOutsideCorpus(userText, lang),
      lang
    );
    return withBadges(fb, { basedOnCorpus: false });
  }

  // scope === "out" → FALLBACK sempre (nunca recusar)
  {
    // contagem off-topic (para proteger o serviço)
    session.off.count += 1;
    if (session.off.count > OFFTOPIC_MAX) {
      session.off.until = nowSec() + OFFTOPIC_COOLDOWN_MIN * 60;
      session.off.count = 0;
    }

    // responde mesmo fora do escopo
    const preface =
      ANSWER_OUTSIDE_CORPUS_FIRST_N > 0 && session.off.count <= ANSWER_OUTSIDE_CORPUS_FIRST_N
        ? shortOutsidePreface(lang) + "\n\n"
        : "";
    const fb = await generateResponseWithHistory(
      from,
      preface + markAsOutsideCorpus(userText, lang),
      lang
    );
    return withBadges(fb, { basedOnCorpus: false });
  }
}

// ---------- Twilio webhook ----------
app.post("/twilio/whatsapp", async (req, res) => {
  try {
    const from = req.body.From || "";
    const body = req.body.Body || "";

    // ack rápido pro Twilio
    res.status(200).send("OK");

    // “✅ pensando…”
    if (from && TWILIO_WHATSAPP_FROM) {
      await sendWhatsApp(from, "✅ Received, thinking...");
    }

    // texto
    if (body && body.trim()) {
      const reply = await handleIncomingText({ from, body });
      await sendWhatsApp(from, reply);
      return;
    }

    // mídia (áudio) – se quiser reativar, aqui vai futuro gancho
    await sendWhatsApp(from, "Envie sua pergunta por texto ou áudio curto.");
  } catch (e) {
    console.error("Webhook error:", e);
    try {
      const to = req.body.From;
      if (to) await sendWhatsApp(to, "Desculpe, ocorreu um erro. Tente novamente.");
    } catch {}
  }
});

// ---------- Admin ----------
app.get("/health", (_req, res) => res.send("ok"));

app.all("/admin/health", (req, res) => {
  const token = req.query.token || req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });
  res.json({
    ok: true,
    model: OPENAI_MODEL,
    rag_threshold: RAG_THRESHOLD,
    offtopic_max: OFFTOPIC_MAX
  });
});

app.all("/admin/ingest/run", async (req, res) => {
  const token = req.query.token || req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });
  const mode = String(req.query.mode || "rss,sitemap").split(",").map(s => s.trim());
  const out = {};
  try {
    if (typeof ingestRSS === "function" && mode.includes("rss")) out.rss = await ingestRSS();
    if (typeof ingestSitemap === "function" && mode.includes("sitemap")) out.sitemap = await ingestSitemap();
    if (!Object.keys(out).length) return res.status(501).json({ ok: false, error: "ingest not available in this build" });
    res.json({ ok: true, result: out });
  } catch (e) {
    console.error("ingest error", e);
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// ---------- WhatsApp send (Twilio API) ----------
async function sendWhatsApp(to, text) {
  // envio via API Messages — aqui usamos a API clássica do Twilio (mensagem simples)
  // Como você já está com o webhook funcionando, este envio pode ser opcional.
  // Caso seu setup envie resposta via TwiML bin / reply automático, comente esta função inteira.
  try {
    // NOP: muitos setups respondem via Twilio “reply”. Se você já vê as respostas chegando,
    // pode ignorar este envio ativo. Deixamos aqui como placeholder.
    // console.log("->", to, text.slice(0, 80));
  } catch (e) {
    console.error("sendWhatsApp error", e.message);
  }
}

// ---------- start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("True Live server up on", PORT));
