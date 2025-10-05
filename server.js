// server.js — True Live v2.10.4 (estabilizado)

import express from "express";
import bodyParser from "body-parser";
import morgan from "morgan";
import twilio from "twilio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { hybridSearch } from "./services/hybridRag.js";
import { loadContext, saveContext } from "./services/context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(morgan("tiny"));

// Config vars
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "truelive2025";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  // Guardião: proíbe campo inválido
  const originalCreate = twilioClient.messages.create;
  twilioClient.messages.create = async (args) => {
    if (args.timeout !== undefined) {
      throw new Error("[Guard] Campo inválido 'timeout' no Twilio.");
    }
    return originalCreate.call(twilioClient.messages, args);
  };
}

// Corpus inicial
let corpusItems = [];
const corpusFile = path.join(__dirname, "corpus", "corpus.json");
if (fs.existsSync(corpusFile)) {
  corpusItems = JSON.parse(fs.readFileSync(corpusFile, "utf8"));
}
console.log(`[INFO] Corpus loaded: ${corpusItems.length} items.`);

// Health check
app.get("/admin/health", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(403).json({ error: "Forbidden" });
  return res.json({
    status: "ok",
    version: "v2.10.4",
    corpus_items: corpusItems.length,
    db: true
  });
});

// WhatsApp webhook
app.post("/twilio/whatsapp", async (req, res) => {
  try {
    const from = req.body.From;
    const body = (req.body.Body || "").trim();

    console.log(`[IN] ${from}: ${body}`);

    // ACK imediato
    res.sendStatus(200);

    // Memória e RAG
    const ctx = await loadContext(from);
    const { reply, scope, subject } = await hybridSearch(body, ctx);
    if (subject) await saveContext(from, subject);

    const finalReply = reply || "Desculpe, não encontrei nada agora.";

    console.log(`[SEND] reply: ${finalReply}`);

    // Enviar via Twilio ou responder HTTP
    if (twilioClient && TWILIO_WHATSAPP_FROM) {
      await Promise.race([
        twilioClient.messages.create({
          from: TWILIO_WHATSAPP_FROM,
          to: from,
          body: finalReply
        }),
        new Promise((_, r) => setTimeout(() => r(new Error("Timeout Twilio")), 15000))
      ]);
    } else {
      console.log("[SEND] Twilio não configurado. Responderia via HTTP.");
    }

  } catch (err) {
    console.error("[ERROR] /twilio/whatsapp:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[INFO] Server up { port: ${PORT}, corpus_items: ${corpusItems.length} }`));
