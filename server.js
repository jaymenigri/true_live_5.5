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
const SESSIONS = new Map(); // key: whatsapp:+<number> ; value: { msgs: [...], last, countDay }
function now() { return Date.now(); }
function ymd() { return new Date().toISOString().slice(0,10); }
function prune() {
  const day = 24*60*60*1000, cut = now()-day;
  for (const [k,v] of SESSIONS) if ((v.last||0)<cut) SESSIONS.delete(k);
}
function histGet(k){ prune(); return SESSIONS.get(k)?.msgs || []; }
function histPush(k, role, content){
  const s = SESSIONS.get(k) || { msgs: [], last: 0, countDay: { day: ymd(), count: 0 } };
  s.msgs = s.msgs.concat([{ role, content }]).slice(-10);
  s.last = now();
  SESSIONS.set(k, s);
}
function incCount(k){
  const s = SESSIONS.get(k) || { msgs: [], last: 0, countDay: { day: ymd(), count: 0 } };
  const today = ymd();
  if (s.countDay.day !== today) s.countDay = { day: today, count: 0 };
  s.countDay.count += 1; s.last = now(); SESSIONS.set(k, s);
  return s.countDay.count;
}
const DAILY_CAP = 150;

function systemPrompt(lang, scope) {
  const intro =
    lang === "es" ? "Eres True Live, un asistente de IA en WhatsApp que responde de forma factual sobre Israel, judaísmo, sionismo y antisemitismo."
    : lang === "en" ? "You are True Live, a WhatsApp AI assistant that answers factually about Israel, Judaism, Zionism, and antisemitism."
    : lang === "he" ? "אתה True Live, עוזר AI ב-WhatsApp העונה בצורה עובדתית על ישראל, יהדות, ציונות ואנטישמיות."
    : "Você é o True Live, um assistente de IA no WhatsApp que responde de forma factual sobre Israel, judaísmo, sionismo e antissemitismo.";
  const base = `${intro}
- Sempre que possível (cuando sea posible / whenever possible), baseie-se nas fontes confiáveis do acervo (citando nomes/títulos e datas quando houver no contexto).
- Se a pergunta estiver fora de escopo OU se não houver contexto suficiente, entregue a melhor resposta possível e deixe claro que não veio do acervo.
- Responda no mesmo idioma do usuário (${lang}).
- Seja direto, preciso e educado. Evite opiniões partidárias; foque em fatos.`;
  return base + (scope === "in" ? "\n(Pergunta classificada como DENTRO do domínio.)" : "\n(Pergunta classificada como FORA/INDEFINIDA.)");
}

// Health & admin
app.get("/", (_req, res) => res.send("True Live – WhatsApp bot is running."));
app.get("/admin/health", (req, res) => {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
  res.json({ ok:true, from: TWILIO_WHATSAPP_FROM || null, sessions: SESSIONS.size });
});
app.get("/admin/sources", (req, res) => {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
  res.json({ ok:true, fontes: listFontes() });
});

// Webhook
app.post("/twilio/whatsapp", async (req, res) => {
  try {
    const from = (req.body.From || "").trim();
    const body = (req.body.Body || "").trim();
    const numMedia = Number(req.body.NumMedia || 0);
    const mediaType = (req.body.MediaContentType0 || "").toLowerCase(); // ex: audio/ogg;codecs=opus
    const lang = detectLang(body);
    const scope = classifyScope(body);

    // rate limit
    const used = incCount(from);
    if (used > DAILY_CAP) {
      const msg = lang === "es" ? "⛔ Límite diario alcanzado. Vuelve mañana."
                : lang === "en" ? "⛔ Daily limit reached. Please try again tomorrow."
                : lang === "he" ? "⛔ הגעת למכסה היומית. נסה מחר."
                : "⛔ Limite diário atingido. Tente novamente amanhã.";
      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`;
      res.set("Content-Type","application/xml").status(200).send(twiml);
      return;
    }

    // ACK
    const ack = lang === "es" ? "✅ Recibido, pensando…" :
                lang === "en" ? "✅ Received, thinking…" :
                lang === "he" ? "✅ קיבלתי, חושב…" :
                "✅ Recebido, pensando…";
    res.set("Content-Type","application/xml").status(200)
       .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${ack}</Message></Response>`);

    // Texto do usuário / transcrição
    let userText = body;
    if (!userText && numMedia > 0 && req.body.MediaUrl0) {
      try {
        const buf = await fetchTwilioMedia(req.body.MediaUrl0, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        const txt = await transcribeAudio(buf, { basename: "voice", contentType: mediaType || "audio/ogg" });
        if (txt) userText = txt;
      } catch (e) {
        console.error("Audio transcription failed:", e?.message || e);
        userText = lang === "es" ? "(No pude transcribir el audio.)"
                 : lang === "en" ? "(I couldn't transcribe the audio.)"
                 : lang === "he" ? "(לא הצלחתי לתמלל את האודיו.)"
                 : "(Não consegui transcrever o áudio.)";
      }
    }

    // RAG
    let ctxChunks = []; let basedOnCorpus = false;
    if (scope === "in") {
      const { chunks, ratio } = retrieveContext(userText, 6);
      ctxChunks = chunks; basedOnCorpus = ratio >= 0.5;
    }

    // histórico
    const hist = histGet(from);

    // resposta
    const finalText = await generateResponseWithHistory(
      systemPrompt(lang, scope),
      hist,
      userText,
      ctxChunks
    );

    const fontes = Array.from(new Set((ctxChunks || []).map(c => c.source))).slice(0,6);
    const label = basedOnCorpus
      ? (lang === "es" ? "Basado en el acervo." : (lang === "en" ? "Based on the corpus." : (lang === "he" ? "מבוסס מאגר." : "Baseado no acervo.")))
      : (lang === "es" ? "Respuesta fuera del acervo." : (lang === "en" ? "Answer outside corpus." : (lang === "he" ? "תשובה מחוץ למאגר." : "Resposta fora do acervo.")));
    const fontesBlock = fontes.length ? "\n\nFontes: " + fontes.join(" | ") : "";
    const toSend = finalText + "\n\n" + label + fontesBlock;

    // envia e guarda histórico
    histPush(from, "user", userText);
    histPush(from, "assistant", toSend);
    for (const part of chunkMessage(toSend, 1500)) await sendWhatsApp(from, part);
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

// admin send
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
