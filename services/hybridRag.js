// services/hybridRag.js — v2.1.6 (híbrido leve com normalização, aliases, boost e limiar dinâmico)

import fs from "fs";
import path from "path";

// ===== Config =====
const BASE_THRESHOLD = Number(process.env.RAG_THRESHOLD || "0.4"); // ajuste via Heroku Config Vars
const MAX_CHUNKS = 6;

// ===== Helpers =====
const stripAccents = s => (s || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase();

const clean = s =>
  stripAccents(String(s || "").replace(/[^\p{L}\p{N}\s-]/gu, " "))
    .replace(/\s+/g, " ")
    .trim();

function loadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return null; }
}

// Carrega corpus e aliases
const corpusPath = path.join(process.cwd(), "corpus", "corpus.json");
const aliasesPath = path.join(process.cwd(), "config", "aliases.json");

const CORPUS = loadJSON(corpusPath) || [];
const RAW_ALIASES = loadJSON(aliasesPath) || {};

const ALIASES = (() => {
  const out = {};
  for (const [k, v] of Object.entries(RAW_ALIASES)) out[clean(k)] = clean(v || "");
  return out;
})();

// Conjunto de entidades canônicas para boost (parte esquerda do título antes de “—”, se houver)
const ENTITY_CANONICALS = new Set(
  CORPUS.map(c => clean((c.title || "").split("—")[0] || c.title || "")).filter(Boolean)
);

// Tokenização & bigramas
const tokenize = s => clean(s).split(" ").filter(Boolean);
const bigrams = tokens => {
  const arr = [];
  for (let i = 0; i < tokens.length - 1; i++) arr.push(tokens[i] + " " + tokens[i + 1]);
  return arr;
};

// BM25-lite (heurística simples)
function scoreBM25Lite(qTokens, dTokens) {
  if (!qTokens.length || !dTokens.length) return 0;
  const D = dTokens.length;
  let score = 0;
  const present = new Set(dTokens);
  const idf = t => 1 / (1 + (present.has(t) ? 1 : 0.2)); // se termo existe no doc, idf menor
  const tf = t => dTokens.filter(x => x === t).length / D;
  for (const t of qTokens) score += idf(t) * Math.sqrt(tf(t));
  return score;
}

// Aplica aliases numa string "clean"
function applyAliasesClean(s) {
  let out = s;
  for (const [from, to] of Object.entries(ALIASES)) {
    if (!from) continue;
    const re = new RegExp(`\\b${from}\\b`, "g");
    out = out.replace(re, to);
  }
  return out;
}

// ===== API pública =====
export function classifyScope(q) {
  const t = stripAccents(q || "");
  return /(israel|sion|zion|juda|antisemit|sho|holoc|yom|kippur|hamas|hezb|idf|jvl|yad|jerus|tel aviv|rabin|ben.?gurion|golda|meir|shalom)/.test(t)
    ? "in" : "out";
}

// Stubs (seu ingestor real pode estar em outro módulo)
export async function ingestRSS()     { return { added: 0, total: 0 }; }
export async function ingestSitemap() { return { added: 0, total: 0 }; }

// ===== Recuperação híbrida =====
export async function retrieveHybrid(query, k = MAX_CHUNKS, preferRecency = false) {
  try {
    // Normaliza & aplica aliases na query
    let qClean = applyAliasesClean(clean(query));
    const qTokens  = tokenize(qClean);
    const qBigrams = bigrams(qTokens);

    // Detecta entidade canônica presente na query
    let entityBoostHit = false;
    for (const ent of ENTITY_CANONICALS) {
      if (ent && qClean.includes(ent)) { entityBoostHit = ent; break; }
    }

    const scored = [];

    for (const doc of CORPUS) {
      const titleRaw = doc.title || "";
      const textRaw  = doc.text  || "";

      // Normaliza corpo e TÍTULO (com aliases!)
      const titleClean = applyAliasesClean(clean(titleRaw));
      const dClean = applyAliasesClean(clean(`${titleRaw}. ${textRaw}`));
      const dTokens = tokenize(dClean);
      const dBigrams = bigrams(dTokens);

      // Score lexical + fuzzy
      let s = scoreBM25Lite(qTokens, dTokens);

      // Fuzzy por bigramas (casamentos parciais ajudam nomes próprios)
      let matchBigrams = 0;
      for (const bg of qBigrams) if (dBigrams.includes(bg)) matchBigrams++;
      s += 0.4 * (matchBigrams / Math.max(1, qBigrams.length));

      // Boost se o título contém a entidade detectada
      if (entityBoostHit && titleClean.includes(entityBoostHit)) s += 0.7;

      // Bônus leve de recência se pedido e houver data
      if (preferRecency && doc.date) {
        const y = parseInt(String(doc.date).slice(0, 4), 10);
        if (!isNaN(y)) s += Math.max(0, (y - 1948)) * 0.001;
      }

      scored.push({ doc, score: s });
    }

    // Ordena por score desc e pega top-k
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, k);

    // Limiar dinâmico: mais permissivo para nome próprio/consulta curta
    const isShortQuery = qTokens.length <= 3;
    const isPerson = /\b(ben.?gurion|golda|rabin|peres|begin|dayan|shamir|weizmann|herzl|sharon)\b/i.test(query || "");
    const dynTh = (isShortQuery || isPerson) ? Math.min(0.35, BASE_THRESHOLD) : BASE_THRESHOLD;

    const pass = (top[0]?.score || 0) >= dynTh;

    // Logs de diagnóstico (aparecem no Heroku)
    console.log("RAG top:", top.slice(0, 3).map(x => ({ title: x.doc.title, score: +x.score.toFixed(3) })));
    console.log("RAG pass:", pass, "threshold:", dynTh, "query:", query);

    // Prepara chunks (1–2 frases + metadados)
    const chunksPassing = pass ? top.map(x => ({
      title: x.doc.title,
      text: (x.doc.text || "").split(". ").slice(0, 2).join(". "),
      source: x.doc.source || "corpus",
      date: x.doc.date || ""
    })) : [];

    return { pass, chunks: top.map(x => x.doc), chunksPassing };
  } catch (e) {
    console.error("retrieveHybrid error:", e);
    return { pass: false, chunks: [], chunksPassing: [] };
  }
}
