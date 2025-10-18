import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return []; }
}

const corpusPath = path.join(__dirname, "..", "corpus", "corpus.json");
let CORPUS = loadJSON(corpusPath);
export function reloadCorpus(extra = []) {
  CORPUS = loadJSON(corpusPath);
  if (Array.isArray(extra) && extra.length) {
    const map = new Map();
    for (const it of [...CORPUS, ...extra]) map.set(it.id || it.title, it);
    CORPUS = Array.from(map.values());
  }
  return CORPUS.length;
}

const aliasesPath = path.join(__dirname, "..", "config", "aliases.json");
const ALIASES = (() => {
  try { return JSON.parse(fs.readFileSync(aliasesPath, "utf-8")); } catch { return {}; }
})();

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandQuery(q) {
  const n = norm(q);
  const add = new Set([n]);
  for (const [k, vals] of Object.entries(ALIASES)) {
    const kn = norm(k);
    if (n.includes(kn) || kn.includes(n)) {
      add.add(kn);
      for (const v of vals) add.add(norm(v));
    }
  }
  return Array.from(add);
}

function tfidfScore(queryTerms, text) {
  const tokens = norm(text).split(" ");
  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t)||0)+1);
  let score = 0;
  for (const qt of queryTerms) {
    const w = (freq.get(qt)||0);
    if (w) score += 1 + Math.log(1+w);
  }
  const len = Math.sqrt(tokens.length || 1);
  return score / len;
}

function bestSentences(qTerms, text) {
  const parts = String(text).replace(/\s+/g," ").split(/(?:(?:\.|\!|\?)+)\s+/);
  const scored = parts.map(s => {
    const n = norm(s);
    let hit = 0;
    for (const t of qTerms) if (n.includes(t)) hit++;
    return { s, hit, len: s.length };
  }).filter(x => x.s && x.s.trim().length > 0);
  scored.sort((a,b) => (b.hit - a.hit) || (a.len - b.len));
  const top = scored.slice(0,2).map(x => x.s.trim());
  return top.length ? top.join(" ") : parts.slice(0,2).join(" ");
}

export function search(userQuery, { threshold = 0.4 } = {}) {
  const expanded = expandQuery(userQuery);
  const qTerms = Array.from(new Set(expanded.join(" ").split(" ").filter(Boolean)));

  const scored = CORPUS.map(doc => {
    const titleBoost = tfidfScore(qTerms, doc.title || "") * 2.0;
    const bodyScore = tfidfScore(qTerms, doc.text || "");
    const score = titleBoost + bodyScore;
    return {
      id: doc.id,
      title: doc.title,
      source: doc.source,
      date: doc.date || "",
      score,
      snippet: bestSentences(qTerms, (doc.text || ""))
    };
  }).sort((a,b) => b.score - a.score);

  const top = scored.slice(0, 3);
  const pass = (top[0]?.score || 0) >= threshold;
  return { pass, top, score: Number((top[0]?.score || 0).toFixed(3)) };
}
