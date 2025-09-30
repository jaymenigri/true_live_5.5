import axios from "axios";
import { openai, withTimeout } from "./openaiClient.js";
import { CONFIG } from "../config/appConfig.js";

/**
 * Se houver mídia de áudio no webhook da Twilio, baixa e transcreve.
 * Retorna o texto transcrito ou null.
 */
export async function maybeTranscribeWhatsApp(reqBody) {
  const numMedia = Number(reqBody.NumMedia || "0");
  if (!numMedia) return null;

  const mediaUrl = reqBody.MediaUrl0;
  const contentType = reqBody.MediaContentType0 || "";
  const isAudio = contentType.startsWith("audio/");
  if (!mediaUrl || !isAudio) return null;

  // Baixar com autenticação básica da Twilio
  const resp = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN
    }
  });

  // Construir File (Node 18+ tem suporte via undici)
  const file = new File([resp.data], "audio.ogg", { type: contentType });

  // Transcrever (modelo pode ser "gpt-4o-transcribe" ou "whisper-1")
  const tr = await withTimeout(
    openai.audio.transcriptions.create({
      file,
      model: "gpt-4o-transcribe",
      response_format: "json"
    }),
    CONFIG.OPENAI_TIMEOUT_MS
  );

  return (tr.text || "").trim();
}
