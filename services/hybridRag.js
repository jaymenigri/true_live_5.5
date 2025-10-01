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
  ST
