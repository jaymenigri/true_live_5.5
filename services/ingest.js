// services/ingest.js — v1.3
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { extractMainText } from "./htmlExtract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadJSON(relPath) {
  const p = path.join(__dirname, "..", relPath);
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

const whitelist = loadJSON("config/whitelist.json");

const TIMEOUT_MS = 8000;
function withTimeout(ms=TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: ()=>clearTimeout(t) };
}

async function fetchText(url) {
  const { signal, cancel } = withTimeout();
  try {
    const res = await fetch(url, { signal, redirect: "follow" });
    cancel();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    cancel();
    return null;
  }
}

function isAllowed(url) {
  try {
    const u = new URL(url);
    const pathOk = whitelist.allow_paths.length===0 || whitelist.allow_paths.some(p=>u.pathname.includes(p));
    return pathOk;
  } catch { return false; }
}

export async function ingestAll({ max=50 }={}) {
  const collected = [];

  // RSS
  for (const rss of whitelist.rss) {
    const xml = await fetchText(rss);
    if (!xml) continue;
    const items = [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)];
    for (const m of items.slice(0, max)) {
      const link = (m[0].match(/<link>(.*?)<\/link>/s)||[])[1] || "";
      if (!link || !isAllowed(link)) continue;
      const html = await fetchText(link);
      if (!html) continue;
      const { title, text } = await extractMainText(html, link);
      if (!text || text.length<200) continue;
      collected.push({ id: link, title: title||link, text, source: link, date: "" });
    }
  }

  // Sitemaps
  for (const sm of whitelist.sitemaps) {
    const xml = await fetchText(sm);
    if (!xml) continue;
    const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m=>m[1]).slice(0, max);
    for (const link of locs) {
      if (!isAllowed(link)) continue;
      const html = await fetchText(link);
      if (!html) continue;
      const { title, text } = await extractMainText(html, link);
      if (!text || text.length<200) continue;
      collected.push({ id: link, title: title||link, text, source: link, date: "" });
    }
  }

  const outPath = "/tmp/corpus.generated.json";
  const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath,"utf8")) : [];
  const all = [...existing];
  const seen = new Set(existing.map(x=>x.id));
  let added = 0;
  for (const item of collected) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    all.push(item);
    added++;
  }
  if (added>0) fs.writeFileSync(outPath, JSON.stringify(all, null, 2), "utf8");
  return { added, file: outPath };
}

export function tryLoadGenerated() {
  const outPath = "/tmp/corpus.generated.json";
  if (!fs.existsSync(outPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(outPath,"utf8"));
  } catch { return []; }
}