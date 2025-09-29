// services/openaiClient.js — v2.2 (chat + whisper, com timeout, retry e logs)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_TIMEOUT = Number(process.env.OPENAI_TIMEOUT_MS || "10000"); // 10s default

if (!OPENAI_API_KEY) {
  console.warn("[openaiClient] WARN: OPENAI_API_KEY não definido.");
}

// helpers -------------------------------------------------

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url, options = {}, timeoutMs = OPENAI_TIMEOUT) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }

    if (!res.ok) {
      const err = new Error(`[OpenAI] HTTP ${res.status}`);
      err.status = res.status;
      err.responseText = text;
      err.responseJSON = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

// retry simples p/ 429/5xx --------------------------------
async function fetchWithRetryJSON(url, options, timeoutMs) {
  const maxAttempts = 2;
  let attempt = 0, lastErr;
  while (attempt < maxAttempts) {
    try {
      return await fetchJSON(url, options, timeoutMs);
    } catch (e) {
      lastErr = e;
      const status = e.status || 0;
      // Re-tenta em 429/5xx e abort/timeout
      const retriable = status === 429 || (status >= 500 && status <= 599) || e.name === "AbortError";
      console.error(`[OpenAI] attempt ${attempt + 1} failed`, { status, name: e.name, msg: e.message });
      if (!retriable || attempt === maxAttempts - 1) break;
      await sleep(500 + attempt * 750);
    }
    attempt++;
  }
  throw lastErr;
}

// montagem do contexto ------------------------------------

function buildContextBlock(chunks = []) {
  if (!chunks?.length) return "";
  const lines = chunks.map((c, i) => {
    const meta = [c.title, c.date].filter(Boolean).join(" — ");
    return `• ${meta}\n  “${(c.text || "").trim()}”`;
  });
  return `Use SOMENTE os trechos a seguir como base factual. Se algo não estiver aqui, diga que não consta no acervo.\n${lines.join("\n")}`;
}

// API pública ---------------------------------------------

export async function generateResponseWithHistory(systemPrompt, history, userText, chunks) {
  const messages = [];

  messages.push({ role: "system", content: systemPrompt });

  // histórico curto (até 8 msgs, segura token)
  const hist = (history || []).slice(-8);
  for (const m of hist) {
    if (!m?.role || !m?.content) continue;
    messages.push({ role: m.role, content: m.content });
  }

  // bloco de contexto do acervo (se houver)
  if (chunks?.length) {
    messages.push({
      role: "system",
      content: buildContextBlock(chunks),
    });
  }

  // pergunta atual
  messages.push({ role: "user", content: userText || "" });

  const body = {
    model: OPENAI_MODEL,
    messages,
    temperature: 0.3,
    max_tokens: 600,
  };

  const headers = {
    "Authorization": `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };

  const url = "https://api.openai.com/v1/chat/completions";
  try {
    const json = await fetchWithRetryJSON(url, { method: "POST", headers, body: JSON.stringify(body) }, OPENAI_TIMEOUT);
    const content = json?.choices?.[0]?.message?.content?.trim?.();
    if (!content) throw new Error("[OpenAI] resposta vazia");
    return content;
  } catch (e) {
    // log amigável e não derruba o webhook
    console.error("[openaiClient] Chat error:", {
      status: e.status,
      message: e.message,
      responseJSON: e.responseJSON,
      responseText: e.responseText?.slice?.(0, 400)
    });
    // devolve uma resposta mínima para o servidor seguir
    return "Desculpe, tive um problema técnico ao gerar a resposta. Pode repetir a pergunta?";
  }
}

export async function transcribeAudio(buffer, { basename = "audio", contentType = "audio/ogg" } = {}) {
  if (!buffer || !buffer.length) return "";
  try {
    const url = "https://api.openai.com/v1/audio/transcriptions";
    const form = new FormData();

    // Node 18+ tem Blob/FormData nativos
    const blob = new Blob([buffer], { type: contentType || "application/octet-stream" });
    form.append("file", blob, `${basename}.${extFromContentType(contentType)}`);
    form.append("model", "whisper-1");
    // idioma opcional (auto): form.append("language", "pt");

    const res = await fetchWithRetryJSON(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: form
    }, Math.max(OPENAI_TIMEOUT, 20000)); // whisper pode demorar um pouco mais

    const text = res?.text?.trim?.() || res?.text || "";
    return text;
  } catch (e) {
    console.error("[openaiClient] Whisper error:", {
      status: e.status,
      message: e.message,
      responseJSON: e.responseJSON,
      responseText: e.responseText?.slice?.(0, 400)
    });
    return "";
  }
}

// util pequeno
function extFromContentType(ct = "") {
  if (ct.includes("wav")) return "wav";
  if (ct.includes("mpeg")) return "mp3";
  if (ct.includes("ogg")) return "ogg";
  if (ct.includes("mp4")) return "mp4";
  if (ct.includes("m4a")) return "m4a";
  return "bin";
}
