export function detectLang(s) {
  // Very rough heuristic; OpenAI will ultimately respond in the user's language.
  if (!s) return "pt";
  const t = s.toLowerCase();
  if (/[א-ת]/.test(t)) return "he";
  if (/[áéíóúãõç]/.test(t)) return "pt";
  if (/(¿|¡)/.test(t) || /(ó|á|í|ñ)/.test(t)) return "es";
  return "en";
}
