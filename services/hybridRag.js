// services/hybridRag.js — v2.11.0
// - Carrega corpus base (/corpus/corpus.json) + gerado (/tmp/corpus.generated.json)
// - Híbrido TF-IDF/cosseno
// - Threshold estrito: pass = bestScore >= threshold
// - Snippets SENSÍVEIS À PERGUNTA: seleciona sentenças mais relevantes por TF-IDF
// - Boost relacional: se a pergunta é relacional e há prevSubject, favorece docs
//   cujo título sugira o par (ex.: "Leah Rabin" quando subject contém "Rabin")

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -------------------- load corpus --------------------
function tryLoad(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const json = JSON.parse(raw);
    if (Array.isArray(json)) return json;
    if (Array.isArray(json.items)) return json.items;
    return [];
  } catch {
    return [];
  }
}

const baseCorpus = tryLoad(path.join(__dirname, "..", "corpus", "corpus.json"));
const genCorpus  = tryLoad("/tmp/corpus.generated.json");

function normalizeItem(x, i) {
  return {
    id: x.id || `doc-${i}`,
    title: x.title || x.name || x.headline || "(sem título)",
    text: x.text || x.content || x.body || x.snippet || "",
    date: x.date || x.published_at || "",
    source: x.source || x.url || "corpus",
  };
}

const CORPUS = [...baseCorpus, ...genCorpus].map(normalizeItem);
console.log(`[INFO] Corpus loaded: ${CORPUS.length} items.`);

export function corpusSize() { return CORPUS.length; }

// -------------------- tokenização / TF-IDF --------------------
const STOP = new Set([
  // pt
  "a","o","os","as","um","uma","de","do","da","das","dos","e","em","no","na","nos","nas","para","por","que","quem","qual","quais","onde","como","quando","porque","sobre","com","seu","sua","dele","dela","ao","à","às","aos",
  // en
  "the","a","an","of","in","on","for","to","and","or","is","are","was","were","who","what","where","how","when","which","with","by","from",
  // es
  "el","la","los","las","un","una","de","del","y","en","para","por","que","quien","donde","como","cuando","cual","cuales","con",
]);

function normalize(s="") {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function tokenize(s="") {
  return normalize(s)
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñçàãõü\- ]/gi, " ")
    .split(/\s+/)
    .filter(w => w && !STOP.has(w));
}

// documentos vetorizados
const DOC_TOKENS = CORPUS.map(d => tokenize(`${d.title} ${d.text}`));
const DF = new Map();
DOC_TOKENS.forEach(tokens => {
  const uniq = new Set(tokens);
  uniq.forEach(t => DF.set(t, (DF.get(t) || 0) + 1));
});
const N = Math.max(1, CORPUS.length);
const IDF = new Map();
DF.forEach((df, t) => IDF.set(t, Math.log((N + 1) / (df + 0.5))));

function buildVec(tokens) {
  const tf = new Map();
  tokens.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
  const v = new Map();
  tf.forEach((c, t) => v.set(t, c * (IDF.get(t) || 0)));
  return v;
}

const DOC_VEC = DOC_TOKENS.map(buildVec);

function cosine(A, B) {
  let dot = 0, a2 = 0, b2 = 0;
  A.forEach((va, t) => { if (B.has(t)) dot += va * B.get(t); a2 += va * va; });
  B.forEach(vb => { b2 += vb * vb; });
  if (!a2 || !b2) return 0;
  return dot / (Math.sqrt(a2) * Math.sqrt(b2));
}

// -------------------- helpers de assunto & relacional --------------------
function isRelationalQuery(q="") {
  const t = ` ${q.toLowerCase()} `;
  return [
    "esposa","marido","cônjuge","conjuge","filhos","filho","filha","mãe","mae","pai",
    "sogro","sogra","dele","dela","onde nasceu",
    "wife","husband","spouse","children","child","son","daughter","mother","father","parents",
  ].some(k => t.includes(k));
}

function subjectFromTitle(title="") {
  const beforeParen = title.split("(")[0];
  return beforeParen.split("—")[0].split("-")[0].trim() || title;
}

function relationalTitleBoost(title, prevSubject) {
  if (!prevSubject) return 0;
  const t = normalize(title).toLowerCase();
  const s = normalize(prevSubject).toLowerCase();
  // heurística: se perguntar algo relacional, documentos com o sobrenome do subject ou
  // com “Leah”, “Paula”, “Família”, “Family”, “Spouse”, etc. ganham ponto extra.
  let boost = 0;
  if (t.includes(s.split(" ").slice(-1)[0])) boost += 0.05;
  if (/(leah|paula|fam[ií]lia|family|spouse|wife|husband)/i.test(title)) boost += 0.07;
  return boost;
}

// -------------------- snippets sensíveis à pergunta --------------------
function splitSentences(text="") {
  // versão simples e robusta (evita lookbehind)
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return [];
  // mantém ponto final nos fragmentos subsequentes
  const parts = flat.split(/[\.\!\?]\s+/);
  return parts.map((p, i) => (i < parts.length - 1 ? p + "." : p)).filter(Boolean);
}

function sentenceScore(sent, qTokens, relWeight=1) {
  if (!sent) return 0;
  const stoks = tokenize(sent);
  if (!stoks.length) return 0;
  let s = 0;
  qTokens.forEach(t => {
    const tf = stoks.filter(x => x === t).length;
    if (tf > 0) s += tf * (IDF.get(t) || 0);
  });
  // pequenos boosts se a sentença contém marcadores relacionais
  if (relWeight > 1 && /(esposa|marido|filho|filha|m[ãa]e|pai|wife|husband|children|mother|father|parents)/i.test(sent)) {
    s *= relWeight;
  }
  return s;
}

function bestSentencesForQuery(text, query, maxSent = 3, isRel=false) {
  const qTokens = tokenize(query);
  const sents = splitSentences(text).slice(0, 40); // corta para desempenho
  if (!sents.length) return "";

  const relWeight = isRel ? 1.6 : 1.0;
  const scored = sents
    .map((s, idx) => ({ idx, s, score: sentenceScore(s, qTokens, relWeight) }))
    .sort((a,b) => b.score - a.score);

  // se nada casou, devolve as 2 primeiras para contexto básico
  const top = (scored[0]?.score || 0) > 0 ? scored.slice(0, maxSent) : sents.slice(0, Math.min(2, sents.length)).map((s, i) => ({ idx:i, s }));

  // mantém ordem original
  const ordered = [...top].sort((a,b) => a.idx - b.idx).map(x => x.s.trim());
  return ordered.join(" ");
}

// -------------------- busca pública --------------------
export async function search({ query, threshold = 0.5, prevSubject = null, lang = "pt" } = {}) {
  const q = (query || "").trim();
  const qTokens = tokenize(q);
  const qVec = buildVec(qTokens);

  // ranqueia documentos por cosseno
  const baseScores = DOC_VEC.map((dv, i) => ({ i, score: cosine(qVec, dv) }));

  const relational = isRelationalQuery(q);
  // aplica boosts de título quando relacional e há subject ativo
  const boosted = baseScores.map(({ i, score }) => {
    let s = score;
    if (relational && prevSubject) s += relationalTitleBoost(CORPUS[i].title, prevSubject);
    // leve boost se o título contém termos da pergunta
    const titleTok = tokenize(CORPUS[i].title);
    const overlap = qTokens.filter(t => titleTok.includes(t)).length;
    if (overlap) s += Math.min(0.05, overlap * 0.01);
    return { i, score: s };
  });

  boosted.sort((a,b) => b.score - a.score);

  const best = boosted[0] || { i: 0, score: 0 };
  const pass = (best.score || 0) >= threshold;

  // top-k para contexto
  const topIdx = boosted.slice(0, 3).map(s => s.i);

  // monta snippets por pergunta (question-aware)
  const topDocs = topIdx.map(i => {
    const d = CORPUS[i];
    const snippet = bestSentencesForQuery(d.text, q, 3, relational);
    return {
      id: d.id,
      title: d.title,
      text: snippet || d.text.slice(0, 600),
      source: d.source,
      date: d.date,
      score: boosted.find(s => s.i === i)?.score || 0,
    };
  });

  // subject
  let subject = null;
  if (pass) {
    subject = subjectFromTitle(CORPUS[best.i].title);
  } else if (relational && prevSubject) {
    subject = prevSubject; // herda para perguntas do tipo “esposa dele?”
  }

  return {
    pass,
    bestScore: best.score || 0,
    subject,
    topDocs,
    resolvedQuery: q,
  };
}

// compat: default
export default { search, corpusSize };
