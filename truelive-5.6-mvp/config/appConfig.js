export const CONFIG = {
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "truelive2025",
  ANSWER_OUTSIDE_CORPUS: process.env.ANSWER_OUTSIDE_CORPUS === "1",
  RAG_THRESHOLD: Number(process.env.RAG_THRESHOLD || "0.5"),
  OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o-mini",
  OPENAI_EMBED_MODEL: process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small",
  OPENAI_TIMEOUT_MS: Number(process.env.OPENAI_TIMEOUT_MS || "10000"),
  DB_URL: process.env.DATABASE_URL || "",
  TWILIO: { SID: process.env.TWILIO_ACCOUNT_SID || "", TOKEN: process.env.TWILIO_AUTH_TOKEN || "", FROM: process.env.TWILIO_WHATSAPP_FROM || "" },
  OFFTOPIC: { MAX: Number(process.env.OFFTOPIC_MAX || "3"), COOLDOWN_MIN: Number(process.env.OFFTOPIC_COOLDOWN_MIN || "15") },
  MEMORY: { TTL_HOURS: 24, GC_HOURS: 72, MAX_TURNS: 8 }
};
