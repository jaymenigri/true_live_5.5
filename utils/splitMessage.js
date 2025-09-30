export function splitForWhatsApp(text, maxLen = 1600) {
  const parts = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    if (end < text.length) {
      const lastBreak = text.lastIndexOf("\n", end);
      const lastSpace = text.lastIndexOf(" ", end);
      const cut = Math.max(lastBreak, lastSpace);
      if (cut > i + 200) end = cut; // não cortar muito cedo
    }
    parts.push(text.slice(i, end).trim());
    i = end;
  }
  return parts.filter(Boolean);
}
