// controllers/chatController.js — orquestra RAG + contexto + fallback
import { ragSearch, loadCorpus } from "../services/rag.js";
import { initContext, getSubject, setSubject, contextStatus } from "../services/context.js";
import { fallbackAnswer } from "../services/fallback.js";
import { initTwilio, waSend } from "../services/waSend.js";

const THRESH = parseFloat(process.env.RAG_THRESHOLD || "0.40");
const ANSWER_OUTSIDE = process.env.ANSWER_OUTSIDE_CORPUS !== "0";

let corpusCount = 0;
let twilioReady = false;
let pgReady = false;

(async () => {
  corpusCount = loadCorpus();
  twilioReady = !!initTwilio();
  const st = await initContext();
  pgReady = st.db;
})();

export async function adminHealth(req, res) {
  if (req.query.token !== (process.env.ADMIN_TOKEN || "truelive2025"))
    return res.status(401).json({ ok:false });
  return res.json({
    status: "ok",
    version: "v2.10.9-pg-stable",
    corpus_items: corpusCount,
    db: pgReady
  });
}

function normalizeLang(text) {
  const t = (text||"").toLowerCase();
  if (/[áàãâéêíóôõúç]/.test(t) || t.includes(" que ") || t.includes(" foi "))
    return "pt";
  return "en";
}

export async function chatWebhook(req, res) {
  // ACK imediato do Twilio
  res.sendStatus(200);

  try {
    const from = req.body.From || req.body.from;
    const body = (req.body.Body || req.body.body || "").trim();
    if (!body) return;

    const lang = normalizeLang(body);
    let subject = await getSubject(from);
    let resolved = body;

    const r = ragSearch(resolved, THRESH);
    console.log("[INFO] RAG", { score: String(r.score), pass: r.pass, subject, resolvedQuery: resolved });

    let reply;
    if (r.pass && r.doc) {
      await setSubject(from, r.doc.title);
      reply = `${r.snippet}\n\nBaseado no acervo.\nFonte: ${r.doc.title}`;
    } else if (ANSWER_OUTSIDE) {
      reply = await fallbackAnswer(resolved, lang);
      reply += `\n\nResposta geral (fora do acervo).`;
    } else {
      reply = (lang==="pt")
        ? "Não encontrei no acervo e o fallback está desativado."
        : "Not found in corpus and fallback is disabled.";
    }

    if (from && twilioReady) {
      await waSend(from, reply);
    }
  } catch (e) {
    console.error("[ERROR] /twilio/whatsapp:", e.message);
  }
}
