// services/hybridRag.js — híbrido simples com aliases e threshold
import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();
const CORPUS_PATH = path.join(ROOT, "corpus", "corpus.json");
const ALIASES_PATH = path.join(ROOT, "config", "aliases.json");

const THRESH = Number(process.env.RAG_THRESHOLD || "0.4");

// --------- carga de dados ---------
let CORPUS = [];
let ALIASES = {};

function safeLoadJSON(p) {
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      return JSON.parse(raw);
    }
  } catch (_) {}
  return null;
}

function normalize(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyAliases(q) {
  const t = normalize(q);
  for (const [canon, vars] of Object.entries(ALIASES)) {
    const canonN = normalize(canon);
    const list = [canon, ...(vars || [])].map(normalize);
    for (const v of list) {
      // substitui a variação por canônico
      const re = new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      if (re.test(t)) {
        q = q.replace(re, canonN);
      }
    }
  }
  return q;
}

function tokenize(str) {
  return normalize(str).split(" ").filter(Boolean);
}

// BM25 muito simples + cosseno TF-IDF
function buildIndex(chunks) {
  const docs = chunks.map((c, i) => {
    const tokens = tokenize(`${c.title || ""} ${c.text || ""}`);
    return { id: i, tokens, raw: c };
  });
  const df = new Map();
  docs.forEach(d => {
    const uniq = new Set(d.tokens);
    uniq.forEach(t => df.set(t, (df.get(t) || 0) + 1));
  });
  const N = docs.length || 1;
  function score(query) {
    const qTokens = tokenize(query);
    const qFreq = new Map();
    qTokens.forEach(t => qFreq.set(t, (qFreq.get(t) || 0) + 1));

    return docs.map(d => {
      // TF-IDF cosseno (rápido e razoável)
      const tf = new Map();
      d.tokens.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
      let dot = 0, qnorm = 0, dnorm = 0;
      qFreq.forEach((qf, t) => {
        const idf = Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
        const wq = qf * idf;
        const wd = (tf.get(t) || 0) * idf;
        dot += wq * wd;
        qnorm += wq * wq;
      });
      tf.forEach((v, t) => {
        const idf = Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
        dnorm += (v * idf) * (v * idf);
      });
      const cos = dot && qnorm && dnorm ? dot / Math.sqrt(qnorm * dnorm) : 0;
      return { score: cos, chunk: d.raw };
    }).sort((a,b)=>b.score-a.score);
  }
  return { score };
}

function ensureLoaded() {
  if (!CORPUS.length) {
    const c = safeLoadJSON(CORPUS_PATH);
    if (Array.isArray(c)) CORPUS = c;
  }
  if (!Object.keys(ALIASES).length) {
    const a = safeLoadJSON(ALIASES_PATH);
    if (a && typeof a === "object") ALIASES = a;
  }
}

// --------- API pública ---------
export function classifyScope(text = "") {
  const t = normalize(text);
  // alto recall (quase tudo “in/maybe” se tocar em Israel/judaísmo/antisemitismo)
  const inWords = [
    "israel","juda","sion","zion","holocausto","shoah","antisemit","gaza","cisjord","jerusalem",
    "hamas","hezbol","idf","knesset","rabin","ben gurion","golda","yom kipur","sei dias","nakba",
    "west bank","faixa de gaza"
  ];
  if (inWords.some(w => t.includes(normalize(w)))) return "in";
  // se perguntar algo genérico sem nenhuma pista, deixo "out"
  return "out";
}

export async function retrieveHybrid(query, k = 6, preferRecent = false) {
  ensureLoaded();
  if (!CORPUS.length) {
    return { pass: false, chunksPassing: [], top: [] };
  }

  const q = applyAliases(query);
  const index = buildIndex(CORPUS);
  const scored = index.score(q);

  // opcional: levinho bônus de recência se preferRecent = true
  const rescored = scored.map((s) => {
    let bonus = 0;
    if (preferRecent) {
      const d = s.chunk.date ? new Date(s.chunk.date).getTime() : 0;
      if (d) {
        const ageDays = Math.max(1, (Date.now() - d) / (86400 * 1000));
        bonus = 0.02 * (1 / Math.log10(ageDays + 10)); // decai suavemente
      }
    }
    return { ...s, score: s.score + bonus };
  }).sort((a,b)=>b.score-a.score);

  const top = rescored.slice(0, k);
  const chunksPassing = top.filter(x => x.score >= THRESH).map(({chunk,score}) => ({
    text: chunk.text,
    title: chunk.title || chunk.source || "corpus",
    source: chunk.source || "corpus",
    date: chunk.date || null,
    score: Number(score.toFixed(3))
  }));

  return { pass: chunksPassing.length > 0, chunksPassing, top: rescored.slice(0, 10) };
}

// (opcionais para painel/admin — se não usar, ficam no‐op)
export async function ingestRSS() { return { ok: false, note: "RSS ingest not wired in this build." }; }
export async function ingestSitemap() { return { ok: false, note: "Sitemap ingest not wired in this build." }; }
