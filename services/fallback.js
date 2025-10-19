// services/fallback.js — OpenAI fallback
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function fallbackAnswer(question, lang="pt") {
  const sys = (lang==="pt")
    ? "Responda de forma direta, clara e concisa em português brasileiro."
    : "Answer concisely in the user's language.";
  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: question }
    ],
    temperature: 0.2
  });
  return r.choices[0].message.content.trim();
}
