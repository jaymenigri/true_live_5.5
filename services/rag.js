// services/rag.js — v2.10 (threshold-strict + question-aware snippets)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { tryLoadGenerated } from "./ingest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadBase() {
  const p = path.join(__dirname, "..", "corpus", "corpus.base.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const BASE = loadBase();

function tokenize(s){
  return (s||"").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z0-9\u00e0-\u00fc\s\-]/g," ")
    .split(/\s+/).filter(Boolean);
}

function cosine(a,b){
  let dot=0, na=0, nb=0;
  for(const k in a){ if(b[k]) dot+=a[k]*b[k]; na+=a[k]*a[k]; }
  for(const k in b){ nb+=b[k]*b[k]; }
  return dot / (Math.sqrt(na||1)*Math.sqrt(nb||1));
}

function tf(tokens){
  const m={}; tokens.forEach(t=>m[t]=(m[t]||0)+1); return m;
}

function vectorize(str){ return tf(tokenize(str)); }

function scoreQuery(q, doc){
  const vq = vectorize(q);
  const vd = vectorize(doc.text);
  const vt = vectorize(doc.title||"");
  const s1 = cosine(vq, vd);
  const s2 = cosine(vq, vt);
  return s1*0.85 + s2*0.15;
}

function selectSnippets(doc, query, maxChars=420){
  const qTokens = new Set(tokenize(query));
  const sentences = doc.text
    .replace(/\s+/g," ")
    .split(/(?<=[\.\!\?])\s+/);
  const scored = sentences.map((s,idx)=>{
    const toks = new Set(tokenize(s));
    let hit=0; qTokens.forEach(t=>{ if(toks.has(t)) hit++; });
    const density = hit / (toks.size||1);
    return { s, idx, hit, density, len:s.length };
  }).sort((a,b)=> b.hit - a.hit || b.density - a.density || a.len - b.len);
  let out = "";
  for(const cand of scored){
    if(out.includes(cand.s)) continue;
    if(out.length + cand.len + 1 > maxChars) continue;
    out += (out?" ":"") + cand.s;
    if(out.length>=maxChars*0.7) break;
  }
  if(!out) out = sentences.slice(0,2).join(" ");
  return out.trim();
}

export function loadAll() {
  const gen = tryLoadGenerated();
  return [...BASE, ...gen];
}

export function search(query, { threshold=0.5, topK=3 }={}) {
  const ALL = loadAll();
  const scored = ALL.map(d=>({ d, s: scoreQuery(query, d) }))
    .sort((a,b)=> b.s - a.s).slice(0, topK);
  const pass = scored.length>0 && scored[0].s >= threshold;
  const top = scored.map(x=>({
    id: x.d.id, title: x.d.title, score: Number(x.s.toFixed(3)),
    snippet: selectSnippets(x.d, query), source: x.d.source||"corpus", date: x.d.date||""
  }));
  return { pass, top, best: top[0]||null };
}