// services/hybridRag.js — v2.6 (final)
// - Lê corpus de /corpus/corpus.json aceitando variações de chaves:
//   text|content|body|snippet, title|name|headline, source|url, date|published_at
// - Busca híbrida TF-IDF/cosseno + boost de título
// - Limiar “elástico”: se nada passar mas houver match forte de título, considera pass
// - Resolver de follow-up (pronome “dele/dela/ele/ela” etc.) usando prevSubject
// - Snippets com rede de segurança: nunca vazio quando pass=true

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CORPUS_PATH = path.join(__dirname, "..", "corpus", "corpus.json");
const BASE_THRESHOLD = parseFloat(process.env.RAG_THRESHOLD || "0.5");

// --------------------------
// utilidades
// --------------------------
function norm(s = "") {
  return (s || "")
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tokenize(s = "") {
  return norm(s).split(/[^a-z0-9]+/).filter(w => w.length >= 2);
}

function cosine(aVec, bVec) {
  let dot = 0, a2 = 0, b2 = 0;
  const keys = new Set([...Object.keys(aVec), ...Object.keys(bVec)]);
  for (const k of keys) {
    const av = aVec[k] || 0;
    const bv = bVec[k] || 0;
    dot += av * bv;
    a2 += av * av;
    b2 += bv * bv;
  }
  if (!a2 || !b2) return 0;
  return dot / (Math.sqrt(a2) * Math.sqrt(b2));
}

// --------------------------
// leitura do corpus (flexível)
// --------------------------
function readJSONFlexible(p) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    const arr = JSON.parse(raw);

    return (arr || []).map((item, idx) => {
      const title = item.title || item.name || item.headline || `corpus ${idx}`;
      const text =
        item.text || item.content || item.body || item.snippet || "";
      const source = item.source || item.url || "corpus";
      const date = item.date || item.published_at || "";

      return {
        id: item.id || `corpus-${idx}`,
        title: String(title).trim(),
        text: String(text).trim(),
        source: String(source).trim(),
        date: String(date).trim(),
      };
    }).filter(x => x.text && x.title);
  } catch (e) {
    console.error("[ERROR] hybridRag: failed to read corpus:", e.message);
    return [];
  }
}

const CORPUS = readJSONFlexible(CORPUS_PATH);

// --------------------------
// índice TF-IDF simples
// --------------------------
const DOCS = CORPUS.map(d => ({
  ...d,
  tokens: tokenize(d.title + " " + d.text)
}));

const DF = {};
for (const d of DOCS) {
  const seen = new Set(d.tokens);
  for (const t of seen) DF[t] = (DF[t] || 0) + 1;
}
const N = Math.max(1, DOCS.length);

function tfidfVector(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  const vec = {};
  for (const [t, f] of Object.entries(tf)) {
    const idf = Math.log((N + 1) / ((DF[t] || 0) + 1)) + 1;
    vec[t] = (f / tokens.length) * idf;
  }
  return vec;
}

const DOC_VECS = DOCS.map(d => tfidfVector(d.tokens));

// --------------------------
// follow-up resolver (pronome “dele/dela/ele/ela” etc.)
// --------------------------
function resolveFollowUp(query, prevSubject) {
  if (!prevSubject) return query;
  const qn = norm(query);
  const needs = /\b(ela|ele|dela|dele|seu|sua|deles|delas)\b/.test(qn);
  if (!needs) return query;
  return `${query} (sobre ${prevSubject})`;
}

// --------------------------
// pesquisa híbrida
// --------------------------
function searchInternal(query, { threshold = BASE_THRESHOLD, prevSubject = null, lang = "pt" } = {}) {
  const resolvedQuery = resolveFollowUp(query, prevSubject);
  const qTokens = tokenize(resolvedQuery);
  const qVec = tfidfVector(qTokens);

  // score por cosseno + boost por título (match literal no título)
  const scored = DOCS.map((d, i) => {
    const base = cosine(qVec, DOC_VECS[i]);
    const titleHit = norm(d.title).includes(norm(prevSubject || "")) ||
      norm(d.title).includes(norm(query));
    const titleBoost = titleHit ? 0.12 : 0; // boost leve
    return { doc: d, score: Math.min(1, base + titleBoost) };
  })
  .filter(x => x.score > 0)
  .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 6).map(s => ({
    ...s.doc,
    score: s.score
  }));

  // limiar elástico: se ninguém passou, mas top >= 0.38 e título combina, aceita
  const passed = top.length && (top[0].score >= threshold ||
    (top[0].score >= Math.min(0.38, threshold) &&
      norm(top[0].title).includes(norm(prevSubject || ""))));

  const scope = passed ? "in" : "out";

  return {
    pass: passed,
    score: top[0]?.score || 0,
    scope,
    resolvedQuery,
    topChunks: top
  };
}

// --------------------------
// snippets com rede de segurança (nunca vazio quando pass=true)
// --------------------------
function buildSnippets(topChunks, query, maxSnippets = 4) {
  const snippets = [];

  for (const ch of topChunks) {
    const text = (ch.text || "").trim();
    if (!text) continue;

    // separação por sentenças (A-Z e acentos)
    const sentences = text
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Ý])/u)
      .map(s => s.trim())
      .filter(Boolean);

    const q = (query || "").toLowerCase();
    const terms = q.split(/\W+/).filter(w => w.length >= 3);
    const hits = sentences.filter(s =>
      terms.some(t => s.toLowerCase().includes(t))
    );

    let chosen = [];
    if (hits.length) chosen = hits.slice(0, 2);
    else chosen = sentences.slice(0, 2);

    if (!chosen.length) chosen = [text.slice(0, 320)];

    snippets.push({
      title: ch.title || "corpus",
      text: chosen.join(" "),
      date: ch.date || "",
      score: ch.score ?? 0
    });

    if (snippets.length >= maxSnippets) break;
  }

  if (!snippets.length && topChunks.length) {
    const ch0 = topChunks[0];
    snippets.push({
      title: ch0.title || "corpus",
      text: (ch0.text || "").trim().slice(0, 320),
      date: ch0.date || "",
      score: ch0.score ?? 0
    });
  }

  return snippets;
}

// --------------------------
// API pública
// --------------------------
export async function search({ query, threshold = BASE_THRESHOLD, prevSubject = null, lang = "pt" } = {}) {
  if (!query || !DOCS.length) {
    return { pass: false, score: 0, scope: "out", snippets: [], topChunks: [], resolvedQuery: query || "" };
  }

  const res = searchInternal(query, { threshold, prevSubject, lang });
  const snippets = res.pass ? buildSnippets(res.topChunks, res.resolvedQuery, 4) : [];

  return {
    ...res,
    snippets
  };
}

export function corpusSize() {
  return DOCS.length;
}
