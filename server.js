import express from "express";
import { sendWhatsApp } from "./services/twilioClient.js";
import { detectLang } from "./utils/lang.js";
import { chunkMessage } from "./utils/chunk.js";
import { classifyScope, retrieveContext } from "./services/rag.js";
import { generateResponse } from "./services/openaiClient.js";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const {
  ADMIN_TOKEN,
  TWILIO_WHATSAPP_FROM
} = process.env;

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

  return base + (scope === "in"
    ? "\n(Pergunta classificada como DENTRO do domínio.)"
    : "\n(Pergunta classificada como FORA/INDEFINIDA.)");
}

// Health
app.get("/", (req, res) => res.send("True Live – WhatsApp bot is running."));

// Minimal admin check route
app.get("/admin/health", (req, res) => {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
  res.json({ ok:true, status:"healthy", from: process.env.TWILIO_WHATSAPP_FROM || null });
});

// Twilio WhatsApp webhook
app.post("/twilio/whatsapp", async (req, res) => {
  try {
    const from = req.body.From;         // whatsapp:+<number>
    const body = (req.body.Body || "").trim();
    const lang = detectLang(body);
    const scope = classifyScope(body);

    // ACK imediato via TwiML
    const ack =
      lang === "es" ? "✅ Recibido, pensando…" :
      lang === "en" ? "✅ Received, thinking…" :
      lang === "he" ? "✅ קיבלתי, חושב…" :
      "✅ Recebido, pensando…";

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${ack}</Message></Response>`;
    res.set("Content-Type", "application/xml").status(200).send(twiml);

    // Assíncrono: gerar resposta final e enviar pelo REST API
    const ctx = scope === "in" ? retrieveContext(body) : [];
    const finalText = await generateResponse(systemPrompt(lang, scope), body, ctx);

    const chunks = chunkMessage(finalText, 1500);
    for (const part of chunks) {
      await sendWhatsApp(from, part);
    }
  } catch (err) {
    console.error("Webhook error:", err);
    // Twilio já recebeu 200/TwiML; só logamos.
  }
});

// OPTIONAL: simple route to test message sending (requires ADMIN_TOKEN)
app.post("/admin/send", async (req, res) => {
  const token = req.headers["x-admin-token"];
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
