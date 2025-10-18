import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { extractMainText } from "./htmlExtract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WL_PATH = path.join(__dirname, "..", "config", "whitelist.json");
let WHITELIST = { rss: [], sitemaps: [], domains: [] };
try {
  WHITELIST = JSON.parse(fs.readFileSync(WL_PATH, "utf-8"));
} catch {}

const TIMEOUT_MS = 8000;
function controllerWithTimeout(ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

async function fetchText(url) {
  const { signal, cancel } = controllerWithTimeout();
  try {
    const r = await fetch(url, { signal, headers: { "User-Agent": "TrueLive/1.0" } });
    cancel();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    cancel();
    return "";
  }
}

function withinDomains(u) {
  try {
    const host = new URL(u).hostname.replace(/^www\./, "");
    return (WHITELIST.domains || []).some(d => host.endsWith(d));
  } catch { return false; }
}

function parseRSS(xml) {
  const items = [];
  const reItem = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = reItem.exec(xml))) {
    const chunk = m[1];
    const get = (tag) => {
      const m2 = new RegExp(`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`, "i").exec(chunk);
      return m2 ? m2[1].replace(/<[^>]+>/g,"").trim() : "";
    };
    const title = get("title");
    const link = get("link");
    const pubDate = get("pubDate");
    if (title && link && withinDomains(link)) {
      items.push({ title, link, date: pubDate || "" });
    }
  }
  return items;
}

function parseSitemap(xml) {
  const urls = [];
  const reLoc = /<loc>([\s\S]*?)<\/loc>/gi;
  let m;
  while ((m = reLoc.exec(xml))) {
    const u = m[1].trim();
    if (withinDomains(u)) urls.push(u);
  }
  return urls.slice(0, 100);
}

export async function ingestAll({ max = 80, mode = "rss,sitemap" } = {}) {
  const modes = String(mode).split(",").map(s => s.trim());
  const out = [];
  if (modes.includes("rss")) {
    for (const feed of WHITELIST.rss || []) {
      const xml = await fetchText(feed);
      if (!xml) continue;
      const items = parseRSS(xml).slice(0, Math.max(10, Math.min(40, max)));
      for (const it of items) {
        const html = await fetchText(it.link);
        if (!html) continue;
        const text = extractMainText(html);
        if (!text || text.length < 400) continue;
        out.push({
          id: `auto-${Buffer.from(it.link).toString("base64").slice(0,18)}`,
          title: it.title.slice(0,200),
          text: text.slice(0, 1200),
          source: it.link,
          date: it.date || ""
        });
        if (out.length >= max) break;
      }
      if (out.length >= max) break;
    }
  }
  if (out.length < max && modes.includes("sitemap")) {
    for (const sm of (WHITELIST.sitemaps || [])) {
      const xml = await fetchText(sm);
      const urls = parseSitemap(xml);
      for (const u of urls) {
        const html = await fetchText(u);
        const text = extractMainText(html);
        if (!text || text.length < 600) continue;
        out.push({
          id: `auto-${Buffer.from(u).toString("base64").slice(0,18)}`,
          title: (u.split("/").pop() || "Página").slice(0,200),
          text: text.slice(0, 1200),
          source: u,
          date: ""
        });
        if (out.length >= max) break;
      }
      if (out.length >= max) break;
    }
  }
  let added = 0;
  const genPath = "/tmp/corpus.generated.json";
  if (out.length) {
    try {
      fs.writeFileSync(genPath, JSON.stringify(out, null, 2), "utf-8");
      added = out.length;
    } catch {}
  }
  return { added, file: genPath };
}

export function tryLoadGenerated() {
  const genPath = "/tmp/corpus.generated.json";
  try {
    if (!fs.existsSync(genPath)) return [];
    const raw = fs.readFileSync(genPath, "utf-8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
    return [];
  } catch { return []; }
}
