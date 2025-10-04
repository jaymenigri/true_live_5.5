// services/htmlExtract.js
// Extrai título e “texto principal” por heurística simples (sem libs extras)

export function extractMainText(html, url = "", fallbackTitle = "") {
  let title = "";
  try {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    title = (m && m[1] ? m[1] : "").trim();
  } catch {}
  if (!title) title = fallbackTitle || url;

  // Remove scripts/styles/noscript
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  // Heurística: pega blocos de <p>…</p>
  const paras = Array.from(clean.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)).map(m =>
    m[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  ).filter(Boolean);

  const text = paras.join(" ").trim();
  return { title, text };
}
