import axios from "axios";
import { openai, withTimeout } from "./openaiClient.js";
import { CONFIG } from "../config/appConfig.js";

let toFileFn = null;
async function getToFile() {
  if (toFileFn) return toFileFn;
  try {
    const mod = await import("openai/uploads");
    toFileFn = mod.toFile;
  } catch (e) {
    console.warn("[AUDIO] módulo openai/uploads indisponível:", e?.message || e);
    toFileFn = null;
  }
  return toFileFn;
}

/** Baixa áudio do WhatsApp (Twilio) e transcreve.
 * Em caso de erro, LOGA e retorna null (não derruba o fluxo).
 */
export async function maybeTranscribeWhatsApp(reqBody) {
  try {
    const numMedia = Number(reqBody.NumMedia || "0");
    if (!numMedia) return null;

    const mediaUrl = reqBody.MediaUrl0;
    const contentType = (reqBody.MediaContentType0 || "").toLowerCase();
    if (!mediaUrl || !contentType.startsWith("audio/")) return null;

    const resp = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN
      },
      validateStatus: () => true
    });
    if (resp.status !== 200) {
      console.warn(`[AUDIO] download falhou status=${resp.status} url=${mediaUrl}`);
      return null;
    }

    const toFile = await getToFile();
    if (!toFile) return null;

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
    console.warn("[AUDIO] erro, ignorando e seguindo com texto:", e?.message || e);
    return null;
  }
}
