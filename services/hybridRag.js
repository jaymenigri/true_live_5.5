import fs from "fs";
import lunr from "lunr";
import Parser from "rss-parser";
import { XMLParser } from "fast-xml-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import axios from "axios";
import { embedText } from "./openaiClient.js";

const corpusPath = new URL("../corpus/corpus.json", import.meta.url);
const docsStorePath = new URL("../data/docs.jsonl", import.meta.url);
const indexPath = new URL("../data/index.json", import.meta.url);
const whitelistPath = new URL("../config/whitelist.json", import.meta.url);
const feedsPath = new URL("../config/feeds.json", import.meta.url);

function loadJSON(p){ try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function* readDocs() { try { const lines = fs.readFileSync(docsStorePath, "utf8").split(/\n+/).filter(Boolean); for (const line of lines) yield JSON.parse(line); } catch {} }
function writeDoc(doc){ fs.appendFileSync(docsStorePath, JSON.stringify(doc) + "\n"); }

function buildLunr(docs){
  return lunr(function(){
    this.ref("id"); this.field("title"); this.field("text");
    for (const d of docs) this.add({ id:d.id, title:d.title||"", text:d.text||"" });
  });
}
function saveIndex(idx){ fs.writeFileSync(indexPath, JSON.stringify(idx)); }
function tokenize(s){ return (s||"").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean); }

export function classifyScope(text){
  const t = (text||"").toLowerCase();
  const hit = /(israel|zionis|sionis|idf|antisemit|judai|hamas|hezbollah|gaza|cisjord|jerusal|knesset|yom kippur|holocaust|shoah|intifada|balfour|oslo|ben-gurion|rabin|peres|sharon|begin)/.test(t);
  return hit ? "in" : "out";
}

function cosine(a,b){ let dot=0,na=0,nb=0; for (let i=0;i<Math.min(a.length,b.length);i++){ dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; } return dot/(Math.sqrt(na)*Math.sqrt(nb)+1e-9); }

export async function retrieveHybrid(query, max=6, recencyIntent=false){
  const CORPUS = loadJSON(corpusPath) || [];
  const docs = Array.from(readDocs());
  let idx; try { idx = lunr.Index.load(loadJSON(indexPath)); } catch {}
  if (!idx){ idx = buildLunr(docs); saveIndex(idx); }

  let results = [];
  try {
    results = idx.search(query).slice(0, 12).map(r => {
      const d = docs.find(x => x.id===r.ref) || null;
      return d ? { ...d, _scoreLex: r.score } : null;
    }).filter(Boolean);
  } catch { results = []; }

  const terms = tokenize(query);
  const corpusHits = CORPUS.map(c => {
    const hay = (c.title + " " + c.text).toLowerCase();
    let s = 0; for (const w of terms) if (hay.includes(w)) s += 1;
    return { ...c, _scoreLex: s * 0.8, domain: "corpus", trust: "A" };
  }).filter(c => c._scoreLex > 0).slice(0,6);
  results = results.concat(corpusHits);

  let qEmb = null; try { qEmb = await embedText(query); } catch {}
  if (qEmb){
    for (const r of results){
      if (!r.embedding && r.text){ try { r.embedding = await embedText(r.text); } catch {} }
      r._scoreSem = r.embedding ? cosine(qEmb, r.embedding) : 0;
    }
  } else { for (const r of results) r._scoreSem = 0; }

  function recencyBoost(dateStr){
    if (!dateStr) return 1;
    const t = Date.parse(dateStr); if (isNaN(t)) return 1;
    const days = (Date.now()-t)/(1000*60*60*24);
    if (days<=30) return 1.25;
    if (days<=90) return 1.10;
    return 1.0;
  }
  for (const r of results){
    const base = (r._scoreLex||0) + (r._scoreSem||0)*2.0;
    r._score = base * (recencyIntent ? recencyBoost(r.date) : 1);
  }

  results.sort((a,b) => b._score - a._score);
  const top = results.slice(0, max).map(r => ({
    text: r.text?.slice(0,400) || "",
    source: r.domain ? r.domain : r.source || "",
    title: r.title || "",
    date: r.date || "",
    score: r._score
  }));

  const maxScore = top.length ? Math.max(...top.map(x => x.score)) : 1;
  const normalized = top.map(x => ({...x, norm: maxScore ? (x.score / maxScore) : 0 }));
  const ok = normalized.filter(x => x.norm >= 0.5);
  return { chunks: normalized, pass: ok.length > 0, chunksPassing: ok.slice(0, max) };
}

/* ===== Ingestion ===== */
function loadWhitelist(){ return loadJSON(whitelistPath) || { domains: [] }; }
function inWhitelist(url, wl){
  try {
    const u = new URL(url);
    const domain = u.hostname.replace(/^www\./,"");
    const rule = wl.domains.find(d => domain.endsWith(d.domain) && d.active);
    if (!rule) return null;
    const ok = rule.allow_paths?.some(p => u.pathname.startsWith(p)) ?? true;
    return ok ? rule : null;
  } catch { return null; }
}
async function fetchHTML(url){
  const { data } = await axios.get(url, { timeout: 15000 });
  const dom = new JSDOM(data);
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  return (article?.textContent || "").trim();
}
async function fetchPDF(url){
  try {
    const mod = await import("pdf-parse");        // ⬅ import dinâmico
    const pdfParse = mod.default || mod;
    const { data } = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
    const r = await pdfParse(Buffer.from(data));
    return (r.text || "").trim();
  } catch {
    return ""; // nunca derrubar o servidor por causa de PDF
  }
}
function isPDF(url){ return /\.pdf($|\?)/i.test(url); }
function hasDoc(url){
  try {
    const lines = fs.readFileSync(docsStorePath, "utf8").split(/\n+/).filter(Boolean);
    return lines.some(line => { try { return JSON.parse(line).url === url; } catch { return false; } });
  } catch { return false; }
}

export async function ingestRSS(){
  const wl = loadWhitelist(); const parser = new Parser();
  const feeds = (loadJSON(feedsPath)?.rss) || [];
  let added = 0;
  for (const f of feeds){
    try {
      const r = await parser.parseURL(f);
      for (const it of (r.items || [])){
        const link = it.link || it.guid; if (!link) continue;
        const rule = inWhitelist(link, wl); if (!rule) continue;
        if (hasDoc(link)) continue;
        let text = "";
        try { text = isPDF(link) ? await fetchPDF(link) : await fetchHTML(link); } catch {}
        if (!text || text.split(/\s+/).length < 80) continue;
        let embedding = null; try { embedding = await embedText(text); } catch {}
        const doc = {
          id: `rss-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
          url: link, title: it.title || "", text,
          date: it.isoDate || it.pubDate || "", domain: new URL(link).hostname.replace(/^www\./,""),
          trust: rule.trust, embedding
        };
        writeDoc(doc); added++;
      }
    } catch {}
  }
  const docs = Array.from(readDocs());
  const idx = buildLunr(docs);
  saveIndex(idx);
  return { added, total: docs.length };
}

export async function ingestSitemap(){
  const wl = loadWhitelist(); const sitemaps = (loadJSON(feedsPath)?.sitemaps) || [];
  const parser = new XMLParser();
  let added = 0;
  for (const sm of sitemaps){
    try {
      const { data } = await axios.get(sm, { timeout: 15000 });
      const xml = parser.parse(data);
      const urls = (xml.urlset?.url || []).map(u => u.loc).filter(Boolean);
      for (const link of urls){
        const rule = inWhitelist(link, wl); if (!rule) continue;
        if (hasDoc(link)) continue;
        let text = "";
        try { text = isPDF(link) ? await fetchPDF(link) : await fetchHTML(link); } catch {}
        if (!text || text.split(/\s+/).length < 80) continue;
        let embedding = null; try { embedding = await embedText(text); } catch {}
        const doc = {
          id: `sm-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
          url: link, title: "", text, date: "", domain: new URL(link).hostname.replace(/^www\./,""),
          trust: rule.trust, embedding
        };
        writeDoc(doc); added++;
      }
    } catch {}
  }
  const docs = Array.from(readDocs());
  const idx = buildLunr(docs);
  saveIndex(idx);
  return { added, total: docs.length };
}
