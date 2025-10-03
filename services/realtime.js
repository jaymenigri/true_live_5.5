// services/realtime.js — Atualidade “lite” sem chaves
// - Clima: Open-Meteo (sem API key) + geocoding Open-Meteo
// - Wikipédia: resumo rápido da entidade (útil p/ “quem é X?” fora do acervo)
// - Manchetes: Reuters/BBC via RSS (títulos + links)
// - Heurística looksRecent: decide quando tentar “web” primeiro

import fetch from "node-fetch";

// --------- Heurística de “recência” ----------
export function looksRecent(q) {
  const t = (q || "").toLowerCase();
  return /agora|hoje|últimas|ultimas|agendada|previs[aã]o|clima|tempo|weather|breaking|atual|atualiza|not[ií]cia|news|ref[eé]ns|refe[ns]/.test(t);
}

// --------- Orquestrador ----------
export async function getRealtimeAnswer(query, lang = "pt") {
  const q = (query || "").trim();

  // 1) Clima
  if (/(clima|tempo|weather|temperatura)/i.test(q)) {
    const city = extractCity(q);
    if (city) {
      const wx = await weatherForCity(city, lang);
      if (wx?.ok) return wx;
    }
  }

  // 2) Wikipédia (entity summary)
  if (/^(quem|qu[ié]n|who|what)\b/i.test(q) || /\b(what is|who is|who was|qué es|quem é|quem foi)\b/i.test(q)) {
    const title = extractEntity(q);
    if (title) {
      const wk = await wikipediaSummary(title, lang);
      if (wk?.ok) return wk;
    }
  }

  // 3) Manchetes
  if (/not[ií]cia|news|últimas|ultimas|agora|breaking/i.test(q)) {
    const hd = await topHeadlines(lang);
    if (hd?.ok) return hd;
  }

  return { ok: false };
}

// --------- Helpers de parsing ----------
function extractCity(q) {
  // pega o trecho após “em|in|en …” no final da frase, ex: “tempo em São Paulo”
  const m = q.match(/\b(?:em|in|en)\s+([A-ZÁÂÃÉÊÍÓÔÕÚÇ][\w\-\’'ºª\s]+)$/i);
  return m ? m[1].trim().replace(/[?!.]+$/, "") : null;
}

function extractEntity(q) {
  // remove “quem/what/who …” do começo
  let s = q
    .replace(/^(quem foi|quem [ée]|\bwho is\b|\bwho was\b|\bwhat is\b|\bqué es\b|\bqu[ié]n es\b)\s+/i, "")
    .replace(/[?!.]+$/, "")
    .trim();
  // capitaliza primeira letra se vier toda minúscula
  if (/^[a-záéíóúñçãõ]/.test(s)) s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

// --------- Clima (Open-Meteo) ----------
async function weatherForCity(city, lang) {
  try {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`
    ).then(r => r.json());

    const p = geo?.results?.[0];
    if (!p) return { ok: false };

    const { latitude, longitude, name, country } = p;
    const wx = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m`
    ).then(r => r.json());

    const c = wx?.current || {};
    const temp = typeof c.temperature_2m === "number" ? Math.round(c.temperature_2m) : null;
    const hum = c.relative_humidity_2m;
    const wind = c.wind_speed_10m;

    const text =
      lang === "es"
        ? `Tiempo actual en ${name}, ${country}: temperatura ${temp}°C, humedad ${hum}%, viento ${wind} km/h.`
        : lang === "en"
        ? `Current weather in ${name}, ${country}: temperature ${temp}°C, humidity ${hum}%, wind ${wind} km/h.`
        : `Clima agora em ${name}, ${country}: temperatura ${temp}°C, umidade ${hum}%, vento ${wind} km/h.`;

    const cite =
      lang === "es" ? "Fuente: Open-Meteo." :
      lang === "en" ? "Source: Open-Meteo." :
      "Fonte: Open-Meteo.";

    return { ok: true, answer: text, citations: cite };
  } catch {
    return { ok: false };
  }
}

// --------- Wikipédia (summary) ----------
async function wikipediaSummary(title, lang) {
  try {
    const langCode = lang === "en" ? "en" : lang === "es" ? "es" : "pt";
    const url = `https://${langCode}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const j = await fetch(url, { headers: { accept: "application/json" } }).then(r => r.json());
    const extract = j?.extract || j?.description;
    if (!extract) return { ok: false };

    const cite =
      lang === "es" ? "Fuente: Wikipedia." :
      lang === "en" ? "Source: Wikipedia." :
      "Fonte: Wikipédia.";

    return { ok: true, answer: extract, citations: cite };
  } catch {
    return { ok: false };
  }
}

// --------- Manchetes (Reuters + BBC via RSS) ----------
async function topHeadlines(lang) {
  try {
    const feeds = [
      "https://feeds.reuters.com/reuters/worldNews",
      "https://feeds.bbci.co.uk/news/world/rss.xml"
    ];

    const items = [];
    for (const f of feeds) {
      const xml = await fetch(f).then(r => r.text());
      // Extração simples de <item><title> / <link>
      const re = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>/gi;
      let m; let take = 0;
      while ((m = re.exec(xml)) && take < 3) {
        const title = m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
        const link = m[2].trim();
        items.push(`• ${title} — ${link}`);
        take++;
      }
    }

    if (!items.length) return { ok: false };

    const head =
      lang === "es" ? "Titulares recientes:" :
      lang === "en" ? "Latest headlines:" :
      "Manchetes recentes:";

    return { ok: true, answer: [head, "", ...items].join("\n") };
  } catch {
    return { ok: false };
  }
}
