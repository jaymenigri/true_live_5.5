import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
const client = apiKey ? new OpenAI({ apiKey }) : null;

export async function complete(messages, opts = {}) {
  if (!client) throw new Error("OpenAI API key ausente.");
  const res = await client.chat.completions.create({
    model,
    messages,
    temperature: 0.2,
    max_tokens: 350,
    ...opts
  });
  return res.choices?.[0]?.message?.content?.trim() || "";
}
