// services/realtime.js — v1.0
// “Atualidade”: usa RSS de fontes whitelisted para responder perguntas do tipo “agora/hoje/quantos reféns?”.
// Se achar manchetes relevantes, responde imediatamente; senão, retorna null e o fluxo segue (RAG/fallback).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

const WL_PATHS = [
  path.join(ROOT, "config", "whitelist.json"),
  path.join(process.cwd(), "config", "whitelist.json"),
];

function loadWhitelist() {
  for (const p of WL_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {}
  }
  return {
    rss: {
      "timesofisrael.com": ["https://www.timesofisrael.com/feed/"],
      "jpost.com": ["https://www.jpost.com/Rss/RssFeedsFrontPage.aspx"],
      "jns.org": ["https://www.jns.org/feed/"]
    }
  };
}

const WL = loadWhitelist();

const LIVE_PATTERNS = [
  "agora", "hoje", "últimas", "ultimas", "atual", "atualizado",
  "quantos refens", "quantos reféns", "hostages", "refens", "reféns",
  "últimas notícias", "breaking", "update", "número atual", "numero atual"
];

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

function looksLive(q) {
  const n = norm(q);
  return LIVE_PATTERNS.some((p) => n.includes(p));
}

async function fetchText(url) {
  const r = await fetch(url, { timeout: 12000, redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

function parseRss(xml) {
  const d = parser.parse(xml);
  const items = d?.rss?.channel?.item || d?.feed?.entry || [];
  return Array.isArray(items) ? items : [items];
}

function itemToCard(it) {
  const link = it.link?.href || it.link || it.guid || "";
  const title = it.title?.["#text"] || it.title || "(sem título)";
  const desc = it.description || it.summary || "";
  const date = it.pubDate || it.updated || "";
  return { title: String(title), description: String(desc || ""), link: String(link || ""), date: String(date || "") };
}

function keepRelevant(card, q) {
  const nQ = norm(q);
  const nT = norm(card.title);
  const nD = norm(card.description);
  const hits = ["refen","reféns","refem","hostage","gaza","israel","ataque","rocket","kibbutz","idf","hamas","hezbollah","fronteira","cativeiro","troca"].filter(w =>
    nT.includes(w) || nD.includes(w)
  ).length;
  return hits >= 1 || nT.includes("breaking") || nT.includes("live");
}

export async function maybeAnswerRealtime(query, lang = "pt") {
  if (!looksLive(query)) return null;

  const feeds = Object.values(WL.rss || {}).flat().slice(0, 12);
  const cards = [];

  for (const url of feeds) {
    try {
      const xml = await fetchText(url);
      const items = parseRss(xml);
      for (const it of items.slice(0, 15)) {
        const c = itemToCard(it);
        if (keepRelevant(c, query)) cards.push(c);
      }
    } catch {
      // ignora feed com erro
    }
  }

  if (!cards.length) return null;

  const score = (c) => {
    const t = Date.parse(c.date || "") || 0;
    const hot = /refe(ns|m|ns)|hostage/i.test(c.title) ? 1 : 0;
    return t + hot * 1000 * 60;
  };
  cards.sort((a, b) => score(b) - score(a));
  const top = cards.slice(0, 2);
  const bullets = top.map((c) => `• ${c.title} — ${new URL(c.link).hostname.replace(/^www\./,"")}`);

  const header =
    lang === "pt" ? "Atualização recente (fontes confiáveis):"
    : lang === "es" ? "Actualización reciente (fuentes confiables):"
    : "Recent update (trusted sources):";

  const tail =
    lang === "pt" ? "\n\nObs.: números podem mudar rapidamente; consulte as fontes listadas."
    : lang === "es" ? "\n\nNota: los números pueden cambiar rápidamente; consulte las fuentes."
    : "\n\nNote: numbers can change quickly; check the sources.";

  return {
    ok: true,
    text: `${header}\n${bullets.join("\n")}${tail}`,
    sources: top.map((c) => c.link)
  };
}

export default { maybeAnswerRealtime };
