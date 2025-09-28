// server.js — True Live v2.1.x (ESM)

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

const {
  ADMIN_TOKEN,
  TWILIO_WHATSAPP_FROM,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
} = process.env;

// ============ memória curta (24h) + rate limit ============
const SESSIONS = new Map();
const DAY = 24 * 60 * 60 * 1000;
const DAILY_CAP = 150;

function now() { return Date.now(); }
function ymd() { return new Date().toISOString().slice(0, 10); }
function prune() { const cut = now() - DAY; for (const [k, v] of SESSIONS) if ((v.last || 0) < cut) SESSIONS.delete(k); }
function histGet(k) { prune(); return SESSIONS.get(k)?.msgs || []; }
function histPush(k, role, content) {
  const s = SESSIONS.get(k) || { msgs: [], last: 0, countDay: { day: ymd(), count: 0 } };
  s.msgs = s.msgs.concat([{ role, content }]).slice(-10);
  s.last = now();
  SESSIONS.set(k, s);
}
function incCount(k) {
  const s = SESSIONS.get(k) || { msgs: [], last: 0, countDay: { day: ymd(), count: 0 } };
  const d = ymd();
  if (s.countDay.day !== d) s.countDay = { day: d, count: 0 };
  s.countDay.count++;
  s.last = now();
  SESSIONS.set(k, s);
  return s.countDay.count;
}

// ============ utilidades ============
function detectRecencyIntent(q) {
  const t = (q || "").toLowerCase();
  return /(hoje|agora|últimas|últimos|recentes|today|now|latest|recent)/.test(t);
}

function systemPrompt(lang, scope) {
  const intro =
    lang === "es" ? "Eres True Live, un asistente de IA en WhatsApp que responde de forma factual sobre Israel, judaísmo, sionismo y antisemitismo."
    : lang === "en" ? "You are True Live, a WhatsApp AI assistant that answers factually about Israel, Judaism, Zionism, and antisemitism."
    : lang === "he" ? "אתה True Live, עוזר AI ב-WhatsApp העונה בצורה עובדתית על ישראל, יהדות, ציונות ואנטישמיות."
    : "Você é o True Live, um assistente de IA no WhatsApp que responde de forma factual sobre Israel, judaísmo, sionismo e antissemitismo.";

  return `${intro}
- Sempre que possível, baseie-se nas fontes confiáveis do acervo (citando nomes/títulos e datas quando houver no contexto).
- Se estiver fora de escopo ou sem contexto suficiente, responda claramente e marque como fora do acervo.
- Responda no mesmo idioma do usuário (${lang}).
- Seja direto, preciso e educado; foque em fatos.
${scope === "in" ? "(Pergunta classificada como DENTRO do domínio.)" : "(Pergunta classificada como FORA/INDEFINIDA.)"}`;
}

// ============ rotas públicas ============
app.get("/", (_req, res) => res.send("True Live v2.1 running."));
app.get("/health", (_req, res) => res.send("ok"));

// ============ rotas admin ============
app.get("/admin/health", (req, res) => {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });
  res.json({ ok: true, from: TWILIO_WHATSAPP_FROM || null, sessions: SESSIONS.size });
});
app.post("/admin/health", (req, res) => {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });
  res.json({ ok: true, from: TWILIO_WHATSAPP_FROM || null, sessions: SESSIONS.size });
});

// ingestão (GET e POST)
async function handleIngestRun(req, res) {
  try {
    const token = req.headers["x-admin-token"] || req.query.token;
    if (token !== ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const mode = (req.query.mode || "rss,sitemap")
      .split(",")
      .map(s => s.trim().toLowerCase());
    const out = {};
    if (mode.includes("rss")) out.rss = await ingestRSS();
    if (mode.includes("sitemap")) out.sitemap = await ingestSitemap();
    return res.json({ ok: true, result: out });
  } catch (e) {
    console.error("ingest/run error:", e);
    return res.status(500).json({ ok: false, error: "ingest-failed" });
  }
}
app.post("/admin/ingest/run", handleIngestRun);
app.get("/admin/ingest/run", handleIngestRun);

// ============ webhook Twilio/WhatsApp ============
app.post("/twilio/whatsapp", async (req, res) => {
  try {
    const from = (req.body.From || "").trim();
    const body = (req.body.Body || "").trim();
    const numMedia = Number(req.body.NumMedia || 0);
    const mediaType = (req.body.MediaContentType0 || "").toLowerCase();

    const lang = detectLang(body);
    const scope = classifyScope(body);

    // rate limit diário
    const used = incCount(from);
    if (used > DAILY_CAP) {
      const msg =
        lang === "es" ? "⛔ Límite diario alcanzado. Vuelve mañana."
        : lang === "en" ? "⛔ Daily limit reached. Please try again tomorrow."
        : lang === "he" ? "⛔ הגעת למכסה היומית. נסה מחר."
        : "⛔ Limite diário atingido. Tente novamente amanhã.";
      res.set("Content-Type", "application/xml")
        .status(200)
        .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`);
      return;
    }

    // ACK imediato (WhatsApp UX)
    const ack =
      lang === "es" ? "✅ Recibido, pensando…"
      : lang === "en" ? "✅ Received, thinking…"
      : lang === "he" ? "✅ קיבלתי, חושב…"
      : "✅ Recebido, pensando…";
    res.set("Content-Type", "application/xml")
      .status(200)
      .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${ack}</Message></Response>`);

    // — transcrição de áudio (se não houver texto)
    let userText = body;
    if (!userText && numMedia > 0 && req.body.MediaUrl0) {
      try {
        const buf = await fetchTwilioMedia(req.body.MediaUrl0, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        const txt = await transcribeAudio(buf, { basename: "voice", contentType: mediaType || "audio/ogg" });
        if (txt) userText = txt;
      } catch (e) {
        console.error("Audio transcription failed:", e?.message || e);
        userText =
          lang === "es" ? "(No pude transcribir el audio.)"
          : lang === "en" ? "(I couldn't transcribe the audio.)"
          : lang === "he" ? "(לא הצלחתי לתמלל את האודיו.)"
          : "(Não consegui transcrever o áudio.)";
      }
    }

    // — RAG (só tenta se escopo = in)
    let ctx = { chunks: [], pass: false, chunksPassing: [] };
    if (scope === "in") ctx = await retrieveHybrid(userText, 6, detectRecencyIntent(userText));

    // — geração
    const hist = histGet(from);
    let reply;
    let fontesList = [];

    if (ctx.pass) {
      // com acervo
      const chosen = ctx.chunksPassing;
      reply = await generateResponseWithHistory(
        systemPrompt(lang, scope),
        hist,
        userText,
        chosen
      );
      fontesList = Array.from(new Set(chosen.map(c =>
        `${c.source}${c.date ? " " + c.date : ""}`
      ))).slice(0, 6);
    } else {
      // fallback controlado (modelo geral, sem chunks)
      reply = await generateResponseWithHistory(
        systemPrompt(lang, "out"),
        hist,
        userText,
        []
      );
    }

    // — rótulo e fontes (um OU outro, sem duplicar)
    const label = ctx.pass
      ? (lang === "es" ? "Basado en el acervo." : (lang === "en" ? "Based on the corpus." : (lang === "he" ? "מבוסס מאגר." : "Baseado no acervo.")))
      : (lang === "es" ? "Respuesta fuera del acervo." : (lang === "en" ? "Answer outside corpus." : (lang === "he" ? "תשובה מחוץ למאגר." : "Resposta fora do acervo.")));

    const fontesBlock = ctx.pass && fontesList.length ? "\n\nFontes: " + fontesList.join(" | ") : "";
    const toSend = reply + "\n\n" + label + fontesBlock;

    // — grava histórico e envia em blocos
    histPush(from, "user", userText);
    histPush(from, "assistant", toSend);

    for (const part of chunkMessage(toSend, 1500)) {
      await sendWhatsApp(from, part);
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

// ============ start ============
const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log("True Live listening on", port, "from", TWILIO_WHATSAPP_FROM || "n/a")
);
