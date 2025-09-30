import OpenAI from "openai";
import { CONFIG } from "../config/appConfig.js";
export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
export async function withTimeout(promise, ms = CONFIG.OPENAI_TIMEOUT_MS) {
  return await Promise.race([ promise, new Promise((_, rej) => setTimeout(() => rej(new Error("OpenAI timeout")), ms)) ]);
}
