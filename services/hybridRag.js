// services/hybridRag.js
import fs from "fs";
import path from "path";
import { openai, withTimeout } from "./openaiClient.js";
import { CONFIG } from "../config/appConfig.js";

const __dir = path.resolve();
const corpusPath = path.join(__dir, "corpus", "corpus.json");
const aliasesPath = path.join(__dir, "config", "aliases.json");
const fontesPath  = path.join(__dir, "data", "fontes.json");

function safeJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } }

let STATE = {
  ready: false,
  natural: null,     // módulo opcional
  corpus: [],
  docsOriginal: [],
  aliases: {},
  aliasesCompiled: [],
  fontes: { sources: {} }
};

function baseNormalize(s = "") {
  return String(s).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}
function canonKey(k){ return baseNormalize(k); }
function compileAliases(obj) {
  const out = [];
  const entries = Object.entries(obj).map(([k, arr]) => [canonKey(k), arr || []])
    .sort((a,b) => b[0].length - a[0].length);
  for (const [canon, vars] of entries) {
    const all = new Set([canon, ...vars.map(baseNormalize)]);
    for (const alt of all) {
      const esc = alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out.push({ canon, re: new RegExp(`\\b${esc}\\b`, "g") });
    }
  }
  return out;
}
function applyAliasesNormalized(normText) {
  let out = normText;
  for (const { canon, re } of STATE.aliasesCompiled) out = out.replace(re, canon);
  return out;
}
function extractSubjectsFrom(normText) {
  const found = new Set();
  for (const { canon, re } of STATE.aliasesCompiled) { if (re.test(normText)) { found.add(canon); re.lastIndex = 0; } }
  return Array.from(found).sort((a,b)=>b.length-a.length);
}
function prettySubject(s=""){
  return s.split(" ").map(w => w.length<=3 ? (w==="idf"?"IDF":w.charAt(0).toUpperCase()+w.slice(1)) : w.charAt(0).toUpperCase()+w.slice(1)).join(" ");
}

function fontesHintHosts(max=10){
  try {
    return (STATE.fontes.sources?.websites || [])
      .map(f => new URL(f.url).hostname.replace(/^www\./,""))
      .slice(0, max).join(", ");
  } catch { return ""; }
}

function tagInside(lang){ return lang==="pt"?"Baseado no acervo": lang==="es"?"Basado en el acervo":"Based on the corpus"; }
function tagOutsideText(lang){ return lang==="pt"?"Resposta geral (fora do acervo)": lang==="es"?"Respuesta general (fuera del acervo)":"General answer (outside the corpus)"; }
function maybeLabelOutside(body, lang){ return (CONFIG.ANSWER_OUTSIDE_CORPUS ? `${tagOutsideText(lang)}:\n` : "") + body; }

/** Inicializa corpus/aliases e tenta carregar 'natural' dinamicamente. */
async function ensureReady() {
  if (STATE.ready) return;
  STATE.corpus = safeJson(corpusPath, []);
  STATE.aliases = safeJson(aliasesPath, {});
  STATE.fontes = safeJson(fontesPath, { sources: {} });

  STATE.aliasesCompiled = compileAliases(STATE.aliases);
  STATE.docsOriginal = STATE.corpus.map(e => `${e.title || ""}\n${e.text || ""}`);

  try {
    // carrega natural apenas se disponível no ambiente
    const mod = await import("natural");
    STATE.natural = mod.default || mod;
  } catch (_) {
    STATE.natural = null; // segue sem 'natural'
    console.warn("[RAG] pacote 'natural' indisponível — usando scoring simples.");
  }
  STATE.ready = true;
}

// ranking léxico robusto (considera sobreposição de palavras + assunto/aliases)
function simpleTopK(qNorm, subject, k = 6) {
  const qTokens = Array.from(new Set(qNorm.split(" ").filter(w => w.length > 2)));
  const scores = STATE.docsOriginal.map((doc, index) => {
    const entry = STATE.corpus[index] || {};
    const dn = applyAliasesNormalized(baseNormalize(doc));
    const tn = applyAliasesNormalized(baseNormalize(entry.title || ""));

    // sobreposição: fração de tokens da pergunta presentes no doc
    let overlap = 0;
    for (const w of qTokens) if (dn.includes(w)) overlap += 1;
    const overlapScore = qTokens.length ? (overlap / qTokens.length) : 0;

    // boost se o "assunto" (via aliases) estiver no título ou texto
    const subj = (subject || "").toLowerCase();
    const subjectHit = subj ? (dn.includes(subj) || tn.includes(subj)) : false;
    const subjectBoost = subjectHit ? 0.5 : 0;

    // bônus pequeno por título “bem próximo” do assunto
    const titleBoost = subj && tn.startsWith(subj) ? 0.2 : 0;

    const score = overlapScore + subjectBoost + titleBoost; // 0..1.7
    return { index, score, subjectHit };
  });

  return scores.sort((a, b) => b.score - a.score).slice(0, k);
}

async function embed(texts){
  const r = await withTimeout(
    openai.embeddings.create({ model: CONFIG.OPENAI_EMBED_MODEL, input: texts }),
    CONFIG.OPENAI_TIMEOUT_MS
  );
  return r.data.map(e => e.embedding);
}
function cosine(a,b){ let dot=0,na=0,nb=0; for (let i=0;i<a.length;i++){ dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; } return dot/(Math.sqrt(na)*Math.sqrt(nb)+1e-9); }
function normalizeScore(s){ return Math.max(0, Math.min(1, s)); }

export async function answerWithRAG(userQuery, lang="pt"){
  await ensureReady();

  if (!Array.isArray(STATE.corpus) || STATE.corpus.length===0) {
    return { kind:"fallback", text: maybeLabelOutside("Nenhum item do acervo carregado.", lang), score: 0, subject: null };
  }

  const qNorm0 = baseNormalize(userQuery);
  const qNorm = applyAliasesNormalized(qNorm0);
  const qSubjects = extractSubjectsFrom(qNorm);
  const subject = qSubjects.length ? prettySubject(qSubjects[0]) : null;

  // 1) Ranking básico (sempre disponível)
  const baseTop = simpleTopK(qNorm, 6);

  // 2) Embeddings (híbrido) — se falhar, usa só ranking básico
  let embeds;
  try { embeds = await embed([qNorm, ...baseTop.map(t => STATE.docsOriginal[t.index] || "")]); } catch {}
  if (!embeds) {
    const best = baseTop[0];
    if (best && best.score >= CONFIG.RAG_THRESHOLD) {
      const entry = STATE.corpus[best.index];
      const fontesTxt = entry?.sources?.length ? "\n\nFontes: " + entry.sources.map(s=>`• ${s}`).join("\n") : "";
      const text = `${tagInside(lang)}:\n${(entry?.text||"").trim()}${fontesTxt}`;
      return { kind:"corpus", text, score: normalizeScore(best.score), subject };
    }
    return await doFallback(userQuery, lang, subject, best?.score || 0);
  }

  const qEmb = embeds[0];
  const cEmb = embeds.slice(1);
  const semScores = cEmb.map(e => cosine(qEmb, e));
  const combined = baseTop.map((t,i)=>({
    index: t.index,
    score: 0.5*normalizeScore(t.score) + 0.5*semScores[i]
  })).sort((a,b)=>b.score-a.score);

  const best = combined[0];
  if (best && best.score >= CONFIG.RAG_THRESHOLD) {
    const entry = STATE.corpus[best.index];
    const fontesTxt = entry?.sources?.length ? "\n\nFontes: " + entry.sources.map(s=>`• ${s}`).join("\n") : "";
    const text = `${tagInside(lang)}:\n${(entry?.text||"").trim()}${fontesTxt}`;
    return { kind:"corpus", text, score: best.score, subject };
  }

  return await doFallback(userQuery, lang, subject, best?.score || 0);
}

async function doFallback(userQuery, lang, subject, score = 0) {
  const sys = {
    pt: "Você é um assistente direto. Responda em português em até 1200 caracteres.",
    es: "Eres un asistente directo. Responde en español en hasta 1200 caracteres.",
    en: "You are a direct assistant. Answer in English in up to 1200 characters."
  }[lang] || "Você é um assistente direto. Responda em português em até 1200 caracteres.";

  const hosts = fontesHintHosts(10);
  const extra = subject ? ` Contexto: a conversa atual é sobre ${subject}.` : "";
  const messages = [
    { role: "system", content: sys + (hosts ? ` Prefira fatos consistentes com: ${hosts}.` : "") + extra },
    { role: "user", content: userQuery }
  ];

  try {
    const comp = await withTimeout(
      openai.chat.completions.create({
        model: CONFIG.OPENAI_MODEL,
        messages,
        temperature: 0.4
      }),
      CONFIG.OPENAI_TIMEOUT_MS
    );
    const txt = comp.choices?.[0]?.message?.content?.trim() || "OK.";
    return { kind: "fallback", text: maybeLabelOutside(txt, lang), score, subject };
  } catch (e) {
    // Plano C: nunca deixar o usuário sem resposta
    const msg = {
      pt: "No momento não consegui consultar a fonte externa. Tente novamente em instantes.",
      es: "En este momento no pude consultar la fuente externa. Intenta de nuevo en unos instantes.",
      en: "I couldn’t reach the external source right now. Please try again shortly."
    }[lang] || "No momento não consegui consultar a fonte externa. Tente novamente em instantes.";

    return { kind: "fallback_error", text: maybeLabelOutside(msg, lang), score, subject };
  }
}
