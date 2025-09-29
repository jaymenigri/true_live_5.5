// services/hybridRag.js — True Live v2.3 “best”
// RAG híbrido + recency boost + ingestão RSS/Sitemap + classificador amplo
// ESM (package.json: { "type": "module" })

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

// ====== Paths ======
const DATA_DIR    = path.resolve("data");
const DOCS_PATH   = path.join(DATA_DIR, "docs.json");
const INDEX_PATH  = path.join(DATA_DIR, "index.json");
const FEEDS_PATH  = path.resolve("config/feeds.json");
const WL_PATH     = path.resolve("config/whitelist.json");
const ALIASES_PATH= path.resolve("config/aliases.json");

// ====== Params ======
const RAG_THRESHOLD        = Number(process.env.RAG_THRESHOLD || "0.4");
const MAX_DOCS_PER_RUN     = 60;
const MAX_FETCH_PER_SITE   = 20;
const MAX_CHUNKS_PER_DOC   = 40;
const HALF_LIFE_DAYS       = 30; // time-decay (recency)

// ====== State ======
let DOCS = [];
let INDEX = [];
let WHITELIST = { A: [], B: [] };
let ALIASES = {};

// ====== FS helpers ======
async function ensureData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (!(await exists(DOCS_PATH))) await fs.writeFile(DOCS_PATH, "[]");
  if (!(await exists(INDEX_PATH))) await fs.writeFile(INDEX_PATH, "[]");
}
async function exists(p) { try { await fs.stat(p); return true; } catch { return false; } }
async function loadAll() {
  await ensureData();
  try { DOCS = JSON.parse(await fs.readFile(DOCS_PATH, "utf8") || "[]"); } catch { DOCS = []; }
  try { INDEX = JSON.parse(await fs.readFile(INDEX_PATH, "utf8") || "[]"); } catch { INDEX = []; }
  try { WHITELIST = JSON.parse(await fs.readFile(WL_PATH, "utf8")); } catch { WHITELIST = { A: [], B: [] }; }
  try { ALIASES = JSON.parse(await fs.readFile(ALIASES_PATH, "utf8")); } catch { ALIASES = {}; }
}
async function persist() {
  await fs.writeFile(DOCS_PATH, JSON.stringify(DOCS, null, 2));
  await fs.writeFile(INDEX_PATH, JSON.stringify(INDEX, null, 2));
}

// ====== Utils ======
function uid(s) { return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0,16); }
function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function inWhitelist(url) {
  const d = domainOf(url);
  return WHITELIST.A.includes(d) || WHITELIST.B.includes(d);
}
function trustLevel(url) {
  const d = domainOf(url);
  if (WHITELIST.A.includes(d)) return "A";
  if (WHITELIST.B.includes(d)) return "B";
  return "X";
}
function escapeReg(x){return x.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}
function normalize(s=""){
  let out=(s||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"");
  if (ALIASES && typeof ALIASES==="object"){
    for (const [k,v] of Object.entries(ALIASES)){
      const re=new RegExp(`\\b${escapeReg(k)}\\b`,"gi");
      out=out.replace(re,v);
    }
  }
  return out;
}
function tokens(s=""){
  return normalize(String(s).toLowerCase())
    .replace(/[^a-z0-9\u00C0-\u024f\- ]+/gi," ")
    .split(/\s+/).filter(Boolean);
}

// ====== Classifier (alto recall) ======
const IN_KEYWORDS = [
  // núcleo temático
  "israel","estado de israel","judaismo","judaísmo","juda","zion","sion","sionismo",
  "antisemit","antissemit","ihra","holocausto","shoah","nakba",
  "idf","tsahal","forcas de defesa de israel","forças de defesa de israel",
  "knesset","mfa","yad vashem","jerusalem","jerusalém","jerus","jerusal",
  // líderes / pessoas
  "golda","meir","golda meir","ben-gurion","ben gurion","david ben-gurion",
  "itzhak rabin","rabin","sharon","peres","herzl","netanyahu","benjamin netanyahu",
  // orgs / conflito
  "hamas","hezbollah","hezbolah","hizbollah","fdi","olp","plo","fatah","intifada",
  "guerra do yom kipur","yom kippur","acordos de oslo","oslo",
  // topônimos
  "gaza","faixa de gaza","gaza strip","cisjordania","west bank",
  "judeia e samaria","samaria","judeia","hebron","belém","bethlehem",
  "ramallah","rafah","khan yunis","sderot","ashkelon","ashdod","lod","acre","tel aviv","haifa","galileia","neguev"
];

export function classifyScope(text=""){
  const t=normalize((text||"").toLowerCase());
  if (/^(quem|qual|quais|onde|quando|como|ele|ela|dele|dela|seu|sua)\b/i.test(t)) return "maybe";
  for (const k of IN_KEYWORDS){ if (t.includes(k)) return "in"; }
  return "out";
}

// ====== Scoring (léxico simples + título) ======
function bm25ish(query, text){
  const q=tokens(query), tt=tokens(text);
  if(!q.length||!tt.length) return 0;
  const tf=Object.create(null); for (const w of tt) tf[w]=(tf[w]||0)+1;
  let score=0; for (const w of q){ const f=tf[w]||0; if (f) score+=Math.log(1+f); }
  return score/Math.log(10+tt.length);
}
function jaccardTitle(query, title){
  const a=new Set(tokens(query)), b=new Set(tokens(title));
  if(!a.size||!b.size) return 0;
  let inter=0; for (const w of a) if (b.has(w)) inter++;
  return inter/(a.size+b.size-inter);
}
function recencyBoost(iso){
  if(!iso) return 1.0;
  const days=Math.max(0,(Date.now()-new Date(iso).getTime())/86400000);
  const decay=Math.pow(0.5, days/HALF_LIFE_DAYS);
  return 0.6 + 0.4*decay; // piso 0.6 para não “matar” conteúdo bom
}

// ====== Retrieve ======
export async function retrieveHybrid(query, k=6, preferRecent=false){
  await loadAll();
  const scored = INDEX.map(ch=>{
    const sText  = bm25ish(query, ch.text);
    const sTitle = jaccardTitle(query, ch.title||"");
    const base   = 0.6*sText + 0.4*sTitle;
    const rec    = preferRecent ? recencyBoost(ch.date) : 1.0;
    const trustW = ch.trust==="A" ? 1.0 : (ch.trust==="B" ? 0.95 : 0.8);
    return { ...ch, score: base*rec*trustW };
  }).sort((a,b)=> b.score - a.score);

  const top = scored.slice(0, Math.max(6,k)).map(x=>({title:x.title, score:Number(x.score.toFixed(3))}));
  console.log("RAG top:", top);
  const passing = scored.filter(d=> d.score >= RAG_THRESHOLD).slice(0,k);
  const pass = passing.length>0;
  console.log(`RAG pass: ${pass} threshold: ${RAG_THRESHOLD} query: ${query}`);

  return { pass, chunks: scored.slice(0,k), chunksPassing: passing };
}

// ====== Ingest (RSS + Sitemap) ======
export async function ingestRSS(){
  await loadAll();
  let feeds; try{ feeds=JSON.parse(await fs.readFile(FEEDS_PATH,"utf8")); }catch{ feeds={rss:[],sitemaps:[]}; }
  const urls=(feeds.rss||[]).slice(0,30);

  let added=0;
  for (const u of urls){
    try{
      const xml = await (await fetch(u)).text();
      const items = parseRSS(xml).slice(0, MAX_FETCH_PER_SITE);
      for (const it of items){
        if (!it.link || !inWhitelist(it.link)) continue;
        if (haveDoc(it.link)) continue;
        const html = await safeFetch(it.link); if (!html) continue;
        const text = extractMainText(html); if (!text) continue;
        pushDoc({ title: it.title || titleFromHTML(html) || domainOf(it.link), url: it.link, date: it.pubDate || dateFromHTML(html), text });
        if (++added >= MAX_DOCS_PER_RUN) break;
      }
      if (added >= MAX_DOCS_PER_RUN) break;
    }catch(e){ console.error("RSS error", u, e.message); }
  }
  if (added) await rebuildIndex();
  return { added, totalDocs: DOCS.length, totalChunks: INDEX.length };
}

export async function ingestSitemap(){
  await loadAll();
  let feeds; try{ feeds=JSON.parse(await fs.readFile(FEEDS_PATH,"utf8")); }catch{ feeds={rss:[],sitemaps:[]}; }
  const urls=(feeds.sitemaps||[]).slice(0,20);

  let added=0;
  for (const u of urls){
    try{
      const xml = await (await fetch(u)).text();
      const items = parseSitemap(xml).slice(0, MAX_FETCH_PER_SITE);
      for (const it of items){
        if (!it.loc || !inWhitelist(it.loc)) continue;
        if (haveDoc(it.loc)) continue;
        const html = await safeFetch(it.loc); if (!html) continue;
        const text = extractMainText(html); if (!text) continue;
        pushDoc({ title: titleFromHTML(html) || domainOf(it.loc), url: it.loc, date: it.lastmod || dateFromHTML(html), text });
        if (++added >= MAX_DOCS_PER_RUN) break;
      }
      if (added >= MAX_DOCS_PER_RUN) break;
    }catch(e){ console.error("Sitemap error", u, e.message); }
  }
  if (added) await rebuildIndex();
  return { added, totalDocs: DOCS.length, totalChunks: INDEX.length };
}

// ====== Ingest helpers ======
function parseRSS(xml=""){
  const out=[]; const items=xml.split(/<item[\s>]/i).slice(1);
  for (const it of items){
    const title=pickTag(it,"title");
    const link =pickTag(it,"link");
    const pub  =pickTag(it,"pubDate")||pickTag(it,"dc:date");
    out.push({ title, link, pubDate: pub });
  }
  return out;
}
function parseSitemap(xml=""){
  const out=[]; const urls=xml.split(/<url>/i).slice(1);
  for (const u of urls){
    const loc=pickTag(u,"loc");
    const lastmod=pickTag(u,"lastmod");
    out.push({ loc, lastmod });
  }
  return out;
}
function pickTag(block, tag){
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`,"i"));
  return m? m[1].trim() : "";
}
async function safeFetch(url){
  try{
    const res = await fetch(url,{ headers:{ "user-agent":"TrueLiveBot/1.0" }});
    if(!res.ok) return "";
    return await res.text();
  }catch{ return ""; }
}
function titleFromHTML(html=""){
  const m=html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m? m[1].replace(/\s+/g," ").trim() : "";
}
function dateFromHTML(html=""){
  const metas=[
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["']/i,
    /<time[^>]+datetime=["']([^"']+)["']/i
  ];
  for (const re of metas){ const m=html.match(re); if (m) return m[1]; }
  return "";
}
function extractMainText(html=""){
  const art = html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html;
  const ps = Array.from(art.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi))
    .map(m=>m[1].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim())
    .filter(Boolean);
  const text = ps.join("\n");
  return text.length>200 ? text : "";
}
function haveDoc(url){ return DOCS.some(d=>d.url===url); }
function pushDoc({title,url,date,text}){
  const id = uid(url);
  const source = domainOf(url);
  const trust = trustLevel(url);
  DOCS.push({ id, title, url, date, source, trust, text });
}
async function rebuildIndex(){
  const chunks=[];
  for (const d of DOCS){
    const parts = splitSentences(d.text).slice(0, MAX_CHUNKS_PER_DOC);
    for (const p of parts){
      chunks.push({
        id: `${d.id}:${uid(p.slice(0,64))}`,
        docId: d.id,
        title: d.title,
        url: d.url,
        date: d.date||"",
        source: d.source,
        trust: d.trust,
        text: p
      });
    }
  }
  INDEX = chunks;
  await persist();
  console.log(`Rebuilt index: ${DOCS.length} docs, ${INDEX.length} chunks`);
}
function splitSentences(t=""){
  const s = t.replace(/\s+/g," ").split(/(?<=[.?!])\s+(?=[A-ZÀ-ÖØ-Þ])/g).filter(x=>x && x.length>40);
  const out=[]; for (let i=0;i<s.length;i+=2){ out.push([s[i], s[i+1]].filter(Boolean).join(" ")); }
  return out;
}
