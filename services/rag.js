import fs from "fs";

const corpusPath = new URL("../corpus/corpus.json", import.meta.url);
const fontesPath = new URL("../fontes.json", import.meta.url);

let CORPUS = [];
let FONTES = [];

try { CORPUS = JSON.parse(fs.readFileSync(corpusPath, "utf8")); } catch (e) { console.warn("[warn] corpus.json missing"); }
try { FONTES = JSON.parse(fs.readFileSync(fontesPath, "utf8")); } catch (e) { console.warn("[warn] fontes.json missing"); }

export function classifyScope(text) {
  const t = (text || "").toLowerCase();
  const hit = /(israel|zionis|sionis|idf|tsahal|antisemit|judai|hamas|hezbollah|gaza|cisjord|west bank|jerusal|tel aviv|knesset|yom kippur|holocaust|shoah|intifada|golda|meir|zionism)/.test(t);
  return hit ? "in" : "out";
}

function tokenize(s) {
  return (s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function retrieveContext(text, max = 6) {
  const terms = tokenize(text);
  if (!terms.length) return { chunks: [], ratio: 0 };

  function scoreChunk(c) {
    const hay = (c.title + " " + c.text).toLowerCase();
    let score = 0;
    for (const w of terms) if (hay.includes(w)) score += 1;
    return score;
  }

  const scored = CORPUS
    .map(c => ({ ...c, _score: scoreChunk(c) }))
    .filter(c => c._score > 0)
    .sort((a,b) => b._score - a._score)
    .slice(0, max)
    .map(c => ({ text: c.text, source: c.source, title: c.title, score: c._score }));

  const totalHits = scored.reduce((a, x) => a + (x.score > 0 ? 1 : 0), 0);
  const ratio = terms.length ? (totalHits / Math.min(terms.length, max)) : 0;

  if (!scored.length) {
    const fallback = FONTES.slice(0, max).map(s => ({ text: "Veja referência em: " + s, source: s, title: "Fonte", score: 0 }));
    return { chunks: fallback, ratio: 0 };
  }
  return { chunks: scored, ratio };
}

export function listFontes() { return FONTES; }
