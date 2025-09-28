// services/hybridRag.js — v2.1.5 (híbrido leve com normalização, aliases e boosts)

import fs from "fs";
import path from "path";

// ===== config =====
const RAG_THRESHOLD = Number(process.env.RAG_THRESHOLD || "0.4");
const MAX_CHUNKS = 6;

// ===== helpers =====
const stripAccents = s => (s || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase();

const clean = s => stripAccents(String(s || "").replace(/[^\p{L}\p{N}\s-]/gu, " ")).replace(/\s+/g, " ").trim();

function loadJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { return null; }
}

// carrega corpus e aliases
const corpusPath = path.join(process.cwd(), "corpus", "corpus.json");
const aliasesPath = path.join(process.cwd(), "config", "aliases.json");
const CORPUS = loadJSON(corpusPath) || [];
const ALIASES = (() => {
  const a = loadJSON(aliasesPath) || {};
  // normaliza chaves para lower-case sem acento
  const out = {};
  for (const [k, v] of Object.entries(a)) out[clean(k)] = (v || "").toLowerCase();
  return out;
})();

// dicionário de entidades para boost (nomes que aparecem em títulos)
const ENTITY_CANONICALS = new Set(
  CORPUS.map(c => clean((c.title || "").split("—")[0])).filter(Boolean)
);

// tokenização simples
const tokenize = (s) => clean(s).split(" ").filter(Boolean);

// bigramas para fuzzy leve
const bigrams = (tokens) => {
  const arr = [];
  for (let i = 0; i < tokens.length - 1; i++) arr.push(tokens[i] + " " + tokens[i + 1]);
  return arr;
};

// BM25-lite (idf simples + tf normalizado)
function scoreBM25Lite(qTokens, dTokens) {
  if (!qTokens.length || !dTokens.length) return 0;
  const D = dTokens.length;
  let score = 0;
  const df = {}; // doc freq aproximado dentro do próprio doc (ok p/ heurística)
  dTokens.forEach(t => { df[t] = 1; });
  const idf = t => 1 / (1 + (df[t] ? 1 : 0.2)); // se termo aparece no doc, idf menor
  const tf = t => dTokens.filter(x => x === t).length / D;
  for (const t of qTokens) score += idf(t) * Math.sqrt(tf(t));
  return score;
}

// aplica aliases numa string já "clean"
function applyAliasesClean(s) {
  let out = s;
  // substituição conservadora: palavras inteiras
  for (const [from, to] of Object.entries(ALIASES)) {
    const re = new RegExp(`\\b${from}\\b`, "g");
    out = out.replace(re, clean(to));
  }
  return out;
}

// ===== API principal =====
export function classifyScope(q) {
  const t = (q || "").toLowerCase();
  return /(israel|sion|zion|juda|antisemit|sho|holoc|yom|kippur|hamas|hezb|idf|idf|jvl|yad|jerus|tel aviv|rabin|ben-?gurion|golda|meir|shalom)/.test(stripAccents(t))
    ? "in" : "out";
}

export async function ingestRSS() {
  // stub (seu implementado real pode estar noutro módulo)
  return { added: 0, total: 0 };
}
export async function ingestSitemap() {
  return { added: 0, total: 0 };
}

export async function retrieveHybrid(query, k = MAX_CHUNKS, preferRecency = false) {
  try {
    // normaliza e aplica aliases
    let qClean = clean(query);
    qClean = applyAliasesClean(qClean);
    const qTokens = tokenize(qClean);
    const qBigrams = bigrams(qTokens);

    // tentativa de detectar entidade canônica na query
    let entityBoostHit = false;
    for (const ent of ENTITY_CANONICALS) {
      if (ent && qClean.includes(ent)) { entityBoostHit = ent; break; }
    }

    const scored = [];
    for (const doc of CORPUS) {
      const text = `${doc.title || ""}. ${doc.text || ""}`;
      // normaliza doc inteiro (e aplica aliases para casamentos consistentes)
      const dClean = applyAliasesClean(clean(text));
      const dTokens = tokenize(dClean);
      const dBigrams = bigrams(dTokens);

      // score lexical base
      let s = scoreBM25Lite(qTokens, dTokens);

      // fuzzy leve por bigramas
      let matchBigrams = 0;
      for (const bg of qBigrams) if (dBigrams.includes(bg)) matchBigrams++;
      s += 0.4 * (matchBigrams / Math.max(1, qBigrams.length)); // peso moderado

      // boost se o título contém explicitamente a entidade canônica
      const titleClean = clean(doc.title || "");
      if (entityBoostHit && titleClean.includes(entityBoostHit)) s += 0.7;

      // leve bônus de recência (se pedido e houver data reconhecível)
      if (preferRecency && doc.date) {
        const y = parseInt(String(doc.date).slice(0, 4), 10);
        if (!isNaN(y)) s += Math.max(0, (y - 1948)) * 0.001; // bônus pequeno por ano
      }

      scored.push({
        doc,
        score: s
      });
    }

    // ordena por score desc
    scored.sort((a, b) => b.score - a.score);

    // reranking: corta no top k e calcula passagem vs limiar
    const top = scored.slice(0, k);
    const pass = (top[0]?.score || 0) >= RAG_THRESHOLD;

    // debug visível no Heroku
    console.log("RAG top:", top.slice(0, 3).map(x => ({ title: x.doc.title, score: +x.score.toFixed(3) })));
    console.log("RAG pass:", pass, "threshold:", RAG_THRESHOLD, "query:", query);

    // prepara chunks para o gerador
    const chunksPassing = pass ? top.map(x => ({
      title: x.doc.title,
      text: (x.doc.text || "").split(". ").slice(0, 2).join(". "), // 1–2 frases
      source: (x.doc.source || "corpus"),
      date: x.doc.date || ""
    })) : [];

    return {
      pass,
      chunks: top.map(x => x.doc),
      chunksPassing
    };
  } catch (e) {
    console.error("retrieveHybrid error:", e);
    return { pass: false, chunks: [], chunksPassing: [] };
  }
}
