// services/hybridRag.js — v3.0 (estável)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");

const CORPUS_CANDIDATES = [
  path.join(ROOT, "corpus", "corpus.json"),
  path.join(ROOT, "data", "corpus.json"),
  path.join(process.cwd(), "corpus", "corpus.json"),
];

const ALIASES_CANDIDATES = [
  path.join(ROOT, "config", "aliases.json"),
  path.join(process.cwd(), "config", "aliases.json"),
];

const STOP = new Set([
  "a","as","o","os","de","da","do","das","dos","e","ou","em","no","na","nos","nas","um","uma","uns","umas",
  "que","com","para","por","se","sobre","ao","à","às","aos",
  "the","of","and","in","on","to","from","is","are","was","were"
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

// ---------- aliases ----------
function loadAliases() {
  for (const p of ALIASES_CANDIDATES) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const data = JSON.parse(raw);
      const out = {};
      for (const [k, arr] of Object.entries(data)) {
        out[norm(k)] = Array.from(new Set([norm(k), ...arr.map(norm)]));
      }
      console.log("[INFO] Aliases loaded.");
      return out;
    } catch (e) {
      console.warn("[WARN] Aliases load error:", e.message);
    }
  }
  console.log("[INFO] No aliases file; continuing without.");
  return {};
}
const ALIASES = loadAliases();

// ---------- corpus ----------
function loadCorpus() {
  for (const p of CORPUS_CANDIDATES) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const arr = JSON.parse(raw);
      const docs = arr.map((d, i) => {
        const title = d.title || d.name || d.headline || "";
        const text = d.text || d.content || d.body || d.snippet || "";
        const source = d.source || d.url || "corpus";
        const date = d.date || d.published_at || "";
        return {
          id: d.id || `doc-${i}`,
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
    } catch (e) {
      console.warn("[WARN] Corpus load error:", e.message);
    }
  }
  console.warn("[WARN] No corpus file found.");
  return [];
}
const CORPUS = loadCorpus();

// ---------- índice TF-IDF ----------
const DF = new Map();
for (const d of CORPUS) {
  const seen = new Set(d._tokens);
  for (const t of seen) DF.set(t, (DF.get(t) || 0) + 1);
}
const N = CORPUS.length;

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

function cosine(qv, dv) {
  let dot = 0, nq = 0, nd = 0;
  for (const [t, w] of qv) {
    nq += w * w;
    const wd = dv.get(t) || 0;
    dot += w * wd;
  }
  for (const [, w] of dv) nd += w * w;
  if (!dot || !nq || !nd) return 0;
  return dot / (Math.sqrt(nq) * Math.sqrt(nd));
}

// ---------- helpers ----------
const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function applyAliases(q) {
  const qn = norm(q);
  let out = qn;
  for (const [canon, vars] of Object.entries(ALIASES)) {
    for (const v of vars) {
      if (out.includes(v)) out = out.replace(new RegExp(`\\b${escapeReg(v)}\\b`, "g"), canon);
    }
  }
  return out;
}

function titleBoost(doc, qn) {
  const ws = qn.split(" ").filter(Boolean);
  const hits = ws.filter((w) => doc._titleN.includes(w)).length;
  if (!ws.length) return 0;
  if (hits === ws.length) return 0.18;
  if (hits >= Math.ceil(ws.length * 0.6)) return 0.10;
  if (hits >= 1) return 0.05;
  return 0;
}

function simpleSemantic(qn, doc) {
  const qset = new Set(qn.split(" ").filter(Boolean));
  const dset = new Set(doc._tokens);
  let inter = 0;
  for (const t of qset) if (dset.has(t)) inter++;
  if (!qset.size) return 0;
  const j = inter / (qset.size + dset.size - inter);
  return Math.min(0.25, j * 0.25);
}

function splitSentences(text) {
  return (text || "")
    .split(/[.!?]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function scoreSentence(sn, qWords) {
  let c = 0;
  for (const w of qWords) if (sn.includes(w)) c++;
  return c + Math.min(sn.length / 400, 0.5);
}

function bestSnippets(text, qn, max = 2, topicWords = []) {
  const parts = splitSentences(text);
  const qWords = qn.split(" ").filter(Boolean);
  const topic = new Set(topicWords);
  const ranked = parts
    .map((s) => {
      const sn = norm(s);
      const topicHit = [...topic].some((w) => sn.includes(w)) ? 0 : -0.2;
      return { s, sc: scoreSentence(sn, qWords) + topicHit };
    })
    .sort((a, b) => b.sc - a.sc)
    .slice(0, max)
    .map((x) => (/[.!?]$/.test(x.s) ? x.s : x.s + "."));
  return ranked;
}

function guessSubject(qn) {
  for (const [canon, vars] of Object.entries(ALIASES)) {
    if (qn.includes(canon)) return canon;
    for (const v of vars) if (qn.includes(v)) return canon;
  }
  const words = qn.split(" ").filter((w) => w.length > 2 && !STOP.has(w));
  return words[0] || qn;
}

// ---------- Reranking por tema ----------
function topicVector(words) {
  const tf = new Map();
  for (const w of words) tf.set(w, (tf.get(w) || 0) + 1);
  return tf;
}

function topicalityScore(doc, qn) {
  const qWords = qn.split(" ").filter((w) => w.length > 2 && !STOP.has(w));
  if (!qWords.length) return 0;
  const sub = guessSubject(qn);
  const topicWords = Array.from(new Set([...qWords, ...sub.split(" ")]));
  const sents = splitSentences(doc.text).slice(0, 6);
  const tv = topicVector(topicWords);
  const sSc = sents
    .map((s) => {
      const sn = tokenize(s);
      const dv = topicVector(sn);
      return cosine(tv, dv);
    })
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((a, b) => a + b, 0);
  return Math.min(0.3, sSc);
}

// ---------- principal ----------
export async function search(userQuery, options = {}) {
  const threshold = Number(process.env.RAG_THRESHOLD || options.threshold || 0.4);
  if (!CORPUS.length) {
    return { pass: false, score: 0, subject: null, snippets: [], sources: [], resolvedQuery: userQuery };
  }

  const qAliased = applyAliases(userQuery);
  const qTokens = tokenize(qAliased);
  const qVec = vectorize(qTokens);
  const qn = qTokens.join(" ");

  const prelim = CORPUS.map((doc) => {
    const dv = vectorize(doc._tokens);
    let sc = cosine(qVec, dv);
    sc += titleBoost(doc, qn);
    sc += simpleSemantic(qn, doc);
    return { doc, sc: Math.min(1, sc) };
  })
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 8);

  if (!prelim.length) {
    return { pass: false, score: 0, subject: null, snippets: [], sources: [], resolvedQuery: userQuery };
  }

  const reRanked = prelim
    .map(({ doc, sc }) => {
      const tp = topicalityScore(doc, qn);
      const final = sc * 0.85 + tp * 0.15;
      return { doc, sc: final };
    })
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 5);

  const top = reRanked[0];
  const strongTitle = top && titleBoost(top.doc, qn) >= 0.10;
  const pass = top && (top.sc >= threshold || strongTitle || top.sc >= 0.20);

  if (!pass) {
    return {
      pass: false,
      score: Number((top?.sc || 0).toFixed(3)),
      subject: null,
      snippets: [],
      sources: [],
      resolvedQuery: userQuery,
    };
  }

  const subject = guessSubject(qn);
  const topicWords = subject.split(" ").filter(Boolean);
  const take = reRanked.slice(0, 3);
  const rawSnips = take.flatMap(({ doc }) => bestSnippets(doc.text, qn, 1, topicWords));

  const snips = rawSnips.filter((s) => {
    const sn = norm(s);
    return topicWords.some((w) => sn.includes(w));
  });

  const sources = take.map(({ doc }) => ({
    id: doc.id,
    title: doc.title,
    source: doc.source,
    date: doc.date,
  }));

  return {
    pass: true,
    score: Number(top.sc.toFixed(3)),
    subject,
    snippets: snips.length ? snips.slice(0, 3) : rawSnips.slice(0, 2),
    sources,
    resolvedQuery: userQuery,
  };
}

export default { search };
