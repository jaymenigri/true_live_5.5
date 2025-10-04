// services/hybridRag.js — v3.1 (final)
// - Lê corpus base (corpus/corpus.json) + gerado (/tmp/corpus.generated.json) se existir
// - Normaliza campos: id, title/name/headline, text/content/snippet, source/url, date/published_at
// - Query expansion leve por aliases.json (se existir)
// - TF-IDF + cosseno + boost de título; reranking leve por tópico (overlap de n-grams)
// - Sentence split sem lookbehind problemático (compatível Node 20)
// - Gating ESTRITO: pass = (best.score >= threshold)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function safeReadJSON(p) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return null;
}

function normalizeDoc(raw, idx) {
  if (!raw) return null;
  const title = raw.title || raw.name || raw.headline || "";
  const text = raw.text || raw.content || raw.body || raw.snippet || "";
  const source = raw.source || raw.url || "corpus";
  const date = raw.date || raw.published_at || "";
  const id = raw.id || `doc-${idx}`;
  return { id, title: String(title), text: String(text), source: String(source), date: String(date) };
}

function loadAliases() {
  const a1 = path.join(path.dirname(__dirname), "aliases.json");
  const a2 = path.join(process.cwd(), "aliases.json");
  return safeReadJSON(a1) || safeReadJSON(a2) || {};
}

function tokenize(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9áéíóúâêôãõç\s\-]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function ngrams(tokens, n=2) {
  const out = new Set();
  for (let i=0;i+n-1<tokens.length;i++) out.add(tokens.slice(i,i+n).join(" "));
  return out;
}

function firstSentences(text, max = 2) {
  if (!text) return [];
  const out = [];
  let acc = "";
  for (const ch of String(text)) {
    acc += ch;
    if (/[.!?]/.test(ch)) {
      const s = acc.trim();
      if (s) out.push(s);
      acc = "";
      if (out.length >= max) break;
    }
  }
  if (out.length < max) {
    const tail = (acc || "").trim();
    if (tail) out.push(tail);
  }
  return out;
}

function buildTfIdf(docs) {
  const df = new Map(); // term -> doc freq
  const tokenized = [];
  for (const d of docs) {
    const tks = tokenize((d.title || "") + " " + (d.text || ""));
    tokenized.push(tks);
    const seen = new Set(tks);
    seen.forEach(w => df.set(w, (df.get(w) || 0) + 1));
  }
  const N = docs.length || 1;
  const idf = new Map();
  df.forEach((v,k)=> idf.set(k, Math.log((N+1)/(v+1)) + 1));
  return { tokenized, idf, N };
}

function vectorize(tokens, idf) {
  const tf = new Map();
  tokens.forEach(w => tf.set(w, (tf.get(w)||0)+1));
  const vec = new Map();
  tf.forEach((v,k) => vec.set(k, v * (idf.get(k)||1)));
  let norm = 0;
  vec.forEach(v => norm += v*v);
  norm = Math.sqrt(norm)||1;
  return { vec, norm };
}

function cosine(a, b) {
  let dot = 0;
  a.forEach((va,ka)=>{
    const vb = b.get(ka);
    if (vb) dot += va*vb;
  });
  return dot;
}

let CACHE = null;
function loadCorpus() {
  if (CACHE) return CACHE;
  const basePath = path.join(path.dirname(__dirname), "corpus", "corpus.json");
  const tmpPath  = "/tmp/corpus.generated.json";
  const baseRaw = safeReadJSON(basePath) || [];
  const genRaw  = safeReadJSON(tmpPath) || [];
  const all = [...baseRaw, ...genRaw].map(normalizeDoc).filter(Boolean);
  const aliases = loadAliases();
  const tfidf = buildTfIdf(all);
  CACHE = { docs: all, aliases, tfidf };
  console.log("[INFO] RAG loaded:", all.length, "docs.");
  return CACHE;
}

function expandQueryWithAliases(q, aliases) {
  if (!aliases || !Object.keys(aliases).length) return q;
  const low = q.toLowerCase();
  for (const [key, arr] of Object.entries(aliases)) {
    if (low.includes(key)) {
      const extra = (arr||[]).join(" ");
      q += ` ${extra}`;
    }
  }
  return q;
}

export async function search(query, opts = {}) {
  const threshold = Number(opts.threshold || 0.45);
  const { docs, aliases, tfidf } = loadCorpus();

  // Query expand
  let q = expandQueryWithAliases(query || "", aliases).trim();
  const qTokens = tokenize(q);
  const { vec: qvec, norm: qnorm } = vectorize(qTokens, tfidf.idf);

  // Score por doc
  const scored = docs.map((d, i) => {
    const dTokens = tfidf.tokenized[i];
    const { vec: dvec, norm: dnorm } = vectorize(dTokens, tfidf.idf);
    let score = cosine(qvec, dvec) / (qnorm * dnorm || 1);

    // Boost de título: overlap n-gram de 2
    const titleTokens = tokenize(d.title);
    const q2 = ngrams(qTokens, 2);
    const t2 = ngrams(titleTokens, 2);
    let overlap2 = 0;
    q2.forEach(n => { if (t2.has(n)) overlap2 += 1; });
    score += overlap2 * 0.08;

    return { doc: d, score };
  });

  // Ordena por score (top 8) e reranking leve por tópico (overlap no corpo)
  scored.sort((a,b)=> b.score - a.score);
  const top = scored.slice(0, 8);
  const qBody = ngrams(qTokens, 2);
  top.forEach(t => {
    const bodyToks = tokenize(t.doc.text);
    const body2 = ngrams(bodyToks, 2);
    let ov = 0;
    qBody.forEach(n => { if (body2.has(n)) ov += 1; });
    t.score += ov * 0.02;
  });
  top.sort((a,b)=> b.score - a.score);

  const best = top[0];
  const pass = !!(best && best.score >= threshold); // GATING ESTRITO

  // Snippets: 1–2 frases do melhor doc
  let snippets = [];
  let subject = null;
  let sources = [];
  if (best) {
    snippets = firstSentences(best.doc.text, 2);
    subject = best.doc.title || null;
    sources = top.slice(0, 3).map(t => ({ id: t.doc.id, title: t.doc.title, source: t.doc.source, date: t.doc.date, score: Number(t.score.toFixed(3)) }));
  }

  return {
    pass,
    score: best ? Number(best.score.toFixed(3)) : 0,
    subject,
    snippets,
    sources
  };
}
