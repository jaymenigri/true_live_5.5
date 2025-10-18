// ===== True Live — chatController.js =====
// Controlador central do fluxo WhatsApp -> RAG -> OpenAI -> resposta

import { runRAG } from "../services/rag.js";
import { runFallback } from "../services/fallback.js";
import { waSend } from "../services/waSend.js";

export async function handleIncoming(req, twilioClient) {
  try {
    const from = req.body.From || "";
    const body = req.body.Body?.trim() || "";
    const scope = "whatsapp";

    if (!body) {
      console.warn("[WARN] Mensagem vazia recebida.");
      return;
    }

    console.log(`[INCOMING] ${from}: ${body}`);

    // Confirma recebimento imediato
    await waSend(twilioClient, from, "✅ Recebido, pensando...");

    // 1️⃣ Tenta resposta via RAG
    const ragResult = await runRAG(body);

    let reply = "";
    let source = "";

    if (ragResult.pass) {
      reply = ragResult.answer;
      source = "RAG";
    } else {
      // 2️⃣ Fallback via modelo OpenAI direto
      reply = await runFallback(body);
      source = "Fallback";
    }

    console.log(`[REPLY:${source}] ${reply?.slice(0, 80)}...`);

    // Envia a resposta final
    await waSend(twilioClient, from, reply, { source });

  } catch (err) {
    console.error("[ERROR] handleIncoming:", err.message);
  }
}
