import OpenAI from "openai";
const { OPENAI_API_KEY, OPENAI_MODEL, OPENAI_TIMEOUT_MS } = process.env;
const client = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: Number(OPENAI_TIMEOUT_MS || 8000) });

export async function transcribeAudio(buffer, filename = "audio.ogg") {
  const blob = new Blob([buffer], { type: "audio/ogg" });
  const file = new File([blob], filename);
  const r = await client.audio.transcriptions.create({
    file,
    model: "whisper-1",
    response_format: "verbose_json"
  });
  return r?.text || "";
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
