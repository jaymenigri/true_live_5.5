import fs from "fs";

// Simple in-repo catalog-only RAG: we "retrieve" relevant sources by name match.
// Later, this can be extended to real document chunks with embeddings/BM25.
const fontesPath = new URL("../fontes.json", import.meta.url);
let fontes = [];
try {
  fontes = JSON.parse(fs.readFileSync(fontesPath, "utf8"));
} catch (e) {
  console.warn("[warn] Could not read fontes.json:", e.message);
  fontes = [];
}

export function classifyScope(text) {
  const t = (text || "").toLowerCase();
  const hit = /(israel|sionismo|zionism|zionismo|idf|tsahal|iof|antisemit|judai(s|sm|zmo)|hamas|hezbollah|gaza|cisjord|west bank|jerusal(e|é)m|tel aviv|knesset|idf\b|yom kippur|holocaust|shoah|intifada)/.test(t);
  return hit ? "in" : "out";
}

export function retrieveContext(text, max = 6) {
  // Na versão catálogica, retornamos apenas os nomes/URLs de fontes como "contexto".
  // Heurística simples: prioriza URLs e nomes que contenham palavras da consulta.
  const terms = (text || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const scored = fontes.map(src => {
    const s = (src || "").toLowerCase();
    const score = terms.reduce((acc, w) => acc + (s.includes(w) ? 1 : 0), 0);
    return { src, score };
  }).sort((a,b) => b.score - a.score);
  const top = scored.slice(0, max).map(r => ({
    text: `Veja referência em: ${r.src}`,
    source: r.src
  }));
  // Garante ao menos algumas fontes confiáveis mesmo se score = 0
  return top.filter(x => x.source).length ? top : fontes.slice(0, max).map(s => ({ text: `Veja referência em: ${s}`, source: s }));
}
