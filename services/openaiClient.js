import OpenAI from "openai";
import fs from "fs";
import path from "path";

const { OPENAI_API_KEY, OPENAI_MODEL, OPENAI_TIMEOUT_MS } = process.env;
const client = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: Number(OPENAI_TIMEOUT_MS || 8000) });

/** Salva o buffer em /tmp e envia como stream para o Whisper. */
export async function transcribeAudio(buffer, { basename = "audio", contentType = "audio/ogg" } = {}) {
  // escolhe extensão pela content-type
  const ext = contentType.includes("mpeg") || contentType.includes("mp3") ? ".mp3"
           : contentType.includes("mp4")  || contentType.includes("mp4a") || contentType.includes("m4a") ? ".m4a"
           : contentType.includes("wav")  ? ".wav"
           : contentType.includes("webm") ? ".webm"
           : ".ogg";
  const tmpPath = path.join("/tmp", `${basename}-${Date.now()}${ext}`);
  fs.writeFileSync(tmpPath, buffer);

  try {
    const fileStream = fs.createReadStream(tmpPath);
    const r = await client.audio.transcriptions.create({
      file: fileStream,
      model: "whisper-1",
      response_format: "verbose_json"
    });
    return r?.text?.trim() || "";
  } finally {
    // limpeza best-effort
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

export async function generateResponseWithHistory(system, history, user, contextChunks) {
  const model = OPENAI_MODEL || "gpt-4o-mini";
  const sys = `${system}

Contexto extraído do acervo (máx 6 trechos curtos). Use fielmente e cite as fontes listadas quando adequado:
${(contextChunks || []).map((c, i) => `(${i+1}) ${c.text} [Fonte: ${c.source}]`).join("\n")}`.trim();

  const messages = [{ role: "system", content: sys }];
  for (const m of (history || [])) messages.push({ role: m.role, content: m.content });
  messages.push({ role: "user", content: user });

  const completion = await client.chat.completions.create({
    model,
    messages,
    temperature: 0.3
  });
  return completion.choices?.[0]?.message?.content?.trim() || "Desculpe, não consegui gerar uma resposta agora.";
}
