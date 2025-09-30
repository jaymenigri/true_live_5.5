export function detectLang(s) {
  const t = (s || "").toLowerCase();
  const hasInv = t.includes("¿") || t.includes("¡");

  const pt = ["você","vocês","pra","não","está","estão","será","porque","por que","aqui"];
  const es = ["usted","ustedes","está","están","porque","por qué","aquí","mañana","gracias"];

  const ptScore = pt.reduce((a,w)=>a+(t.includes(w)?1:0),0);
  const esScore = es.reduce((a,w)=>a+(t.includes(w)?1:0),0) + (hasInv?1:0);

  if (esScore > ptScore) return "es";
  if (ptScore > 0) return "pt";
  return "en";
}
