// server.js — True Live v2.6 (final)
// - Webhook do WhatsApp (Twilio) + RAG híbrido
// - Fallback garantido fora do acervo
// - Health/admin com contagem do corpus
// - Logs informativos (sem precisar terminal)

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { search as ragSearch, corpusSize } from "./services/hybridRag.js";

// --------------------------
// Config
// --------------------------
const {
  PORT = 3000,
  ADMIN_TOKEN = "truelive2025",
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  RAG_THRESHOLD = "0.5",
} = process.env;

if (!OPENAI_API_KEY) console.warn("[WARN] OPENAI_API_KEY ausente.");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
  console.warn("[WARN] Variáveis do Twilio ausentes (ACK/Respostas podem falhar).");
}

// --------------------------
// Helpers: Twilio e OpenAI
// --------------------------
async function twilioSendText(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) return;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams();
  form.set("From", TWILIO_WHATSAPP_FROM);
  form.set("To", to);
  form.set("Body", body);

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form
  }).catch(() => {});
}

async function openaiChat(messages) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages
    })
  });
  const data = await resp.json();
  const txt = data?.choices?.[0]?.message?.content?.trim();
  if (!txt) throw new Error("OpenAI empty");
  return txt;
}

// Detecção simples de idioma
function detectLang(s) {
  const hasPt = /[áéíóúãõâêôç]/i.test(s) || /\b(que|quem|onde|qual|como|porque|pra|para|sobre)\b/i.test(s);
  const hasEs = /\b(que|quién|dónde|cuál|cómo|por qué|para|sobre)\b/i.test(s);
  if (hasPt) return "pt";
  if (hasEs) return "es";
  return "en";
}

// Prompts de geração
async function generateFromCorpus(query, snippets, lang = "pt") {
  const ctx = snippets.map((s, i) => `[${i+1}] ${s.text}`).join("\n");
  const sys =
    "Você é um assistente claro e objetivo. Responda SÓ com base nos trechos fornecidos. Não invente fatos que não estejam nos trechos.";
  const usr =
    `Pergunta: ${query}\n\nTrechos do acervo:\n${ctx}\n\nEscreva uma resposta direta e curta.`;

  const messages = [
    { role: "system", content: sys },
    { role: "user", content: usr }
  ];
  return await openaiChat(messages);
}

async function generateFallback(query, lang = "pt") {
  const sys =
    "Você é um assistente educado. Responda de forma direta e útil. Quando possível, explique em uma frase.";
  const usr = query;
  const messages = [
    { role: "system", content: sys },
    { role: "user", content: usr }
  ];
  return await openaiChat(messages);
}

// --------------------------
// App
// --------------------------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health/Admin
app.get("/admin/health", (req, res) => {
  const token = req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ status: "unauthorized" });
  return res.json({ status: "ok", corpus_items: corpusSize() });
});

// Opcional: raiz
app.get("/", (_req, res) => res.send("True Live up"));

// Webhook do WhatsApp (Twilio)
app.post("/twilio/whatsapp", async (req, res) => {
  // Retorne 200 imediatamente para o Twilio
  res.status(200).send("");

  try {
    const from = (req.body.From || "").trim();         // ex: whatsapp:+55...
    const body = (req.body.Body || "").trim();
    if (!from || !body) return;

    // ACK ao usuário (opcional)
    await twilioSendText(from, "✅ Received, thinking...");

    const lang = detectLang(body);
    const threshold = parseFloat(RAG_THRESHOLD);

    // histórico simples: última entidade “lembrada” por este número (in-memory)
    // (para produção, trocar por Redis/DB; aqui é suficiente para seguir conversa)
    globalThis.__TL_SUBJECTS__ = globalThis.__TL_SUBJECTS__ || {};
    const prevSubject = globalThis.__TL_SUBJECTS__[from] || null;

    // RAG
    const resRag = await ragSearch({
      query: body,
      threshold,
      prevSubject,
      lang
    });

    console.info("[INFO] RAG result", {
      from,
      scope: resRag.scope,
      score: resRag.score?.toFixed?.(3),
      prevSubject: prevSubject || null,
      resolvedQuery: resRag.resolvedQuery
    });

    // Se pass=true, use RAG SEMPRE
    let text;
    if (resRag.pass) {
      // garante snippet (módulo já tem safety, mas reforçamos)
      let snippets = resRag.snippets || [];
      if (!snippets.length && resRag.topChunks?.length) {
        snippets = [{
          title: resRag.topChunks[0].title || "corpus",
          text: (resRag.topChunks[0].text || "").slice(0, 320),
          date: resRag.topChunks[0].date || "",
          score: resRag.topChunks[0].score ?? 0
        }];
      }

      const answer = await generateFromCorpus(resRag.resolvedQuery, snippets, lang);
      const sources = [...new Set(snippets.map(s => s.title).filter(Boolean))];
      const footer = lang.startsWith("pt")
        ? `\n\nBaseado no acervo.\nFontes: ${sources.join(" | ")}`
        : `\n\nBased on the corpus.\nSources: ${sources.join(" | ")}`;

      text = `${answer}${footer}`;

      // Atualiza “assunto” lembrado (primeiro título do topChunk)
      const newSubject = resRag.topChunks?.[0]?.title || null;
      if (newSubject) globalThis.__TL_SUBJECTS__[from] = newSubject;

    } else {
      const answer = await generateFallback(body, lang);
      const footer = lang.startsWith("pt")
        ? `\n\nResposta geral (fora do acervo).`
        : `\n\nGeneral answer (outside the curated corpus).`;
      text = `${answer}${footer}`;
      // zera assunto (fora do domínio/acervo)
      globalThis.__TL_SUBJECTS__[from] = null;
    }

    await twilioSendText(from, text);

  } catch (err) {
    console.error("[ERROR] webhook:", err?.message || err);
  }
});

// Start
const port = Number(PORT);
app.listen(port, () => {
  console.info(`[INFO] Server up { port: '${port}', corpus_items: ${corpusSize()} }`);
});
