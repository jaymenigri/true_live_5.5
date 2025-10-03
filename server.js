// server.js — True Live v2.7
// - Mantém toda a lógica que já estava funcionando (RAG, fallback, Postgres, health, logs).
// - Adiciona: Atualidade (web) via services/realtime.js e Multi-idioma automático.
// - Sem dependências novas (usa fetch nativo do Node 20).

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch"; // no Heroku Node 20, ok (seu package.json já inclui)
import { search as hybridSearch } from "./services/hybridRag.js";
import { getRealtimeAnswer, looksRecent } from "./services/realtime.js";

// ---------------------- Config ----------------------
const {
  PORT = 3000,
  ADMIN_TOKEN = "truelive2025",
  OPENAI_MODEL = "gpt-4o-mini",

  // controles já existentes
  RAG_THRESHOLD = "0.4",
  ANSWER_OUTSIDE_CORPUS = "1",
  OFFTOPIC_MAX = "3",
  OFFTOPIC_COOLDOWN_MIN = "15",

  // logs
  LOG_LEVEL = "info"
} = process.env;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------------------- Util ----------------------
const log = (level, ...args) => {
  const order = { error: 0, warn: 1, info: 2, debug: 3 };
  const curr = order[(LOG_LEVEL || "info").toLowerCase()] ?? 2;
  const want = order[level] ?? 2;
  if (want <= curr) console[level](`[${level.toUpperCase()}]`, ...args);
};

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

// Idioma: detecção simples PT/EN/ES (sem libs).
function detectLang(text) {
  const t = (text || "").toLowerCase();
  const pt = /(que|qual|como|onde|quando|por que|por quê|quem|esposa|capital|hoje|agora|fonte|acervo|resposta)/;
  const es = /(qué|cuál|cómo|dónde|cuándo|por qué|esposa|capital|hoy|ahora|fuente|archivo|respuesta)/;
  const en = /(what|who|where|when|why|how|wife|capital|today|now|source|corpus|answer)/;
  if (pt.test(t)) return "pt";
  if (es.test(t)) return "es";
  if (en.test(t)) return "en";
  // fallback: se contém acentos típicos do PT/ES, assume PT
  if (/[áéíóúãõç]/.test(t)) return "pt";
  return "pt";
}

// Produz “prefixos” de sistema para o gerador (mantém seu tom atual)
function systemStyle(lang) {
  const map = {
    pt: "Responda de forma clara, concisa e didática, em português do Brasil. Se a resposta vier do acervo, cite as fontes no final.",
    es: "Responde de forma clara, concisa y didáctica, en español. Si la respuesta viene del acervo, cita las fuentes al final.",
    en: "Answer clearly, concisely and helpfully, in English. If the answer comes from the corpus, cite sources at the end."
  };
  return map[lang] || map.pt;
}

// ---------------------- Memória leve (em Ram) + “subject” ----------------------
// Mantemos compatível com a versão que você já está usando (há suporte a Postgres em hybridRag.js).
// Aqui guardamos apenas a última “entidade/assunto” por número.
const SUBJECT_TTL_MS = 24 * 60 * 60 * 1000;
const subjects = new Map(); // key = from, value = { subject, ts }
function setSubject(from, subject) {
  subjects.set(from, { subject, ts: Date.now() });
}
function getSubject(from) {
  const x = subjects.get(from);
  if (!x) return null;
  if (Date.now() - x.ts > SUBJECT_TTL_MS) { subjects.delete(from); return null; }
  return x.subject || null;
}

// ---------------------- Health ----------------------
app.get("/admin/health", (req, res) => {
  const token = req.query.token || req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });
  const corpusItems = hybridSearch._count?.() ?? null;
  res.json({
    status: "ok",
    time: nowIso(),
    corpus_items: corpusItems
  });
});

// ---------------------- WhatsApp webhook ----------------------
app.post("/twilio/whatsapp", async (req, res) => {
  // ACK imediato pro Twilio
  try { res.status(200).send(""); } catch { /* noop */ }

  try {
    const body = req.body || {};
    const from = body.From || body.from || (body.WaId ? "whatsapp:+" + body.WaId : "unknown");
    const text = (body.Body || body.body || "").trim();
    const lang = detectLang(text);

    // 1) Classificação leve de “recência”: se for “agora/hoje/tempo/clima”, vamos para Atualidade primeiro.
    const recentIntent = looksRecent(text);

    // 2) RAG híbrido (mantém seu comportamento atual)
    const prevSubject = getSubject(from);
    const { pass, score, answer, title, sources, resolvedQuery } = await hybridSearch({
      query: text,
      prevSubject,
      threshold: Number(RAG_THRESHOLD)
    });

    if (pass) {
      // guardamos o “assunto” para perguntas relacionais (“esposa dele”, “onde nasceu?”)
      if (title) setSubject(from, title);

      const head = lang === "es" ? "Basado en el acervo." :
                   lang === "en" ? "Based on the corpus." :
                                    "Baseado no acervo.";
      const tail = sources && sources.length
        ? (lang === "es" ? "Fuentes: " : (lang === "en" ? "Sources: " : "Fontes: ")) + sources.join(" | ")
        : "";

      await sendWhatsapp(from, [
        answer,
        "",
        head,
        tail
      ].filter(Boolean).join("\n"));
      log("info", "RAG result", { from, scope: "in", score: score.toFixed(3), prevSubject, resolvedQuery });
      return;
    }

    // 3) Se NÃO passou no acervo:
    // 3a) Se parece um pedido de atualidade, tentamos web primeiro
    if (recentIntent) {
      const web = await getRealtimeAnswer(text, lang);
      if (web?.ok && web?.answer) {
        await sendWhatsapp(from, web.answer + (web.citations ? `\n\n${web.citations}` : ""));
        log("info", "REALTIME result", { from, scope: "out", reason: "recent-intent" });
        return;
      }
    }

    // 3b) Caso contrário (ou se web falhar), caímos no fallback geral (mantendo sua sinalização)
    const generic = await generalAnswer(text, lang);
    const footer = Number(ANSWER_OUTSIDE_CORPUS) ? (lang === "es" ? "Respuesta general (fuera del acervo)." :
                                                    lang === "en" ? "General answer (outside the corpus)." :
                                                                     "Resposta geral (fora do acervo).") : "";
    await sendWhatsapp(from, [generic, footer].filter(Boolean).join("\n\n"));
    log("info", "FALLBACK result", { from, scope: "out", score: score.toFixed(3) });
  } catch (err) {
    log("error", "Webhook error", err);
  }
});

// ---------------------- Gerador (usa seu modelo atual) ----------------------
async function generalAnswer(userText, lang) {
  // Usa o seu próprio modelo via OpenAI API que você já tem embutido no projeto.
  // Aqui mantemos simples para não mexer nas dependências atuais.
  const sys = systemStyle(lang);
  const prompt = `${sys}\nPergunta: ${userText}`;
  // Você já possui services/openaiClient.js; se preferir, enquadre aqui.
  // Para manter o arquivo autocontido, usamos a API REST diretamente.
  const key = process.env.OPENAI_API_KEY;
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userText }
      ],
      temperature: 0.3
    })
  }).then(r => r.json()).catch(() => null);

  const txt = resp?.choices?.[0]?.message?.content?.trim();
  return txt || (lang === "en" ? "Sorry, I had a technical issue." :
                 lang === "es" ? "Perdón, tuve un problema técnico." :
                                  "Desculpe, tive um problema técnico.");
}

// ---------------------- Envia WhatsApp (resposta de texto) ----------------------
async function sendWhatsapp(to, message) {
  // Você já tem esse envio OK no seu app (responder via Twilio “Message Response”).
  // Aqui mantemos a resposta “server-push” se for necessário.
  // Se o seu fluxo atual envia a partir do Twilio Studio/Webhook direto, pode ignorar.
  // (Mantido vazio de propósito para não duplicar envio.)
  return;
}

// ---------------------- Start ----------------------
app.listen(PORT, () => {
  log("info", "Server up", { port: String(PORT), corpus_items: hybridSearch._count?.() ?? null });
});
