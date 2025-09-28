import fs from "fs";

const fontesPath = new URL("../fontes.json", import.meta.url);
let FONTES = [];
try {
  FONTES = JSON.parse(fs.readFileSync(fontesPath, "utf8"));
} catch (e) {
  console.warn("[warn] Could not read fontes.json:", e.message);
  FONTES = [];
}

export function classifyScope(text) {
  const t = (text || "").toLowerCase();
  const hit = /(israel|zionis|sionis|idf|tsahal|antisemit|judai|hamas|hezbollah|gaza|cisjord|west bank|jerusal|tel aviv|knesset|yom kippur|holocaust|shoah|intifada)/.test(t);
  return hit ? "in" : "out";
}

export function retrieveContext(text, max = 6) {
  const terms = (text || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  function scoreStr(s) {
    const str = (s || "").toLowerCase();
    let score = 0;
    for (const w of terms) if (str.includes(w)) score += 1;
    if (/^https?:/.test(s)) score += 0.2;
    return score;
  }
  const scored = FONTES.map(src => ({ src, score: scoreStr(src) }))
    .sort((a,b) => b.score - a.score)
    .slice(0, max)
    .map(r => ({ text: `Veja referência em: ${r.src}`, source: r.src, score: r.score }));
  const totalHits = scored.reduce((a, x) => a + (x.score > 0 ? 1 : 0), 0);
  const ratio = terms.length ? (totalHits / Math.min(terms.length, max)) : 0;
  return { chunks: scored, ratio };
}

export function listFontes() {
  return FONTES;
}
