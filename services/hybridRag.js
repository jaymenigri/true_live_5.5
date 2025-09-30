// services/hybridRag.js — v2.5.1 (final)
// - Lê corpus de corpus/corpus.json (fallback: data/corpus.json, ./corpus.json)
// - Aceita chaves variadas: text|content|body|snippet, title|name|headline, source|url, date|published_at
// - Aliases opcionais em config/aliases.json (variações, sinônimos, grafias)
// - Busca híbrida TF-IDF + cosseno com bônus de título e recência suave quando "agora/hoje"
// - Limiar adaptativo: se nada ≥ threshold mas houver score>=0.18 ou match forte de título, considera "pass"
// - Exposição: loadCorpus(), search(query, opts)

import fs from "fs";
import path from "path";

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const DEFAULT_THRESHOLD = Number(process.env.RAG_THRESHOLD ?? 0.4);

// ---------- util
const log = {
  info: (...a) => (LOG_LEVEL === "info" ? console.log("[INFO] ", ...a) : void 0),
  warn: (...a) => console.warn("[WARN] ", ...a),
  error: (...a) => console.error("[ERROR]", ...a),
};

const toArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const nowTs = () => Date.now();

// ---------- carregar aliases (opcional)
function loadAliases() {
  const aliasPaths = [
    path.join(process.cwd(), "config", "aliases.json"),
    path.join(process.cwd(), "aliases.json"),
  ];
  for (const p of aliasPaths) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf8");
        const obj = JSON.parse(raw);
        if (obj && typeof obj === "object") {
          log.info("Aliases loaded:", Object.keys(obj).length);
          return obj;
        }
      }
    } catch (e) {
      log.warn("Failed to load aliases:", e?.message);
    }
  }
  return {};
}

function applyAliases(q, aliases) {
  if (!aliases || !Object.keys(aliases).length) return q;
  let out = ` ${q} `;
  // substitutes by whole-word, case-insensitive
  for (const [needle, repl] of Object.entries(aliases)) {
    const pattern = new RegExp(`(^|\\W)${escapeReg(needle)}(\\W|$)`, "gi");
    out = out.replace(pattern, `$1${repl}$2`);
  }
  return out.trim();
}
function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- carregar corpus
function normalizeDoc(raw) {
  const title =
    raw.title ?? raw.name ?? raw.headline ?? raw.titulo ?? raw.nome ?? "";
  const text =
    raw.text ?? raw.content ?? raw.body ?? raw.snippet ?? raw.descricao ?? "";
  const source = raw.source ?? raw.url ?? raw.fonte ?? "corpus";
  const date = raw.date ?? raw.published_at ?? raw.data ?? null;
  const id = raw.id ?? `${(title || "").slice(0, 40)}-${Math.random().toString(36).slice(2, 7)}`;
  return { id, title: String(title || "").trim(), text: String(text || "").trim(), source, date };
}

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

let _state = {
  docs: [],
  aliases: {},
  loadedAt: 0,
  originPath: null,
};

export function loadCorpus() {
  const candidates = [
    path.join(process.cwd(), "corpus", "corpus.json"),
    path.join(process.cwd(), "data", "corpus.json"),
    path.join(process.cwd(), "corpus.json"),
  ];
  let found = null;
  let raw = null;
  for (const p of candidates) {
    const j = readJsonMaybe(p);
    if (j) {
      found = p;
      raw = j;
      break;
    }
  }
  if (!raw) {
    log.warn("No corpus file found in:", candidates.join(" | "));
    _state = { docs: [], aliases: loadAliases(), loadedAt: nowTs(), originPath: null };
    return _state;
  }

  const arr = Array.isArray(raw) ? raw : toArr(raw);
  const docs = arr.map(normalizeDoc).filter((d) => d.text || d.title);
  _state = {
    docs,
    aliases: loadAliases(),
    loadedAt: nowTs(),
    originPath: found,
  };
  log.info(`Corpus loaded: ${docs.length} items from ${found}`);
  return _state;
}

// lazy-load on first import
if (_state.docs.length === 0) loadCorpus();

// ---------- tokenização leve
function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

// ---------- TF-IDF simples + vetor
function buildTf(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, va] of a.entries()) {
    const vb = b.get(k) || 0;
    dot += va * vb;
    na += va * va;
  }
  for (const [, vb] of b.entries()) nb += vb * vb;
  return dot === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------- detecção de “agora”
const NOW_HINTS = ["agora", "hoje", "últimas", "ultimas", "ao vivo", "de hoje", "now", "today", "latest", "recent"];
function wantsNow(q) {
  const low = q.toLowerCase();
  return NOW_HINTS.some((h) => low.includes(h));
}

// ---------- busca principal
export function search(query, opts = {}) {
  const threshold = typeof opts.threshold === "number" ? opts.threshold : DEFAULT_THRESHOLD;
  const { docs, aliases } = _state.docs.length ? _state : loadCorpus();

  const originalQuery = query || "";
  const qAliased = applyAliases(originalQuery, aliases);
  const qTokens = tokenize(qAliased);
  const qTf = buildTf(qTokens);

  const needRecent = wantsNow(qAliased);

  const results = [];
  // Pré-tokeniza docs e monta TF para texto e título
  for (const d of docs) {
    const textTokens = tokenize(d.text);
    const titleTokens = tokenize(d.title);
    const tfText = buildTf(textTokens);
    const tfTitle = buildTf(titleTokens);

    // Similaridade cosseno básica
    const sText = cosine(qTf, tfText);
    const sTitle = cosine(qTf, tfTitle);

    // Bônus de título (se bater no título, eleva)
    let score = sText * 0.8 + sTitle * 0.9;

    // Recência suave se pedido “agora/hoje”
    if (needRecent && d.date) {
      const ageDays = Math.max(0, (nowTs() - new Date(d.date).getTime()) / (1000 * 60 * 60 * 24));
      const decay = 1 / (1 + ageDays / 365); // 1 para <= ~1 ano, cai suavemente depois
      score *= 0.85 + 0.15 * decay;
    }

    results.push({
      id: d.id,
      title: d.title,
      text: d.text,
      source: d.source,
      date: d.date,
      score,
      sText,
      sTitle,
    });
  }

  // Ordena por score desc
  results.sort((a, b) => b.score - a.score);

  // Seleciona top N trechos curtos (1–2 frases)
  const top = results.slice(0, 5).map((r) => ({
    ...r,
    snippet: sliceSentences(r.text, 2),
  }));

  // heurística de “pass”
  let pass = top.length > 0 && top[0].score >= threshold;

  // limiar adaptativo: se nada passou, mas
  //  (a) título bateu razoável ou (b) score bruto >= 0.18, aceita
  if (!pass) {
    const t = top[0];
    if (t && (t.sTitle >= 0.22 || t.score >= Math.min(0.18, threshold * 0.6))) {
      pass = true;
    }
  }

  // compacta fontes
  const sources = Array.from(
    new Set(
      top
        .filter((t) => t.score > 0)
        .map((t) => (t.source || "corpus").toString().trim())
    )
  );

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
    },
  };
}

function sliceSentences(text, n = 2) {
  const s = (text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[\.\!\?])\s+(?=[A-ZÀ-ÖØ-Ý])/u);
  return s.slice(0, Math.max(1, n)).join(" ");
}
