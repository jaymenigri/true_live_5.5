// server.js — True Live v2.2.0 (ESM)

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
  // controle de fora de escopo (opcionais)
  OFFTOPIC_MAX,
  OFFTOPIC_COOLDOWN_MIN,
  ANSWER_OUTSIDE_CORPUS_FIRST_N
} = process.env;

// ===== Memória curta (24h) + rate limit simples =====
const SESSIONS = new Map();
const DAY = 24 * 60 * 60 * 1000;
const DAILY_CAP = 150;

function now() { return Date.now(); }
function ymd() { return new Date().toISOString().slice(0, 10); }
function prune() { const cut = now() - DAY; for (const [k, v] of SESSIONS) if ((v.last || 0) < cut) SESSIONS.delete(k); }
function histGet(k) { prune(); return SESSIONS.get(k)?.msgs || []; }
function histPush(k, role, content) {
  const s = SESSIONS.get(k) || { msgs: [], last: 0, countDay: { day: ymd(), count: 0 }, off: { streak: 0, since: 0, cooldownUntil: 0, outsGiven: 0 } };
  s.msgs = s.msgs.concat([{ role, content }]).slice(-10);
  s.last = now();
  SESSIONS.set(k, s);
}
function incCount(k) {
  const s = SESSIONS.get(k) || { msgs: [], last: 0, countDay: { day: ymd(), count: 0 }, off: { streak: 0, since: 0, cooldownUntil: 0, outsGiven: 0 } };
  const d = ymd();
  if (s.countDay.day !== d) s.countDay = { day: d, count: 0 };
  s.countDay.count++;
  s.last = now();
  SESSIONS.set(k, s);
  return s.countDay.count;
}
function sessionGet(id) {
  prune();
  return SESSIONS.get(id) || { msgs: [], last: 0, countDay: { day: ymd(), count: 0 }, off: { streak: 0, since: 0, cooldownUntil: 0, outsGiven: 0 } };
}
function sessionSet(id, s) { s.last = now(); SESSIONS.set(id, s); }

// ===== Off-topic manager (configurável por env) =====
const OFF_MAX = Number(OFFTOPIC_MAX || "3");                 // quantas fora de escopo seguidas até cooldown
const OFF_COOLDOWN_MIN = Number(OFFTOPIC_COOLDOWN_MIN || "15");
const ALLOW_OUTSIDE_FIRST_N = Number(ANSWER_OUTSIDE_CORPUS_FIRST_N || "0"); // ex.: 0 = nunca responder fora de escopo

function updateOffTopic(id, isInScope) {
  const s = sessionGet(id);
  if (isInScope) {
    s.off.streak = 0;
    s.off.since = 0;
    s.off.cooldownUntil = 0;
  } else {
    const t = now();
    s.off.streak += 1;
    if (!s.off.since) s.off.since = t;
    if (s.off.streak >= OFF_MAX) {
      s.off.cooldownUntil = t + OFF_COOLDOWN_MIN * 60 * 1000;
    }
  }
  sessionSet(id, s);
  return s.off;
}
function isInCooldown(id) {
  const s = sessionGet(id);
  return s.off.cooldownUntil && now() < s.off.cooldownUntil;
}

// ===== Utils =====
function detectRecencyIntent(q) {
  const t = (q || "").toLowerCase();
  return /(hoje|agora|últimas|últimos|recentes|today|now|latest|recent)/.test(t);
}

// System prompt — não deixar o modelo escrever rótulos/Fontes
function systemPrompt(lang, scope) {
  const intro =
    lang === "es" ? "Eres True Live, un asistente de IA en WhatsApp que responde de forma factual sobre Israel, judaísmo, sionismo y antisemitismo."
    : lang === "en" ? "You are True Live, a WhatsApp AI assistant that answers factually about Israel, Judaism, Zionism, and antisemitism."
    : lang === "he" ? "אתה True Live, עוזר AI ב-WhatsApp העונה בצורה עובדתית על ישראל, יהדות, ציונות ואנטישמיות."
    : "Você é o True Live, um assistente de IA no WhatsApp que responde de forma factual sobre Israel, judaísmo, sionismo e antissemitismo.";

  return `${intro}
- Responda no MESMO idioma do usuário (${lang}).
- Seja direto, claro e baseado em fatos.
- Quando houver contexto (trechos fornecidos), use apenas essas informações para responder.
- MUITO IMPORTANTE: **NÃO** inclua rótulos como "Baseado no acervo", "Resposta fora do acervo" nem uma seção "Fontes:" na sua resposta. O servidor adicionará isso depois, se necessário.
- Não repita as instruções; responda apenas ao que foi perguntado.
${scope === "in" ? "(Pergunta classificada como DENTRO do domínio.)" : "(Pergunta classificada como FORA/INDEFINIDA.)"}`;
}

// Limpa QUALQUER rodapé que o modelo tente colar (PT/EN/ES/HE)
function cleanModelFooter(txt) {
  if (!txt) return txt;
  return txt
    .replace(/^\s*(Based on the corpus\.?|Answer outside corpus\.?)\s*$/gim, "")
    .replace(/^\s*(Basado en el acervo\.?|Respuesta fuera del acervo\.?)\s*$/gim, "")
    .replace(/^\s*(Baseado no acervo\.?|Resposta fora do acervo\.?)\s*$/gim, "")
    .replace(/^\s*(מבוסס מאגר\.?|תשובה מחוץ למאגר\.?)\s*$/gim, "")
    .replace(/^\s*(Fontes?|Fuentes?|Sources?):.*$/gim, "")
    .trim();
}

// ===== Rotas públicas =====
app.get("/", (_req, res) => res.send("True Live v2.2.0 running."));
app.get("/health", (_req, res) => res.send("ok"));

// ===== Rotas admin =====
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

// Ingest (GET/POST)
async function handleIngestRun(req, res) {
  try {
    const token = req.headers["x-admin-token"] || req.query.token;
    if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });
    const mode = (req.query.mode || "rss,sitemap").split(",").map(s => s.trim().toLowerCase());
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

// ===== Webhook Twilio/WhatsApp =====
app.post("/twilio/whatsapp", async (req, res) => {
  try {
    const from = (req.body.From || "").trim();
    const body = (req.body.Body || "").trim();
    const numMedia = Number(req.body.NumMedia || 0);
    const mediaType = (req.body.MediaContentType0 || "").toLowerCase();

    const lang = detectLang(body);
    const scope = classifyScope(body);

    // Rate limit diário
    const used = incCount(from);
    if (used > DAILY_CAP) {
      const msg =
        lang === "es" ? "⛔ Límite diario alcanzado. Vuelve mañana."
        : lang === "en" ? "⛔ Daily limit reached. Please try again tomorrow."
        : lang === "he" ? "⛔ הגעת למכסה היומית. נסה מחר."
        : "⛔ Limite diário atingido. Tente novamente amanhã.";
      res.set("Content-Type", "application/xml").status(200)
        .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`);
      return;
    }

    // ACK imediato
    const ack =
      lang === "es" ? "✅ Recibido, pensando…"
      : lang === "en" ? "✅ Received, thinking…"
      : lang === "he" ? "✅ קיבלתי, חושב…"
      : "✅ Recebido, pensando…";
    res.set("Content-Type", "application/xml").status(200)
      .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${ack}</Message></Response>`);

    // ===== Off-topic manager =====
    const raw = (body || "").trim().toLowerCase();
    const isCommand = /^\/(help|start|lang|idioma)$/.test(raw) || raw === "ping";
    const off = updateOffTopic(from, scope === "in" || isCommand);

    if (!isCommand && scope !== "in" && isInCooldown(from)) {
      const msg =
        lang === "es" ? "⏳ Estoy en pausa porque tus últimos mensajes estaban fuera del tema. Vuelve con una pregunta sobre Israel, judaísmo, sionismo o antisemitismo."
        : lang === "en" ? "⏳ Paused because your recent messages were off-topic. Ask about Israel, Judaism, Zionism, or antisemitism to continue."
        : lang === "he" ? "⏳ מושבת זמנית כי ההודעות האחרונות לא היו בנושא. שאל על ישראל, יהדות, ציונות או אנטישמיות כדי להמשיך."
        : "⏳ Pausado porque suas últimas mensagens estavam fora do tema. Faça uma pergunta sobre Israel, judaísmo, sionismo ou antissemitismo para continuar.";
      await sendWhatsApp(from, msg);
      return;
    }

    if (!isCommand && scope !== "in") {
      if (off.streak === 1) {
        const n =
          lang === "es" ? "Meu foco é Israel, judaísmo, sionismo y antisemitismo. Posso ajudar com esses temas! 🙂"
          : lang === "en" ? "My focus is Israel, Judaism, Zionism, and antisemitism. Happy to help with those! 🙂"
          : lang === "he" ? "התחום שלי הוא ישראל, יהדות, ציונות ואנטישמיות. אשמח לעזור בזה! 🙂"
          : "Meu foco é Israel, judaísmo, sionismo e antissemitismo. Posso ajudar com esses temas! 🙂";
        await sendWhatsApp(from, n);
      } else if (off.streak === 2) {
        const n =
          lang === "es" ? "Ejemplos: • ¿Quién fue Golda Meir? • ¿Qué es la IHRA? • ¿Qué ocurrió en Yom Kipur 1973?"
          : lang === "en" ? "Examples: • Who was Golda Meir? • What is the IHRA? • What happened in the 1973 Yom Kippur War?"
          : lang === "he" ? "דוגמאות: • מי הייתה גולדה מאיר? • מהי IHRA? • מה קרה במלחמת יום הכיפורים 1973?"
          : "Exemplos: • Quem foi Golda Meir? • O que é a IHRA? • O que aconteceu na Guerra do Yom Kipur (1973)?";
        await sendWhatsApp(from, n);
      }

      // política de responder fora do escopo (controlada por env)
      const s = sessionGet(from);
      const allow = s.off.outsGiven < ALLOW_OUTSIDE_FIRST_N;
      if (!allow) {
        const msg =
          lang === "es" ? "Esta pregunta está fuera del ámbito del servicio. ¿Quieres sugerencias de temas dentro del ámbito?"
          : lang === "en" ? "This question is outside the service scope. Want suggestions for in-scope topics?"
          : lang === "he" ? "השאלה מחוץ לתחום השירות. רוצה שאציע נושאים רלוונטיים?"
          : "Esta pergunta está fora do escopo do serviço. Quer sugestões de temas dentro do escopo?";
        await sendWhatsApp(from, msg);
        return;
      }
      s.off.outsGiven = (s.off.outsGiven || 0) + 1;
      sessionSet(from, s);
      // segue fluxo, mas cairá no fallback ao final
    }

    // ===== Áudio (se não houver texto) =====
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

    // ===== RAG =====
    let ctx = { chunks: [], pass: false, chunksPassing: [] };
    if (scope === "in") ctx = await retrieveHybrid(userText, 6, detectRecencyIntent(userText));

    // ===== Geração =====
    const hist = histGet(from);
    let reply;
    let fontesList = [];

    if (ctx.pass) {
      // com acervo
      const chosen = ctx.chunksPassing;
      reply = await generateResponseWithHistory(systemPrompt(lang, scope), hist, userText, chosen);
      reply = cleanModelFooter(reply);
      fontesList = Array.from(new Set(chosen.map(c => `${c.source}${c.date ? " " + c.date : ""}`))).slice(0, 6);
    } else {
      // fallback controlado (sem chunks) — útil mesmo quando a pessoa citada não estiver no acervo
      const fallbackPrompt =
        lang === "es" ? `Si no encuentras información sobre la persona específica mencionada, dilo en una línea y enseguida responde el tema de fondo con hechos y definiciones fiables (por ejemplo, definición jurídica de genocidio, definición de la IHRA). No agregues etiquetas ni "Fuentes:".`
        : lang === "en" ? `If you can't find information about the specific person mentioned, say so in one short line and then answer the underlying topic with reliable facts (e.g., legal definition of genocide, IHRA definition). Do not add labels or "Sources:".`
        : lang === "he" ? `אם אין מידע על האדם שהוזכר, אמור זאת במשפט קצר ואז הסבר את הנושא הכללי בעובדות אמינות (למשל הגדרה משפטית של רצח עם, IHRA). אל תוסיף תוויות או "מקורות:".`
        : `Se não houver informação sobre a pessoa específica citada, diga isso em uma linha e em seguida responda o tema da pergunta com fatos confiáveis (ex.: definição jurídica de genocídio, definição da IHRA). Não inclua rótulos nem "Fontes:".`;

      reply = await generateResponseWithHistory(systemPrompt(lang, "out") + "\n\n" + fallbackPrompt, hist, userText, []);
      reply = cleanModelFooter(reply);
    }

    const label = ctx.pass
      ? (lang === "es" ? "Basado en el acervo." : (lang === "en" ? "Based on the corpus." : (lang === "he" ? "מבוסס מאגר." : "Baseado no acervo.")))
      : (lang === "es" ? "Respuesta fuera del acervo." : (lang === "en" ? "Answer outside corpus." : (lang === "he" ? "תשובה מחוץ למאגר." : "Resposta fora do acervo.")));

    const fontesBlock = ctx.pass && fontesList.length ? "\n\nFontes: " + fontesList.join(" | ") : "";
    const toSend = (reply || "").trim() + "\n\n" + label + fontesBlock;

    // histórico + envio
    histPush(from, "user", userText);
    histPush(from, "assistant", toSend);

    for (const part of chunkMessage(toSend, 1500)) {
      await sendWhatsApp(from, part);
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

// ===== Start =====
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("True Live listening on", port, "from", TWILIO_WHATSAPP_FROM || "n/a");
});
