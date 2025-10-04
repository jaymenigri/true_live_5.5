// services/ingest.js — v1.2 (final)
// - RSS/Sitemap com AbortController (timeout real)
// - Extrai título + texto com htmlExtract
// - Escreve /tmp/corpus.generated.json SOMENTE se added>0
// - Exporta { ingestAll, tryLoadGenerated }

import fetch from "node-fetch";
import fs from "fs";

import { extractMainText } from "./htmlExtract.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const whitelist = require("../config/whitelist.json");

const TIMEOUT_MS = 8000;

function controllerWithTimeout(ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

async function fetchText(url) {
  const { signal, cancel } = controllerWithTimeout();
  try {
    const res = await fetch(url, { signal });
    const txt = await res.text();
    return txt;
  } finally { cancel(); }
}

function isAllowed(url) {
  try {
    const u = new URL(url);
    return whitelist.domains.some(d => u.hostname.endsWith(d));
  } catch { return false; }
}

function parseRss(xml) {
  const items = [];
  const reItem = /<item\b[\s\S]*?<\/item>/gi;
  const reTitle = /<title>([\s\S]*?)<\/title>/i;
  const reLink = /<link>([\s\S]*?)<\/link>/i;
  const blocks = xml.match(reItem) || [];
  for (const blk of blocks) {
    const t = (blk.match(reTitle)||[])[1]?.trim();
    const l = (blk.match(reLink)||[])[1]?.trim();
    if (t && l && isAllowed(l)) items.push({ title: t, url: l });
  }
  return items;
}

function parseSitemap(xml) {
  const locs = Array.from(xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)).map(m=>m[1].trim());
  return locs.filter(isAllowed).map(url => ({ title: "", url }));
}

async function ingestRSS(maxPerDomain = 120) {
  let added = 0;
  const out = [];
  for (const feed of whitelist.rss) {
    try {
      const xml = await fetchText(feed);
      const items = parseRss(xml).slice(0, maxPerDomain);
      for (const it of items) {
        try {
          const html = await fetchText(it.url);
          const { title, text } = extractMainText(html, it.url, it.title);
          if (!text || text.length < 400) continue;
          out.push({
            id: `rss-${it.url}`,
            title: title || it.title || it.url,
            text: text.slice(0, 2000),
            source: it.url,
            date: ""
          });
        } catch {}
      }
    } catch {}
  }
  added = out.length;
  if (added > 0) {
    try { fs.writeFileSync("/tmp/corpus.generated.json", JSON.stringify(out, null, 2)); } catch {}
  }
  return { added, file: "/tmp/corpus.generated.json" };
}

async function ingestSitemap(maxPerDomain = 120) {
  let added = 0;
  const out = [];
  for (const sm of whitelist.sitemaps) {
    try {
      const xml = await fetchText(sm);
      const items = parseSitemap(xml).slice(0, maxPerDomain);
      for (const it of items) {
        try {
          const html = await fetchText(it.url);
          const { title, text } = extractMainText(html, it.url, it.title);
          if (!text || text.length < 400) continue;
          out.push({
            id: `sm-${it.url}`,
            title: title || it.title || it.url,
            text: text.slice(0, 2000),
            source: it.url,
            date: ""
          });
        } catch {}
      }
    } catch {}
  }
  added = out.length;
  if (added > 0) {
    try { fs.writeFileSync("/tmp/corpus.generated.json", JSON.stringify(out, null, 2)); } catch {}
  }
  return { added, file: "/tmp/corpus.generated.json" };
}

export function tryLoadGenerated() {
  try {
    const raw = fs.readFileSync("/tmp/corpus.generated.json", "utf8");
    return JSON.parse(raw);
  } catch { return []; }
}

export async function ingestAll({ modes = ["rss","sitemap"], maxPerDomain = 120 } = {}) {
  let total = 0;
  let lastFile = "/tmp/corpus.generated.json";
  if (modes.includes("rss")) {
    const r = await ingestRSS(maxPerDomain);
    total += r.added; lastFile = r.file;
  }
  if (modes.includes("sitemap")) {
    const r = await ingestSitemap(maxPerDomain);
    total += r.added; lastFile = r.file;
  }
  return { added: total, file: lastFile };
}
