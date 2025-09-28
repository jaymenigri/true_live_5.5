import Twilio from "twilio";

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
  console.warn("[warn] Twilio env vars missing – verify in Heroku Config Vars.");
}

export const twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

export async function sendWhatsApp(to, body) {
  if (!to?.startsWith("whatsapp:")) to = "whatsapp:" + to.replace(/^whatsapp:/, "");
  return twilioClient.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to,
    body
  });
}
