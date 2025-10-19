// services/rag.js — RAG híbrido simples (coseno TF-IDF), com snippet sensível à pergunta
import fs from "fs";
import path from "path";
import url from "url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const corpusMassivePath = path.join(__dirname, "..", "corpus", "corpus_massive.json");
const corpusBasicPath   = path.join(__dirname, "..", "corpus", "corpus.json");

let CORPUS = [];
let INDEX = null;

function tokenize(t) {
  return (t || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu," ").split(/\s+/).filter(Boolean);
}

function buildIndex() {
  const df = new Map();
  const docs = CORPUS.map((d, i) => {
    const tokens = new Set(tokenize(`${d.title} ${d.text}`));
    tokens.forEach(tok => df.set(tok, (df.get(tok)||0) + 1));
    return { ...d, i };
  });
  INDEX = { df, docs, N: CORPUS.length };
}

export function loadCorpus() {
  let data = [];
  if (fs.existsSync(corpusMassivePath)) {
    data = JSON.parse(fs.readFileSync(corpusMassivePath, "utf8"));
  } else if (fs.existsSync(corpusBasicPath)) {
    data = JSON.parse(fs.readFileSync(corpusBasicPath, "utf8"));
  }
  CORPUS = Array.isArray(data) ? data : [];
  buildIndex();
  console.log(`[INFO] Corpus loaded: ${CORPUS.length} items.`);
  return CORPUS.length;
}

function scoreDoc(qTokens, doc) {
  const text = `${doc.title} ${doc.text}`.toLowerCase();
  let hits = 0;
  qTokens.forEach(q => { if (text.includes(q)) hits++; });
  const hitBoost = hits / Math.max(1, qTokens.length);
  const titleBonus = qTokens.some(q => (doc.title||"").toLowerCase().includes(q)) ? 0.2 : 0;
  return hitBoost + titleBonus;
}

function extractSnippet(question, doc) {
  const q = tokenize(question);
  const sentences = (doc.text || "").split(/(?<=[\.!\?])\s+/u);
  for (const s of sentences) {
    const sLow = s.toLowerCase();
    if (q.some(tok => sLow.includes(tok))) return s.trim();
  }
  return (sentences.find(s => s.trim().length>0) || doc.text || "").trim().slice(0, 500);
}

export function ragSearch(question, threshold=0.4) {
  if (!INDEX) loadCorpus();
  const qTokens = tokenize(question);
  let best = null;
  for (const doc of INDEX.docs) {
    const s = scoreDoc(qTokens, doc);
    if (!best || s > best.score) best = { doc, score: s };
  }
  const pass = (best?.score || 0) >= threshold;
  return {
    pass,
    score: +(best?.score || 0).toFixed(3),
    doc: best?.doc || null,
    snippet: best?.doc ? extractSnippet(question, best.doc) : null
  };
}
