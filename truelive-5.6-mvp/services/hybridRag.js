import fs from "fs";
import path from "path";
import natural from "natural";
import { openai, withTimeout } from "./openaiClient.js";
import { CONFIG } from "../config/appConfig.js";

const __dir = path.resolve();
const corpusPath = path.join(__dir, "corpus", "corpus.json");
const aliasesPath = path.join(__dir, "config", "aliases.json");
const fontesPath  = path.join(__dir, "data", "fontes.json");

const corpus = safeJson(corpusPath, []);
const aliasesRaw = safeJson(aliasesPath, {});
const fontes  = safeJson(fontesPath, { sources:{} });

function safeJson(p, fb) { try { return JSON.parse(fs.readFileSync(p,"utf8")); } catch { return fb; } }

function baseNormalize(s=""){
  return String(s).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[-_]+/g," ").replace(/\s+/g," ").trim();
}
function canonKey(k){ return baseNormalize(k); }
function compileAliases(obj){
  const out=[]; const entries = Object.entries(obj).map(([k,arr])=>[canonKey(k), arr||[]]).sort((a,b)=>b[0].length-a[0].length);
  for (const [canon, vars] of entries){
    const all = new Set([canon, ...vars.map(baseNormalize)]);
    for (const alt of all){
      const esc = alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out.push({ canon, re: new RegExp(`\\b${esc}\\b`, "g") });
    }
  }
  return out;
}
const ALIASES = compileAliases(aliasesRaw);

function applyAliasesNormalized(normText){
  let out = normText;
  for (const {canon, re} of ALIASES) out = out.replace(re, canon);
  return out;
}
function extractSubjectsFrom(normText){
  const found = new Set();
  for (const {canon, re} of ALIASES) { if (re.test(normText)) { found.add(canon); re.lastIndex = 0; } }
  return Array.from(found).sort((a,b)=>b.length-a.length);
}
function prettySubject(s=""){
  return s.split(" ").map(w => w.length<=3 ? (w==="idf"?"IDF":w.charAt(0).toUpperCase()+w.slice(1)) : w.charAt(0).toUpperCase()+w.slice(1)).join(" ");
}

const tfidf = new natural.TfIdf();
const docsOriginal = corpus.map(e => `${e.title || ""}\n${e.text || ""}`);
const docsNorm = docsOriginal.map(d => applyAliasesNormalized(baseNormalize(d)));
docsNorm.forEach(d => tfidf.addDocument(d));

async function embed(texts){
  const r = await withTimeout(openai.embeddings.create({ model: CONFIG.OPENAI_EMBED_MODEL, input: texts }), CONFIG.OPENAI_TIMEOUT_MS);
  return r.data.map(e => e.embedding);
}
function cosine(a,b){ let dot=0,na=0,nb=0; for (let i=0;i<a.length;i++){ dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; } return dot/(Math.sqrt(na)*Math.sqrt(nb)+1e-9); }
function normalizeScoreTFIDF(s){ return Math.min(1, s/10); }
function tfidfTopK(q,k=6){ const sc=[]; tfidf.tfidfs(q,(i,v)=>sc.push([i,v])); sc.sort((a,b)=>b[1]-a[1]); return sc.slice(0,k).map(([i,v])=>({index:i,score:v})); }
function fontesHintHosts(max=10){ try { return (fontes.sources?.websites||[]).map(f=>new URL(f.url).hostname.replace(/^www\./,"")).slice(0,max).join(", "); } catch { return ""; } }

function tagInside(lang){ return lang==="pt"?"Baseado no acervo": lang==="es"?"Basado en el acervo":"Based on the corpus"; }
function tagOutsideText(lang){ return lang==="pt"?"Resposta geral (fora do acervo)": lang==="es"?"Respuesta general (fuera del acervo)":"General answer (outside the corpus)"; }
function maybeLabelOutside(body, lang){ return (CONFIG.ANSWER_OUTSIDE_CORPUS ? `${tagOutsideText(lang)}:\n` : "") + body; }

export async function answerWithRAG(userQuery, lang="pt"){
  if (!Array.isArray(corpus) || corpus.length===0) {
    return { kind:"fallback", text: maybeLabelOutside("Nenhum item do acervo carregado.", lang), score: 0, subject: null };
  }

  const qNorm0 = baseNormalize(userQuery);
  const qNorm = applyAliasesNormalized(qNorm0);
  const qSubjects = extractSubjectsFrom(qNorm);
  const subject = qSubjects.length ? prettySubject(qSubjects[0]) : null;

  const top = tfidfTopK(qNorm, 6);
  const candTexts = top.map(t => docsOriginal[t.index] || "");
  let embeds; try { embeds = await embed([qNorm, ...candTexts]); } catch {}

  if (!embeds) {
    const bestTF = top[0];
    if (bestTF && normalizeScoreTFIDF(bestTF.score) >= CONFIG.RAG_THRESHOLD) {
      const entry = corpus[bestTF.index];
      const fontesTxt = entry?.sources?.length ? "\n\nFontes: " + entry.sources.map(s=>`• ${s}`).join("\n") : "";
      const text = `${tagInside(lang)}:\n${(entry?.text||"").trim()}${fontesTxt}`;
      return { kind:"corpus", text, score: normalizeScoreTFIDF(bestTF.score), subject };
    }
    return await doFallback(userQuery, lang, subject, bestTF?.score || 0);
  }

  const qEmb = embeds[0]; const cEmb = embeds.slice(1);
  const semScores = cEmb.map(e => cosine(qEmb, e));
  const combined = top.map((t,i)=>({ index:t.index, score: 0.5*normalizeScoreTFIDF(t.score) + 0.5*semScores[i] }))
                      .sort((a,b)=>b.score-a.score);

  const best = combined[0];
  if (best && best.score >= CONFIG.RAG_THRESHOLD) {
    const entry = corpus[best.index];
    const fontesTxt = entry?.sources?.length ? "\n\nFontes: " + entry.sources.map(s=>`• ${s}`).join("\n") : "";
    const text = `${tagInside(lang)}:\n${(entry?.text||"").trim()}${fontesTxt}`;
    return { kind:"corpus", text, score: best.score, subject };
  }

  return await doFallback(userQuery, lang, subject, best?.score || 0);
}

async function doFallback(userQuery, lang, subject, score=0){
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

  const comp = await withTimeout(openai.chat.completions.create({ model: CONFIG.OPENAI_MODEL, messages, temperature: 0.4 }), CONFIG.OPENAI_TIMEOUT_MS);
  const txt = comp.choices?.[0]?.message?.content?.trim() || "OK.";
  return { kind:"fallback", text: maybeLabelOutside(txt, lang), score, subject };
}
