// services/hybridRag.js — v2.6 (final)
// - Carrega corpus de ./corpus/corpus.json (campos flexíveis)
// - Aliases opcionais (./config/aliases.json)
// - Busca híbrida (TF-IDF + cosseno) com boost de título
// - Coref: reescreve perguntas relacionais com base no último sujeito
// - Limiar adaptativo (se houver forte match de título)
// - Sem lookbehind em regex (compatível Node 20.x)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CORPUS_FILE = path.join(__dirname, "..", "corpus", "corpus.json");
const ALIASES_FILE = path.join(__dirname, "..", "config", "aliases.json");

// ----------------------- utilidades --------------------------------
function readJSONSafe(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeDoc(raw, idx) {
  const id = raw.id || `doc-${idx + 1}`;
  const title = raw.title || raw.name || raw.headline || "";
  const text = raw.text || raw.content || raw.body || raw.snippet || "";
  const source = raw.source || raw.url || "corpus";
  const date = raw.date || raw.published_at || "";
  return { id, title, text, source, date };
}

function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9áéíóúãõñçü\- ]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const va = a[k] || 0;
    const vb = b[k] || 0;
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function tf(tokens) {
  const map = Object.create(null);
  for (const t of tokens) map[t] = (map[t] || 0) + 1;
  const out = Object.create(null);
  const N = tokens.length || 1;
  for (const k in map) out[k] = map[k] / N;
  return out;
}

// ---------------------- carregar corpus -----------------------------
const rawCorpus = Array.isArray(readJSONSafe(CORPUS_FILE)) ? readJSONSafe(CORPUS_FILE) : [];
export function corpusCount() { return rawCorpus.length; }
const corpus = rawCorpus.map(normalizeDoc);

const aliases = readJSONSafe(ALIASES_FILE) || {};
const aliasPairs = Object.entries(aliases).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]);

console.log(`[INFO] Corpus loaded: ${corpus.length} items.`);

// index simples para título e corpo
const docs = corpus.map(d => {
  const titleTok = tokenize(d.title);
  const textTok = tokenize(d.text);
  return {
    ...d,
    titleTok,
    textTok,
    tfTitle: tf(titleTok),
    tfText: tf(textTok)
  };
});

// -------------------- coref / rewrite -------------------------------
function rewriteWithContext(query, prevSubject, lang = "pt") {
  if (!prevSubject) return query;

  const q = query.trim();

  const patterns = [
    // esposa dele
    { re: /\b(esposa|mulher|cônjuge)\s+dele\b/i, out: `esposa de ${prevSubject}` },
    { re: /\b(wife)\s+of\s+him\b/i, out: `wife of ${prevSubject}` },
    { re: /\b(su|suya|esposa)\s+de\s+él\b/i, out: `esposa de ${prevSubject}` },

    // onde ele nasceu / where was he born
    { re: /\bonde\s+ele\s+nasceu\b/i, out: `onde nasceu ${prevSubject}` },
    { re: /\bwhere\s+was\s+he\s+born\b/i, out: `where was ${prevSubject} born` },
    { re: /\bdónde\s+nació\s+él\b/i, out: `dónde nació ${prevSubject}` },

    // quando ele morreu
    { re: /\bquando\s+ele\s+morreu\b/i, out: `quando morreu ${prevSubject}` },
    { re: /\bwhen\s+did\s+he\s+die\b/i, out: `when did ${prevSubject} die` },
    { re: /\bcuándo\s+murió\s+él\b/i, out: `cuándo murió ${prevSubject}` },

    // genérico: dele/dela -> de {prevSubject}
    { re: /\bdele\b/i, out: `de ${prevSubject}` },
    { re: /\bdela\b/i, out: `de ${prevSubject}` },
    { re: /\bhis\b/i, out: `${prevSubject}'s` },
    { re: /\bher\b/i, out: `${prevSubject}'s` }
  ];

  let out = q;
  for (const p of patterns) {
    out = out.replace(p.re, p.out);
  }

  // Se a pergunta ficou muito curta e contém “ele/ela”, adiciona o sujeito no final
  if (/\b(ele|ela|he|she)\b/i.test(out) && out.length < 60) {
    out = `${out} (${prevSubject})`;
  }
  return out;
}

function applyAliases(text) {
  let s = text.toLowerCase();
  for (const [a, b] of aliasPairs) {
    s = s.replace(new RegExp(`\\b${escapeRegExp(a)}\\b`, "g"), b);
  }
  return s;
}

function escapeRegExp(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// ------------------------- busca -----------------------------------
export async function hybridSearch(query, opts = {}) {
  const lang = opts.lang || "pt";
  const prevSubject = opts.prevSubject || null;
  const thr = typeof opts.threshold === "number" ? opts.threshold : 0.4;

  const resolvedQuery = rewriteWithContext(query, prevSubject, lang);
  const qAliased = applyAliases(resolvedQuery);
  const qTok = tokenize(qAliased);
  const qTf = tf(qTok);

  let best = [];
  for (const d of docs) {
    const scoreTitle = cosine(qTf, d.tfTitle);
    const scoreText = cosine(qTf, d.tfText);
    // boost de título
    const score = scoreText * 0.7 + scoreTitle * 0.3 + Math.min(scoreTitle, 0.25);
    best.push({ id: d.id, title: d.title, score, source: d.source, date: d.date, text: d.text });
  }
  best.sort((a, b) => b.score - a.score);

  const top = best[0] || null;
  const topScore = top?.score || 0;

  // limiar adaptativo: se o título do top doc aparece no query, afrouxa
  const titleHit = top?.title ? qAliased.includes(top.title.toLowerCase()) : false;
  const pass = topScore >= thr || (titleHit && topScore >= Math.max(0.18, thr - 0.15));

  if (!pass) {
    return { pass: false, resolvedQuery, topScore };
  }

  // montar resposta com 1–2 frases do texto
  const snippet = makeSnippet(top.text, qTok);
  const answer = snippet;

  // “assunto” candidato pro histórico
  const subject = top.title?.split("—")[0]?.trim() || top.title || null;

  const sources = [top.title || top.id].filter(Boolean);

  return {
    pass: true,
    resolvedQuery,
    topScore,
    topTitle: top.title,
    subject,
    answer,
    sources
  };
}

// split de frases sem lookbehind
function splitSentences(text = "") {
  const safe = String(text).replace(/\s+/g, " ").trim();
  if (!safe) return [];
  // divide por ponto, interrogação, exclamação seguidos de espaço
  return safe.split(/([\.!?])\s+/).reduce((acc, part, i, arr) => {
    if (i % 2 === 0) {
      const punc = arr[i + 1] || "";
      acc.push((part + punc).trim());
    }
    return acc;
  }, []).filter(Boolean);
}

function makeSnippet(fullText, qTokens, maxChars = 550) {
  const sentences = splitSentences(fullText);
  if (!sentences.length) return fullText.slice(0, maxChars);

  // prioridade para frases que contêm algum token da query
  const scores = sentences.map((s) => {
    const st = tokenize(s);
    const overlap = st.filter(t => qTokens.includes(t)).length;
    return { s, overlap };
  });
  scores.sort((a, b) => b.overlap - a.overlap);

  const picked = [];
  for (const item of scores) {
    picked.push(item.s);
    if (picked.join(" ").length > maxChars || picked.length >= 2) break;
  }
  return picked.join(" ");
}
