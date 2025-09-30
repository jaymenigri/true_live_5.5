import express from "express";
import bodyParser from "body-parser";
import { v4 as uuidv4 } from "uuid";

import { CONFIG } from "./config/appConfig.js";
import { detectLang } from "./utils/langDetect.js";
import { splitForWhatsApp } from "./utils/splitMessage.js";

import { sendWhatsApp } from "./services/twilioClient.js";
import { maybeTranscribeWhatsApp } from "./services/audio.js";
import { answerWithRAG } from "./services/hybridRag.js";
import { initMemory, readHistory, writeTurn } from "./services/memory.js";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// inicia memória (cria tabela se não existir)
await initMemory();

// Health admin
app.get("/admin/health", (req, res) => {
  if (req.headers["x-admin-token"] !== CONFIG.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false });
  }
  return res.json({
    ok: true,
    version: "5.6-MVP",
    rag_threshold: CONFIG.RAG_THRESHOLD,
    outside_corpus: CONFIG.ANSWER_OUTSIDE_CORPUS
  });
});

// Webhook do WhatsApp (ACK imediato + envio assíncrono)
app.post("/whatsapp", async (req, res) => {
  // ACK imediato para o Twilio (evita timeout)
  res.status(200).end();

  try {
    const from = (req.body.From || "").trim();
    const userId = from || uuidv4();

    // texto OU voz (áudio)
    const audioText = await maybeTranscribeWhatsApp(req.body);
    const userText = (audioText || req.body.Body || "").trim();
    if (!userText) return;

    const lang = detectLang(userText);

    // (opcional) recuperar histórico recente — pronto para uso futuro
    const history = await readHistory(userId);
    void history; // placeholder para linters

    // RAG híbrido + fallback garantido
    const { text } = await answerWithRAG(userText, lang);

    // Persistir conversa (TTL/GC tratados no memory.js)
    await writeTurn(userId, "user", userText);
    await writeTurn(userId, "assistant", text);

    // Enviar resposta quebrada (≤1600 chars por parte)
    for (const part of splitForWhatsApp(text)) {
      await sendWhatsApp(from, part);
    }
  } catch (e) {
    try {
      console.error("ERR /whatsapp:", e?.message || e);
    } catch {}
  }
});

// raiz
app.get("/", (_req, res) => res.send("True Live 5.6-MVP up"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("True Live 5.6-MVP listening on", PORT));
