export function detectLang(s) {
  const t = (s || "").toLowerCase();
  const hasInv = t.includes("¿") || t.includes("¡");
  const ptHints = ["você","vocês","pra","não","está","estão","será","porque","por que","aqui","quem","com quem","onde","quando","nasceu","morreu","casado","esposa","marido","dele","dela","foi"];
  const esHints = ["usted","ustedes","porque","por qué","aquí","mañana","gracias","quien","quién","donde","cuándo","casado","esposa","esposo","de él","de ella","fue"];
  const ptScore = ptHints.reduce((a,w)=>a+(t.includes(w)?1:0),0);
  const esScore = esHints.reduce((a,w)=>a+(t.includes(w)?1:0),0) + (hasInv?1:0);
  if (esScore > ptScore) return "es"; if (ptScore > 0) return "pt"; return "en";
}
