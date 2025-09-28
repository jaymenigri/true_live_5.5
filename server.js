import express from "express";
import { sendWhatsApp } from "./services/twilioClient.js";
import { detectLang } from "./utils/lang.js";
import { chunkMessage } from "./utils/chunk.js";
import { classifyScope, retrieveContext, listFontes } from "./services/rag.js";
import { generateResponseWithHistory, transcribeAudio } from "./services/openaiClient.js";
import { fetchTwilioMedia } from "./services/audio.js";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const {
  ADMIN_TOKEN,
  TWILIO_WHATSAPP_FROM,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN
} = process.env;

/* ===== Memória e limites ===== */
const SESSIONS = new Map(); // key: whatsapp:+<number> ; value: { msgs: [...], last: epoch_ms, countDay: {day, count} }
function now() { return Date.now(); }
function yyyymmdd() { const d = new Date(); return d.toISOString().slice(0,10); }
function pruneOldSessions() {
  const DAY = 24 * 60 * 60 * 1000;
  const cutoff = now() - DAY;
  for (const [k, v] of SESSIONS.entries()) if ((v.last || 0) < cutoff) SESSIONS.delete(k);
}
function getHistory(key) {
  pruneOldSessions();
  return (SESSIONS.get(key)?.msgs) || [];
}
function pushHistory(key, role, content) {
  const s = SESSIONS.get(key) || { msgs: [], last: 0, countDay: { day: yyyymmdd(), count: 0 } };
  const arr = s.msgs.concat([{ role, content }]).slice(-10); // 5 turns
  s.msgs = arr; s.last = now();
  SESSIONS.set(key, s);
}
function incCount(key) {
  const s = SESSIONS.get(key) || { msgs: [], last: 0, countDay: { day: yyyymmdd(), count: 0 } };
  const today = yyyymmdd();
  if ((s.countDay?.day) !== today) s.countDay = { day: today, count: 0 };
  s.countDay.count += 1;
  s.last = now();
  SESSIONS.set(key, s);
  return s.countDay.count;
}
const DAILY_CAP = 150;

function systemPrompt(lang, scope) {
  const intro =
    lang === "es"
      ? "Eres True Live, un asistente de IA en WhatsApp que responde de forma factual sobre Israel, judaísmo, sionismo y antisemitismo."
      : lang === "en"
        ? "You are True Live, a WhatsApp AI assistant that answers factually about Israel, Judaism, Zionism, and antisemitism."
        : lang === "he"
          ? "אתה True Live, עוזר AI ב-WhatsApp העונה בצורה עובדתית על ישראל, יהדות, ציונות ואנטישמיות."
          : "Você é o True Live, um assistente de IA no WhatsApp que responde de forma factual sobre Israel, judaísmo, sionismo e antissemitismo.";

  const base = `${intro}
- Sempre que possível (cuando sea posible / whenever possible), baseie-se nas fontes confiáveis do acervo (citando nomes/títulos e datas quando houver no contexto).
- Se a pergunta estiver fora de escopo OU se não houver contexto suficiente, entregue a melhor resposta possível e deixe claro que não veio do acervo.
- Responda no mesmo idioma do usuário (${lang}).
- Seja direto, preciso e educado. Evite opiniões partidárias; foque em fatos.`;
  return base + (scope === "in" ? "\n(Pergunta classificada como DENTRO do domínio.)" : "\n(Pergunta classificada como FORA/INDEFINIDA.)");
}

// Health
app.get("/", (req, res) => res.send("True Live – WhatsApp bot is running."));
app.get("/admin/health", (req, res) => {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
  res.json({
    ok:true,
    status:"healthy",
    from: TWILIO_WHATSAPP_FROM || null,
    sessions: SESSIONS.size
  });
});
app.get("/admin/sources", (req, res) => {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
  res.json({ ok:true, count: listFontes().length, fontes: listFontes() });
});

// Twilio WhatsApp webhook
app.post("/twilio/whatsapp", async (req, res) => {
  try {
    const from = (req.body.From || "").trim();         // whatsapp:+<number>
    const body = (req.body.Body || "").trim();
    const numMedia = Number(req.body.NumMedia || 0);
    const lang = detectLang(body);
    const scope = classifyScope(body);

    // Rate limit per user
    const used = incCount(from);
    if (used > DAILY_CAP) {
      const msg =
        lang === "es" ? "⛔ Límite diario alcanzado. Vuelve mañana." :
        lang === "en" ? "⛔ Daily limit reached. Please try again tomorrow." :
        lang === "he" ? "⛔ הגעת למכסה היומית. נסה מחר." :
        "⛔ Limite diário atingido. Tente novamente amanhã.";
      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`;
      res.set("Content-Type", "application/xml").status(200).send(twiml);
      return;
    }

    // ACK imediato
    const ack =
      lang === "es" ? "✅ Recibido, pensando…" :
      lang === "en" ? "✅ Received, thinking…" :
      lang === "he" ? "✅ קיבלתי, חושב…" :
      "✅ Recebido, pensando…";
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${ack}</Message></Response>`;
    res.set("Content-Type", "application/xml").status(200).send(twiml);

    // Se vier áudio, tentar transcrever
    let userText = body;
    if (numMedia > 0 && req.body.MediaUrl0) {
      try {
        const buf = await fetchTwilioMedia(req.body.MediaUrl0, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        const txt = await transcribeAudio(buf, "audio.ogg");
        if (txt) userText = txt;
      } catch (e) {
        console.error("Audio transcription failed:", e?.message);
      }
    }

    // RAG catálogo
    let ctxChunks = [];
    let basedOnCorpus = false;
    if (scope === "in") {
      const { chunks, ratio } = retrieveContext(userText, 6);
      ctxChunks = chunks;
      basedOnCorpus = ratio >= 0.5; // limiar
    }

    // History
    const hist = getHistory(from);

    // Compose final response
    const finalText = await generateResponseWithHistory(
      systemPrompt(lang, scope),
      hist,
      userText,
      ctxChunks
    );

    // Append fontes list / label
    const fontesList = Array.from(new Set((ctxChunks || []).map(c => c.source))).slice(0,6);
    const label =
      basedOnCorpus
        ? (lang === "es" ? "Basado en el acervo." : (lang === "en" ? "Based on the corpus." : (lang === "he" ? "מבוסס מאגר." : "Baseado no acervo.")))
        : (lang === "es" ? "Respuesta fuera del acervo." : (lang === "en" ? "Answer outside corpus." : (lang === "he" ? "תשובה מחוץ למאגר." : "Resposta fora do acervo.")));

    const fontesBlock = fontesList.length
      ? "\n\nFontes: " + fontesList.join(" | ")
      : "";

    const toSend = finalText + "\n\n" + label + fontesBlock;

    // Save history and send
    pushHistory(from, "user", userText);
    pushHistory(from, "assistant", toSend);

    const chunks = chunkMessage(toSend, 1500);
    for (const part of chunks) {
      await sendWhatsApp(from, part);
    }
  } catch (err) {
    console.error("Webhook error:", err);
    // Twilio already got 200/TwiML
  }
});

// Admin manual send
app.post("/admin/send", async (req, res) => {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
  const { to, body } = req.body || {};
  if (!to || !body) return res.status(400).json({ ok:false, error:"missing to/body" });
  try {
    const r = await sendWhatsApp(to, body);
    res.json({ ok:true, sid: r.sid });
  } catch (e) {
    console.error("Admin send error:", e);
    res.status(500).json({ ok:false, error:"twilio send failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("True Live server listening on port", port, "from", TWILIO_WHATSAPP_FROM || "n/a");
});
