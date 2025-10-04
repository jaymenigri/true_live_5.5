// services/htmlExtract.js — extrator simples (Readability-like)
import { JSDOM } from "jsdom";

export function extractArticle(html, baseUrl = "") {
  if (!html) return { title: "", text: "" };
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title =
    doc.querySelector("meta[property='og:title']")?.content ||
    doc.querySelector("title")?.textContent ||
    "";

  doc.querySelectorAll("nav, header, footer, aside, script, style, noscript, iframe, form, svg, .advert, .ads, .promo").forEach((el) => el.remove());

  const candidates = [];
  doc.querySelectorAll("article, main, .content, .post, .entry, .story, .article, .post-content").forEach((el) => candidates.push(el));
  if (candidates.length === 0) candidates.push(doc.body);

  let best = candidates[0];
  let bestScore = 0;
  candidates.forEach((el) => {
    const text = el.textContent || "";
    const score = text.split(/\s+/).length - (el.querySelectorAll("a").length * 5);
    if (score > bestScore) { bestScore = score; best = el; }
  });

  best.querySelectorAll("script,style,button,input,textarea,select,svg,figcaption").forEach((el) => el.remove());
  const text = (best.textContent || "")
    .replace(/\s+/g, " ")
    .replace(/^\s+|\s+$/g, "");

  return { title: (title || "").trim(), text: text.trim() };
}
