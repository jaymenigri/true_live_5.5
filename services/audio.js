import axios from "axios";
import { openai, withTimeout } from "./openaiClient.js";
import { CONFIG } from "../config/appConfig.js";
import { toFile } from "openai/uploads";

/**
 * Baixa áudio do webhook WhatsApp (Twilio) e transcreve.
 * Se der erro (404/401/timeout/formato), LOGA e retorna null (não derruba o fluxo).
 */
export async function maybeTranscribeWhatsApp(reqBody) {
  try {
    const numMedia = Number(reqBody.NumMedia || "0");
    if (!numMedia) return null;

    const mediaUrl = reqBody.MediaUrl0;
    const contentType = (reqBody.MediaContentType0 || "").toLowerCase();
    const isAudio = contentType.startsWith("audio/");
    if (!mediaUrl || !isAudio) return null;

    const resp = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN
      },
      // tratamos status manualmente
      validateStatus: () => true
    });

    if (resp.status !== 200) {
      console.warn(`[AUDIO] download falhou status=${resp.status} url=${mediaUrl}`);
      return null;
    }

    const buf = Buffer.from(resp.data);
    const file = await toFile(buf, "audio.ogg");

    const tr = await withTimeout(
      openai.audio.transcriptions.create({
        file,
        model: "whisper-1",
        response_format: "json"
      }),
      CONFIG.OPENAI_TIMEOUT_MS
    );

    const text = (tr.text || "").trim();
    if (!text) console.warn("[AUDIO] transcrição vazia");
    return text || null;
  } catch (e) {
    try {
      console.warn("[AUDIO] erro, ignorando e seguindo com texto:", e?.message || e);
    } catch {}
    return null;
  }
}
