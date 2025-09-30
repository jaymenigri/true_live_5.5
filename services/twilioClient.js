import twilio from "twilio";
import { CONFIG } from "../config/appConfig.js";

export const twilioClient = twilio(CONFIG.TWILIO.SID, CONFIG.TWILIO.TOKEN);

/**
 * Envia mensagem WhatsApp via Twilio.
 * Faz log detalhado se falhar (motivo e código).
 */
export async function sendWhatsApp(to, body) {
  try {
    const r = await twilioClient.messages.create({
      from: CONFIG.TWILIO.FROM, // ex.: 'whatsapp:+14155238886' (sandbox) ou seu número aprovado
      to,
      body
    });
    return r;
  } catch (err) {
    const code = err?.code;
    const msg = err?.message || String(err);
    const more = err?.moreInfo || "";
    console.error(
      `[TWILIO] send fail to=${to} from=${CONFIG.TWILIO.FROM} code=${code} msg=${msg} more=${more}`
    );
    throw err;
  }
}
