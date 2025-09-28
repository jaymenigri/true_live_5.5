import OpenAI from "openai";

const { OPENAI_API_KEY, OPENAI_MODEL, OPENAI_TIMEOUT_MS } = process.env;

if (!OPENAI_API_KEY) console.warn("[warn] OPENAI_API_KEY is missing.");
const client = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: Number(OPENAI_TIMEOUT_MS || 8000) });

export async function generateResponse(system, user, contextChunks) {
  const model = OPENAI_MODEL || "gpt-4o-mini";
  const content = [
    { type: "text", text: user }
  ];
  // Compose system prompt with retrieved context
  const systemPrompt = `${system}

Contexto extraído do acervo (máx 6 trechos curtos). Use-o fielmente, cite as fontes listadas quando adequado:
${(contextChunks || []).map((c, i) => `(${i+1}) ${c.text} [Fonte: ${c.source}]`).join("\n")}`.trim();

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: user }
    ],
    temperature: 0.3
  });
  return completion.choices?.[0]?.message?.content?.trim() || "Desculpe, não consegui gerar uma resposta agora.";
}
