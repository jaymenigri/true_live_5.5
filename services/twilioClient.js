import twilio from "twilio";
import { CONFIG } from "../config/appConfig.js";

export const twilioClient = twilio(CONFIG.TWILIO.SID, CONFIG.TWILIO.TOKEN);

export async function sendWhatsApp(to, body) {
  return twilioClient.messages.create({
    from: CONFIG.TWILIO.FROM,
    to,
    body
  });
}
