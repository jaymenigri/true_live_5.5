export function detectLang(s) {
  if (!s) return "pt";
  const t = s.toLowerCase();
  if (/[א-ת]/.test(t)) return "he";
  if (/(¿|¡)/.test(t) || /(ó|á|í|ñ)/.test(t)) return "es";
  if (/[áéíóúãõç]/.test(t)) return "pt";
  return "en";
}
