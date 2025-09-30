// services/hybridRag.js — v2.5.2 (estável)
// - Carrega corpus de: corpus/corpus.json OR data/corpus.json OR ./corpus.json
// - Aceita chaves: text|content|body|snippet, title|name|headline, source|url, date|published_at
// - Aliases opcionais (config/aliases.json)
// - Busca TF-IDF + cosseno, bônus de título e leve bônus de recência
// - Divisão de sentenças SEM lookbehind (compatível com Node 20/Heroku)
// - Compatível com server.js v2.6.0 (usa search() + loadCorpus())

import fs from "fs";
import path from "path";

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const DEFAULT_THRESHOLD = Number(process.env.RAG_THRESHOLD ?? 0.4);

const log = {
  info:  (...a) => { if (["debug","info"].includes(LOG_LEVEL)) console.log("[INFO] ", ...a); },
  debug: (...a) => { if (LOG_LEVEL === "debug") console.log("[DEBUG]", ...a); },
  warn:  (...a) => console.warn("[WARN] ", ...a),
  error: (...a) => console.error("[ERROR]", ...a),
};

const ROOT = process.cwd();
const CORPUS_CANDIDATES = [
  path.join(ROOT, "corpus", "corpus.json"),
  path.join(ROOT, "data", "corpus.json"),
  path.join(ROOT, "corpus.json"),
];
const ALIASES_PATH = path.join(ROOT, "config", "aliases.json");

let STATE = {
  docs: [],
  aliases: {},
  loadedAt: 0,
  originPath: null,
};

// ---------- util ----------
const nowTs = () => Date.now();
const toArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

function readJsonMaybe(p) {
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    log.warn("Failed to read json:", p, e?.message);
  }
  return null;
}

function pickFirst(obj, keys, fallback = "") {
  for (const k of keys) if (obj && obj[k] != null) return String(obj[k]);
  return fallback;
}

function normalizeDoc(raw) {
  const title  = pickFirst(raw, ["title","name","headline","titulo","nome"], "");
  const text   = pickFirst(raw, ["text","content","body","snippet","descricao"], "");
  const source = pickFirst(raw, ["source","url","fonte"], "corpus");
  const date   = pickFirst(raw, ["date","published_at","data"], null);
  const id     = raw?.id ?? `${(title || "").slice(0, 40)}-${Math.random().toString(36).slice(2, 7)}`;
  if (!text && !title) return null;
  return { id, title: String(title || source).trim(), text: String(text || "").trim(), source, date };
}

function loadAliasesInternal() {
  try {
    if (fs.existsSync(ALIASES_PATH)) {
      const raw = fs.readFileSync(ALIASES_PATH, "utf8");
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") {
        log.info("Aliases loaded:", Object.keys(obj).length);
        return obj;
      }
    }
  } catch (e) {
    log.warn("Failed to load aliases:", e?.message);
  }
  return {};
}

export function loadCorpus() {
  let found = null;
  let raw = null;
  for (const p of CORPUS_CANDIDATES) {
    const j = readJsonMaybe(p);
    if (j) { found = p; raw = j; break; }
  }
  const arr = raw ? (Array.isArray(raw) ? raw : toArr(raw)) : [];
  const docs = arr.map(normalizeDoc).filter(Boolean);
  STATE = {
    docs,
    aliases: loadAliasesInternal(),
    loadedAt: nowTs(),
    originPath: found,
  };
  if (found) log.info(`Corpus loaded: ${docs.length} items from ${found}`);
  else log.info("Corpus NOT found. Checked:", CORPUS_CANDIDATES.join(" | "));
  return STATE;
}

// lazy load
if (STATE.docs.length === 0) loadCorpus();

// ---------- texto/tokenização ----------
function normalize(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s) { return normalize(s).split(" ").filter(Boolean); }

function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function applyAliases(q, aliases) {
  if (!aliases || !Object.keys(aliases).length) return q;
  let out = ` ${q} `;
  for (const [needle, repl] of Object.entries(aliases)) {
    const pattern = new RegExp(`(^|\\W)${escapeReg(needle)}(\\W|$)`, "gi");
    out = out.replace(pattern, `$1${repl}$2`);
  }
  return out.trim();
}

// ---------- TF-IDF + cosseno ----------
function buildTf(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, va] of a.entries()) {
    const vb = b.get(k) || 0;
    dot += va * vb;
    na += va * va;
  }
  for (const [, vb] of b.entries()) nb += vb * vb;
  return dot === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function hasTitleHit(query, chunkTitle) {
  if (!chunkTitle) return false;
  const q = new Set(tokenize(query));
  let hits = 0;
  for (const tok of tokenize(chunkTitle)) if (q.has(tok)) hits++;
  const tLen = tokenize(chunkTitle).length;
  return hits >= 2 || (hits >= 1 && tLen <= 3);
}

// ---------- “agora/hoje” ----------
const NOW_HINTS = ["agora", "hoje", "últimas", "ultimas", "ao vivo", "de hoje", "now", "today", "latest", "recent"];
function wantsNow(q) { const low=q.toLowerCase(); return NOW_HINTS.some(h=>low.includes(h)); }

// ---------- divisão de sentenças (sem lookbehind) ----------
function splitIntoSentences(text, maxSentences = 2) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  // Divide por padrões finais . ! ? , preservando o delimitador
  const parts = cleaned.match(/[^.!?]+[.!?]*/g) || [cleaned];
  return parts.slice(0, Math.max(1, maxSentences)).map(s => s.trim()).join(" ");
}

// ---------- busca principal ----------
export function search(query, opts = {}) {
  const { docs, aliases } = STATE.docs.length ? STATE : loadCorpus();
  const threshold = typeof opts.threshold === "number" ? opts.threshold : DEFAULT_THRESHOLD;

  const originalQuery = query || "";
  const qAliased = applyAliases(originalQuery, aliases);
  const qTokens = tokenize(qAliased);
  const qTf = buildTf(qTokens);

  const needRecent = wantsNow(qAliased);

  const results = [];
  for (const d of docs) {
    const tText = tokenize(d.text);
    const tTitle = tokenize(d.title);

    const tfText = buildTf(tText);
    const tfTitle = buildTf(tTitle);

    const sText = cosine(qTf, tfText);
    const sTitle = cosine(qTf, tfTitle);

    let score = sText * 0.8 + sTitle * 0.9;

    // bônus leve de recência
    if (needRecent && d.date) {
      const parsed = Date.parse(d.date);
      if (!Number.isNaN(parsed)) {
        const ageDays = Math.max(0, (nowTs() - parsed) / 86400000);
        const decay = 1 / (1 + ageDays / 365);
        score *= 0.85 + 0.15 * decay;
      }
    }

    // bônus de título
    if (hasTitleHit(qAliased, d.title)) score += 0.12;

    results.push({
      id: d.id,
      title: d.title,
      text: d.text,
      source: d.source,
      date: d.date,
      score,
      sText,
      sTitle
    });
  }

  results.sort((a,b)=>b.score-a.score);

  const top = results.slice(0, 5).map(r => ({
    ...r,
    snippet: splitIntoSentences(r.text, 2),
  }));

  // regra de passagem
  let pass = top.length > 0 && top[0].score >= threshold;

  // limiar adaptativo (nomes próprios, etc.)
  if (!pass && top.length) {
    const b = top[0];
    if (b.sTitle >= 0.22 || b.score >= Math.min(0.18, threshold * 0.6)) {
      pass = true;
    }
  }

  const sources = Array.from(new Set(top.filter(t=>t.score>0).map(t=>(t.source||"corpus").toString().trim())));

  return {
    pass,
    chunks: top,
    sources,
    debug: {
      q: qAliased,
      threshold,
      best: top[0] ? { title: top[0].title, score: Number(top[0].score.toFixed(3)), sTitle: Number(top[0].sTitle.toFixed(3)) } : null,
      corpusItems: docs.length,
      needRecent,
    }
  };
}

// Placeholders para ingest (não usados neste build)
export async function ingestRSS(){ return { ok:false, note:"not wired in this build" }; }
export async function ingestSitemap(){ return { ok:false, note:"not wired in this build" }; }
