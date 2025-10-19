// services/waSend.js — envio WhatsApp (sem 'timeout' inválido)
import twilio from "twilio";

let client = null;
export function initTwilio() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (sid && token) {
    client = twilio(sid, token);
    console.log("[INFO] Twilio client pronto.");
  } else {
    console.warn("[WARN] Twilio desabilitado (credenciais ausentes).");
  }
  return client;
}

export async function waSend(to, body) {
  if (!client) throw new Error("Twilio indisponível");
  const from = process.env.TWILIO_FROM;
  if (!from) throw new Error("TWILIO_FROM ausente");
  await client.messages.create({ from, to, body });
}
