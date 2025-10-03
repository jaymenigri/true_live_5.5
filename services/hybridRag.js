// services/hybridRag.js — v2.7.0 (estável)
// - Lê corpus de /corpus/corpus.json e aliases de /config/aliases.json (se existir)
// - Busca híbrida: TF-IDF + “boost” de título + heurística de semelhança simples
// - Limiar com “rede de segurança”: se nada passar, mas score>=0.18 ou houver forte match no título, aceita
// - Exporta *named* (search) e *default* (compat) para evitar erro de import
// - Não usa lookbehind em regex (compat Node/Heroku)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// -------- util --------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, ".."); // /services -> raiz do app

const CORPUS_PATHS = [
  path.join(ROOT, "corpus", "corpus.json"),
  path.join(ROOT, "data", "corpus.json"),
  path.join(process.cwd(), "corpus", "corpus.json"),
];

const ALIASES_PATHS = [
  path.join(ROOT, "config", "aliases.json"),
  path.join(process.cwd(), "config", "aliases.json"),
];

const STOP = new Set([
  "a","as","o","os","de","da","do","das","dos","e","ou","em","no","na","nos","nas","um","uma","uns","umas",
  "que","com","para","por","se","sobre","ao","à","às","aos","the","of","and","in","on","to","from","is","are","was","were",
]);

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenize = (s) => norm(s).split(" ").filter((t) => t && !STOP.has(t));

// -------- load aliases --------
function loadAliases() {
  for (const p of ALIASES_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf8");
        const data = JSON.parse(raw);
        // normaliza chaves e valores
        const out = {};
        for (const [k, arr] of Object.entries(data)) {
          out[norm(k)] = Array.from(new Set([norm(k), ...arr.map(norm)]));
        }
        console.log("[INFO] Aliases loaded.");
        return out;
      }
    } catch (e) {
      console.warn("[WARN] Could not load aliases:", e.message);
    }
  }
  console.log("[INFO] No aliases file; continuing without.");
  return {};
}
const ALIASES = loadAliases();

// -------- load corpus --------
function loadCorpus() {
  for (const p of CORPUS_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf8");
        const arr = JSON.parse(raw);
        const docs = arr.map((d, idx) => {
          const title = d.title || d.name || d.headline || "";
          const text =
            d.text || d.content || d.body || d.snippet || "";
          const source = d.source || d.url || "corpus";
          const date = d.date || d.published_at || "";
          return {
            id: d.id || `doc-${idx}`,
            title,
            text,
            source,
            date,
            _titleN: norm(title),
            _textN: norm(text),
            _tokens: tokenize(`${title} ${text}`),
          };
        });
        console.log(`[INFO] Corpus loaded: ${docs.length} items.`);
        return docs;
      }
    } catch (e) {
      console.warn("[WARN] Could not load corpus:", e.message);
    }
  }
  console.warn("[WARN] No corpus file found. RAG will always fallback.");
  return [];
}
const CORPUS = loadCorpus();

// -------- tf-idf index --------
const DF = new Map();
for (const d of CORPUS) {
  const seen = new Set(d._tokens);
  for (const t of seen) DF.set(t, (DF.get(t) || 0) + 1);
}
const N = CORPUS.length;

// cosine via term weights
function cosine(qv, dv) {
  let dot = 0,
    nq = 0,
    nd = 0;
  for (const [t, w] of qv) {
    nq += w * w;
    const wd = dv.get(t) || 0;
    dot += w * wd;
  }
  for (const [, w] of dv) nd += w * w;
  if (!dot || !nq || !nd) return 0;
  return dot / (Math.sqrt(nq) * Math.sqrt(nd));
}

function vectorize(tokens) {
  const tf = new Map();
  tokens.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
  const vec = new Map();
  for (const [t, f] of tf) {
    const idf = Math.log(1 + (N || 1) / ((DF.get(t) || 0) + 1));
    vec.set(t, f * idf);
  }
  return vec;
}

// -------- helpers --------
function applyAliases(q) {
  const qn = norm(q);
  let best = qn;
  for (const [canon, variants] of Object.entries(ALIASES)) {
    for (const v of variants) {
      if (qn.includes(v)) {
        best = qn.replace(new RegExp(`\\b${escapeReg(v)}\\b`, "g"), canon);
      }
    }
  }
  return best;
}
const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function titleBoostScore(doc, qn) {
  // +0.15 se todas as palavras do “assunto” aparecerem no título
  const qWords = qn.split(" ").filter(Boolean);
  const hits = qWords.filter((w) => doc._titleN.includes(w)).length;
  if (qWords.length && hits === qWords.length) return 0.15;
  if (hits >= Math.max(1, Math.ceil(qWords.length * 0.6))) return 0.08;
  return 0;
}

function simpleSemantic(qn, doc) {
  // heurística leve: interseção de termos / comprimento
  const qset = new Set(qn.split(" ").filter(Boolean));
  const dset = new Set(doc._tokens);
  let inter = 0;
  for (const t of qset) if (dset.has(t)) inter++;
  if (!qset.size) return 0;
  const jacc = inter / (qset.size + dset.size - inter);
  return jacc * 0.25; // cap baixo
}

function bestSentences(text, qn, max = 2) {
  // split simples, sem lookbehind
  const parts = (text || "").split(/[.!?]\s+/).map((s) => s.trim()).filter(Boolean);
  const q = qn.split(" ").filter(Boolean);
  const score = (s) => {
    const sn = norm(s);
    let c = 0;
    for (const w of q) if (sn.includes(w)) c++;
    return c + Math.min(sn.length / 400, 0.5); // leve preferência por frases completas
  };
  const ranked = parts
    .map((s) => ({ s, sc: score(s) }))
    .sort((a, b) => b.sc - a.sc)
    .slice(0, max)
    .map((x) => x.s.replace(/\s*$/, "."));
  return ranked;
}

function guessSubject(qn) {
  // pega o melhor “nome próprio” em aliases ou 1ª palavra relevante
  for (const canon of Object.keys(ALIASES)) {
    if (qn.includes(canon)) return canon;
    for (const v of ALIASES[canon]) if (qn.includes(v)) return canon;
  }
  const words = qn.split(" ").filter((w) => w.length > 2 && !STOP.has(w));
  return words[0] || qn;
}

// -------- principal --------
export async function search(userQuery, options = {}) {
  const threshold = Number(process.env.RAG_THRESHOLD || options.threshold || 0.4);

  if (!CORPUS.length) {
    return { pass: false, score: 0, subject: null, snippets: [], sources: [] };
  }

  // 1) aliases + normalização
  const queryAliased = applyAliases(userQuery);
  const qTokens = tokenize(queryAliased);
  const qVec = vectorize(qTokens);
  const qNorm = qTokens.join(" ");

  // 2) pontuar docs
  const scored = CORPUS.map((doc) => {
    const dVec = vectorize(doc._tokens);
    let sc = cosine(qVec, dVec);
    sc += titleBoostScore(doc, qNorm);
    sc += simpleSemantic(qNorm, doc);
    return { doc, score: Math.min(1, sc) };
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const top = scored[0];
  const strongTitle = top && titleBoostScore(top.doc, qNorm) >= 0.08;

  // 3) decide “pass”
  const pass = top && (top.score >= threshold || strongTitle || top.score >= 0.18);

  if (!pass) {
    return {
      pass: false,
      score: top ? Number(top.score.toFixed(3)) : 0,
      subject: null,
      snippets: [],
      sources: [],
      resolvedQuery: userQuery,
    };
  }

  // 4) montar resposta com 1–2 frases e fontes
  const take = scored.slice(0, 3);
  const snippets = take.flatMap(({ doc }) => bestSentences(doc.text, qNorm, 1)).slice(0, 3);
  const sources = take.map(({ doc }) => ({
    id: doc.id,
    title: doc.title,
    source: doc.source,
    date: doc.date,
  }));

  const subject = guessSubject(qNorm);

  return {
    pass: true,
    score: Number(top.score.toFixed(3)),
    subject,
    snippets,
    sources,
    resolvedQuery: userQuery,
  };
}

// também exporta default para compatibilidade
export default { search };
