// services/ingest.js — ingestor RSS/Sitemap
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import { extractArticle } from "./htmlExtract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");

const WHITELIST_PATHS = [
  path.join(ROOT, "config", "whitelist.json"),
  path.join(process.cwd(), "config", "whitelist.json")
];

const SAVE_PATH = "/tmp/corpus.generated.json";

function loadWhitelist() {
  for (const p of WHITELIST_PATHS) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  }
  throw new Error("config/whitelist.json não encontrado.");
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

function normUrl(u="") {
  try { return new URL(u).toString(); } catch { return ""; }
}
function sameDomain(u, domain) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, "");
    return h.endsWith(domain);
  } catch { return false; }
}
function allowedPath(u, allowPaths=[], denyPatterns=[]) {
  try {
    const url = new URL(u);
    const p = url.pathname.toLowerCase();
    if (!allowPaths.some(ap => p.startsWith(ap))) return false;
    if (denyPatterns.some(dp => new RegExp(dp).test(u))) return false;
    return true;
  } catch { return false; }
}
async function fetchText(url) {
  const r = await fetch(url, { redirect: "follow", timeout: 15000 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}
function chunkIntoSentences(text, maxLen = 420) {
  const parts = (text || "").split(/[.!?]\s+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const s of parts) {
    if (!s) continue;
    const piece = s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
    out.push(piece.endsWith(".") ? piece : piece + ".");
    if (out.length >= 2) break; // 1–2 frases
  }
  return out.length ? out.join(" ") : (text || "").slice(0, 500);
}

export async function ingestAll({ modes = ["rss","sitemap"], maxPerDomain = 120 } = {}) {
  const wl = loadWhitelist();
  const allow = wl.allow_paths || ["/news","/articles","/opinion"];
  const deny = wl.deny_patterns || [];
  const out = [];
  const seen = new Set();

  const domainsRss = Object.entries(wl.rss || {});
  const domainsSm  = Object.entries(wl.sitemap || {});

  // RSS
  if (modes.includes("rss")) {
    for (const [domain, feeds] of domainsRss) {
      let count = 0;
      for (const feedUrl of feeds) {
        try {
          const xml = await fetchText(feedUrl);
          const data = parser.parse(xml);
          const items = data?.rss?.channel?.item || data?.feed?.entry || [];
          const list = Array.isArray(items) ? items : [items];
          for (const it of list) {
            if (count >= maxPerDomain) break;
            const link = normUrl(it.link?.href || it.link || it.guid || "");
            if (!link || !sameDomain(link, domain)) continue;
            if (!allowedPath(link, allow, deny)) continue;
            if (seen.has(link)) continue;

            const html = await fetchText(link);
            const { title, text } = extractArticle(html, link);
            const body = chunkIntoSentences(text);
            if ((body || "").length < 180) continue;

            out.push({
              id: `rss-${domain}-${count}`,
              title: title || it.title || "(sem título)",
              text: body,
              source: new URL(link).hostname.replace(/^www\./,""),
              date: it.pubDate || it.updated || "",
              url: link
            });
            seen.add(link);
            count++;
          }
        } catch { /* segue */ }
      }
    }
  }

  // SITEMAP
  if (modes.includes("sitemap")) {
    for (const [domain, maps] of domainsSm) {
      let count = 0;
      for (const sm of maps) {
        if (count >= maxPerDomain) break;
        try {
          const smUrl = `https://${domain}${sm}`;
          const xml = await fetchText(smUrl);
          const data = parser.parse(xml);

          const locs = []
            .concat(data?.sitemapindex?.sitemap || [])
            .concat(data?.urlset?.url || []);
          const arr = Array.isArray(locs) ? locs : [locs];

          for (const node of arr) {
            if (count >= maxPerDomain) break;
            const loc = node?.loc || node?.url || "";
            if (!loc) continue;

            const link = normUrl(loc);
            if (!link || !sameDomain(link, domain)) continue;
            if (!allowedPath(link, (wl.allow_paths || []), (wl.deny_patterns || []))) continue;
            if (seen.has(link)) continue;
            if (link.endsWith(".xml")) continue;

            const html = await fetchText(link);
            const { title, text } = extractArticle(html, link);
            const body = chunkIntoSentences(text);
            if ((body || "").length < 180) continue;

            out.push({
              id: `sm-${domain}-${count}`,
              title: title || "(sem título)",
              text: body,
              source: new URL(link).hostname.replace(/^www\./,""),
              date: node?.lastmod || "",
              url: link
            });
            seen.add(link);
            count++;
          }
        } catch { /* ignora */ }
      }
    }
  }

  try { fs.writeFileSync(SAVE_PATH, JSON.stringify(out, null, 2), "utf8"); } catch {}
  return { added: out.length, file: SAVE_PATH };
}

export function tryLoadGenerated() {
  try {
    const raw = fs.readFileSync(SAVE_PATH, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
