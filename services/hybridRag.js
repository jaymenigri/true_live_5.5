import fs from "fs";
import path from "path";
import natural from "natural";
import { openai, withTimeout } from "./openaiClient.js";
import { CONFIG } from "../config/appConfig.js";

/* =======================
   Carregamento de dados
   ======================= */
const __dir = path.resolve();
const corpusPath = path.join(__dir, "corpus", "corpus.json");
const aliasesPath = path.join(__dir, "config", "aliases.json");
const fontesPath  = path.join(__dir, "data", "fontes.json");

const corpus = safeJson(corpusPath, []);
const aliasesRaw = safeJson(aliasesPath, {});
const fontes  = safeJson(fontesPath, { sources:{} });

function safeJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

/* =======================
   Normalização & Aliases
   ======================= */

// Normalização base: minúsculas, sem acentos, hifens/underscores → espaço, espaços compactados
function baseNormalize(s="") {
  return String(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Canon: chave SEM acento/ hífen (espaços simples)
function canonKey(k) {
  return baseNormalize(k);
}

// Precompile: para cada variação, criamos um RegExp com \b... \b (word boundary)
function compileAliases(aliasesObj) {
  const compiled = []; // [{ canon:"ben gurion", re: RegExp }]
  // ordenar canônicos por tamanho decrescente (evita colisões tipo "paula ben gurion" vs "ben gurion")
  const entries = Object.entries(aliasesObj).map(([k, arr]) => [canonKey(k), arr || []])
    .sort((a,b)=>b[0].length - a[0].length);

  for (const [canon, vars] of entries) {
    const all = new Set([canon, ...vars.map(baseNormalize)]);
    for (const alt of all) {
      // escapar regex
      const esc = alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // \b não funciona bem com caracteres RTL; como nosso normalize remove acentos e usa latim básico, OK.
      compiled.push({ canon, re: new RegExp(`\\b${esc}\\b`, "g") });
    }
  }
  return compiled;
}

const ALIASES = compileAliases(aliasesRaw);

// Aplica todos os aliases sobre um texto já normalizado
function applyAliasesNormalized(normText) {
  let out = normText;
  for (const { canon, re } of ALIASES) {
    out = out.replace(re, canon);
  }
  return out;
}

/* =======================
   Indexação TF-IDF (docs normalizados)
   ======================= */

const tfidf = new natural.TfIdf();
const docsOriginal = corpus.map(e => `${e.title || ""}\n${e.text || ""}`);

// Versões normalizadas dos docs (melhora o match lexical)
const docsNorm = docsOriginal.map(d => applyAliasesNormalized(baseNormalize(d)));
docsNorm.forEach(d => tfidf.addDocument(d));

/* =======================
   Utilidades Embeddings
   ======================= */
async function embed(texts) {
  const res = await withTimeout(
    openai.embeddings.create({
      model: CONFIG.OPENAI_EMBED_MODEL,
      input: texts
    }),
    CONFIG.OPENAI_TIMEOUT_MS
  );
  return res.data.map(e => e.embedding);
}

function cosine(a,b){
  let dot=0,na=0,nb=0;
  for (let i=0;i<a.length;i++){ dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  return dot/(Math.sqrt(na)*Math.sqrt(nb)+1e-9);
}

function normalizeScoreTFIDF(s){ return Math.min(1, s/10); }

/* =======================
   Rankeamento híbrido
   ======================= */

function tfidfTopK(normQuery, k = 6) {
  const scores = [];
  tfidf.tfidfs(normQuery, (i, v) => scores.push([i, v]));
  scores.sort((a,b)=>b[1]-a[1]);
  return scores.slice(0,k).map(([i,v])=>({index:i,score:v}));
}

/* =======================
   Hint de fontes (fallback)
   ======================= */
function fontesHintHosts(max=10) {
  try {
    return (fontes.sources?.websites || [])
      .map(f => new URL(f.url).hostname.replace(/^www\./,""))
      .slice(0, max)
      .join(", ");
  } catch { return ""; }
}

/* =======================
   Resposta principal
   ======================= */

export async function answerWithRAG(userQuery, lang="pt") {
  // 0) Guard-clauses
  if (!Array.isArray(corpus) || corpus.length === 0) {
    return { kind:"fallback", text: tagOutside("Nenhum item do acervo carregado.", lang), score: 0 };
  }

  // 1) Normalizar e aplicar aliases na QUERY
  const qNorm = applyAliasesNormalized(baseNormalize(userQuery));

  // 2) TF-IDF no espaço normalizado
  const top = tfidfTopK(qNorm, 6);
  const candidateIdxs = top.map(t => t.index);

  // 3) Preparar textos para embeddings (usar originais, que preservam contexto/semântica)
  const candTexts = candidateIdxs.map(i => docsOriginal[i] || "");
  const embeds = await safeEmbed([qNorm, ...candTexts]); // usamos qNorm como texto da query a embedar
  if (!embeds) {
    // Se embeddings falhar, cair só no TF-IDF
    const bestTF = top[0];
    if (bestTF && normalizeScoreTFIDF(bestTF.score) >= CONFIG.RAG_THRESHOLD) {
      return respondFromCorpus(bestTF.index, lang, normalizeScoreTFIDF(bestTF.score));
    }
    return await respondFallback(userQuery, lang, bestTF?.score || 0);
  }

  const qEmb = embeds[0];
  const cEmb = embeds.slice(1);
  const semScores = cEmb.map(e => cosine(qEmb, e));

  // 4) Score combinado (50/50 TF-IDF normalizado + semântico)
  const combined = top.map((t, i) => ({
    index: t.index,
    score: 0.5*normalizeScoreTFIDF(t.score) + 0.5*semScores[i]
  })).sort((a,b)=>b.score-a.score);

  const best = combined[0];
  if (best && best.score >= CONFIG.RAG_THRESHOLD) {
    return respondFromCorpus(best.index, lang, best.score);
  }

  // 5) Fallback garantido
  return await respondFallback(userQuery, lang, best?.score || 0);
}

/* =======================
   Helpers de resposta
   ======================= */

function tagInside(lang) {
  return (lang==="pt") ? "Baseado no acervo"
       : (lang==="es") ? "Basado en el acervo"
                       : "Based on the corpus";
}

function tagOutsideText(lang) {
  return (lang==="pt") ? "Resposta geral (fora do acervo)"
       : (lang==="es") ? "Respuesta general (fuera del acervo)"
                       : "General answer (outside the corpus)";
}

function tagOutside(body, lang) {
  return `${tagOutsideText(lang)}:\n${body}`;
}

function respondFromCorpus(idx, lang, score=0) {
  const entry = corpus[idx];
  const fonteTxt = entry?.sources?.length
    ? "\n\nFontes: " + entry.sources.map(s => `• ${s}`).join("\n")
    : "";
  const text = `${tagInside(lang)}:\n${(entry?.text || "").trim()}${fonteTxt}`;
  return { kind: "corpus", text, score };
}

async function respondFallback(userQuery, lang, score=0) {
  const sys = {
    pt: "Você é um assistente direto. Responda em português em até 1200 caracteres. Se não souber com certeza, dê a melhor resposta geral.",
    es: "Eres un asistente directo. Responde en español en hasta 1200 caracteres.",
    en: "You are a direct assistant. Answer in English in up to 1200 characters."
  }[lang] || "Você é um assistente direto. Responda em português em até 1200 caracteres.";

  const hosts = fontesHintHosts(10);
  const messages = [
    { role: "system", content: sys + (hosts ? ` Prefira fatos consistentes com: ${hosts}.` : "") },
    { role: "user", content: userQuery }
  ];

  const comp = await withTimeout(
    openai.chat.completions.create({
      model: CONFIG.OPENAI_MODEL,
      messages,
      temperature: 0.4
    }),
    CONFIG.OPENAI_TIMEOUT_MS
  );

  const txt = comp.choices?.[0]?.message?.content?.trim() || "OK.";
  return { kind:"fallback", text: tagOutside(txt, lang), score };
}

/* =======================
   Fail-safe de embeddings
   ======================= */
async function safeEmbed(texts){
  try { return await embed(texts); }
  catch { return null; }
}
