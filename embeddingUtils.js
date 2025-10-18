// embeddingUtils.js — v1 (OpenAI helper)
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function simpleAnswer(prompt) {
  const sys = "Você é um assistente direto e claro. Responda em português do Brasil.";
  const res = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [{role:"system", content:sys}, {role:"user", content:prompt}],
    temperature: 0.2,
    max_tokens: 300
  });
  return res.choices[0].message.content.trim();
}