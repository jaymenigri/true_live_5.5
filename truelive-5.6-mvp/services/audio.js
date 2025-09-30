import axios from "axios";
import { openai, withTimeout } from "./openaiClient.js";
import { CONFIG } from "../config/appConfig.js";
import { toFile } from "openai/uploads";

/** Baixa áudio de mensagem do WhatsApp (Twilio) e transcreve. */
export async function maybeTranscribeWhatsApp(reqBody) {
  const numMedia = Number(reqBody.NumMedia || "0");
  if (!numMedia) return null;
  const mediaUrl = reqBody.MediaUrl0;
  const contentType = reqBody.MediaContentType0 || "";
  if (!mediaUrl || !contentType.startsWith("audio/")) return null;

  const resp = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
  });

  const buf = Buffer.from(resp.data);
  const file = await toFile(buf, "audio.ogg");

  const tr = await withTimeout(
    openai.audio.transcriptions.create({ file, model: "whisper-1", response_format: "json" }),
    CONFIG.OPENAI_TIMEOUT_MS
  );
  return (tr.text || "").trim();
}
