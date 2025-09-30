// services/hybridRag.js — v2.5 (definitivo)
// - Lê corpus de /corpus/corpus.json aceitando variações de chaves:
//   text|content|body|snippet, title|name|headline, source|url, date|published_at
// - Busca híbrida TF-IDF/cosseno + boost de título
// - Limiar adaptativo: se nada passar, mas houver match forte de título ou score>=0.18, considera "pass"
// - Compatível com server.js v2.4.0

import fs from "fs";
import path from "path";

// ---------- ENV / PATHS ----------
const ROOT = process.cwd();
const CORPUS_PATH = path.join(ROOT, "corpus", "corpus.json");
const ALIASES_PATH = path.join(ROOT, "config", "aliases.json");
const THRESH = Number(process.env.RAG_THRESHOLD || "0.4");

// ---------- MEMÓRIA ----------
let CORPUS = [];
let ALIASES = {};

// ---------- UTILS ----------
function safeLoadJSON(p) {
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      return JSON.parse(raw);
    }
  } catch {}
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

function pickFirst(obj, keys, fallback = "") {
  for (const k of keys) {
    if (obj && obj[k] != null) return String(obj[k]);
  }
  return fallback;
}

function coerceCorpusItem(it) {
  // aceitar chaves variadas e produzir uma forma canônica
  const text = pickFirst(it, ["text", "content", "body", "snippet"]).trim();
  const title = pickFirst(it, ["title", "name", "headline"]).trim();
  const source = pickFirst(it, ["source", "url"]).trim() || "corpus";
  const date = pickFirst(it, ["date", "published_at"]).trim() || null;
  // descarta itens sem texto
  if (!text) return null;
  return { text, title: title || source, source, date };
}

function ensureLoaded() {
  if (!CORPUS.length) {
    const raw = safeLoadJSON(CORPUS_PATH);
    if (Array.isArray(raw)) {
      CORPUS = raw.map(coerceCorpusItem).filter(Boolean);
    }
  }
  if (!Object.keys(ALIASES).length) {
    const a = safeLoadJSON(ALIASES_PATH);
    if (a && typeof a === "object") ALIASES = a;
  }
}

function tokenize(str) {
  return normalize(str).split(" ").filter(Boolean);
}

function applyAliases(q) {
  const nq = normalize(q);
  let out = nq;
  for (const [canon, vars] of Object.entries(ALIASES)) {
    const canonN = normalize(canon);
    const list = [canon, ...(vars || [])].map(normalize);
    for (const v of list) {
      const re = new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      if (re.test(out)) out = out.replace(re, canonN);
    }
  }
  return out;
}

function buildIndex(chunks) {
  const docs = chunks.map((c, i) => {
    const tokens = tokenize(`${c.title || ""} ${c.text || ""}`);
    return { id: i, tokens, raw: c };
  });

  // DF
  const df = new Map();
  docs.forEach(d => {
    const uniq = new Set(d.tokens);
    uniq.forEach(t => df.set(t, (df.get(t) || 0) + 1));
  });
  const N = Math.max(1, docs.length);

  function score(query) {
    const qTokens = tokenize(query);
    const qFreq = new Map();
    qTokens.forEach(t => qFreq.set(t, (qFreq.get(t) || 0) + 1));

    return docs.map(d => {
      // TF-IDF cosseno
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

// ---------- Heurísticas extras ----------
function hasTitleHit(query, chunk) {
  if (!chunk?.title) return false;
  const q = tokenize(query);
  const t = tokenize(chunk.title);
  // considera match "forte" se ao menos 2 tokens do título aparecem na consulta
  let hits = 0;
  const tset = new Set(t);
  q.forEach(tok => { if (tset.has(tok)) hits++; });
  return hits >= 2 || (hits >= 1 && t.length <= 3); // nomes curtos
}

function rescoringWithTitleBoost(scored, query) {
  return scored.map(s => {
    let bonus = 0;
    if (hasTitleHit(query, s.chunk)) bonus += 0.12; // empurra nomes próprios
    return { ...s, score: s.score + bonus };
  }).sort((a,b)=>b.score-a.score);
}

// ---------- API pública ----------
export function classifyScope(text = "") {
  const t = normalize(text);
  const inWords = [
    "israel","juda","sion","zion","holocausto","shoah","antisemit",
    "gaza","cisjord","jerusalem","hamas","hezbol","idf","knesset",
    "rabin","ben gurion","ben-gurion","golda","yom kipur","sei dias","nakba",
    "west bank","faixa de gaza","judéia","judeia","samaria"
  ];
  if (inWords.some(w => t.includes(normalize(w)))) return "in";
  return "out";
}

export async function retrieveHybrid(query, k = 6, preferRecent = false) {
  ensureLoaded();
  if (!CORPUS.length) return { pass: false, chunksPassing: [], top: [] };

  const qAliased = applyAliases(query);
  const index = buildIndex(CORPUS);
  // 1) scoring base
  let scored = index.score(qAliased);

  // 2) bônus: título (nomes próprios)
  scored = rescoringWithTitleBoost(scored, qAliased);

  // 3) bônus leve de recência
  if (preferRecent) {
    scored = scored.map(s => {
      let bonus = 0;
      if (s.chunk.date) {
        const t = Date.parse(s.chunk.date);
        if (!isNaN(t)) {
          const ageDays = Math.max(1, (Date.now() - t) / 86400000);
          bonus = 0.02 * (1 / Math.log10(ageDays + 10));
        }
      }
      return { ...s, score: s.score + bonus };
    }).sort((a,b)=>b.score-a.score);
  }

  const top = scored.slice(0, k);
  const chunksPassing = top
    .filter(x => x.score >= THRESH)
    .map(({chunk,score}) => ({
      text: chunk.text,
      title: chunk.title || chunk.source || "corpus",
      source: chunk.source || "corpus",
      date: chunk.date || null,
      score: Number(score.toFixed(3))
    }));

  // 4) Limiar adaptativo: se nada passou, mas o top-1 tem match de título OU score >= 0.18,
  //    ainda assim consideramos "pass" (evita cair em fallback para nomes claros).
  if (chunksPassing.length === 0 && top.length) {
    const t1 = top[0];
    const titleStrong = hasTitleHit(qAliased, t1.chunk);
    if (titleStrong || t1.score >= 0.18) {
      chunksPassing.push({
        text: t1.chunk.text,
        title: t1.chunk.title || t1.chunk.source || "corpus",
        source: t1.chunk.source || "corpus",
        date: t1.chunk.date || null,
        score: Number(t1.score.toFixed(3))
      });
    }
  }

  return { pass: chunksPassing.length > 0, chunksPassing, top: scored.slice(0, 10) };
}

// Ingest (placeholders)
export async function ingestRSS(){ return { ok:false, note:"not wired in this build" }; }
export async function ingestSitemap(){ return { ok:false, note:"not wired in this build" }; }
