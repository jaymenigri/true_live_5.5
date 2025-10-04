// services/realtime.js — v1.2 (final)
// Detecção simples de perguntas de “atualidade”. Se identificado, responde
// de forma segura e clara (sem travar o fluxo). Não usa scraping aqui.

export async function maybeAnswerRealtime(query, lang = "pt") {
  const q = (query || "").toLowerCase();

  const wantsNow = /\b(hoje|agora|atual|última|ultima|quantos|número|numero)\b/.test(q);
  const hostages = /\b(ref[eé]ns|refens)\b/.test(q) && /\bgaza\b/.test(q);

  if (wantsNow && hostages) {
    const textPt =
      "Os números de reféns em Gaza mudam com atualizações oficiais e negociações em curso. " +
      "Para o dado mais recente, consulte fontes oficiais israelenses e grandes veículos confiáveis. " +
      "Se quiser, posso priorizar a verificação por fontes externas quando você perguntar novamente.";
    const textEs =
      "Las cifras de rehenes en Gaza cambian con actualizaciones oficiales y negociaciones en curso. " +
      "Para el dato más reciente, consulta fuentes oficiales israelíes y medios confiables. " +
      "Si quieres, puedo priorizar la verificación con fuentes externas cuando preguntes de nuevo.";
    const textEn =
      "Hostage counts in Gaza change with official updates and ongoing negotiations. " +
      "For the latest number, check official Israeli sources and major reputable outlets. " +
      "If you’d like, I can prioritize external verification on your next question.";

    return { ok: true, text: lang === "es" ? textEs : lang === "en" ? textEn : textPt };
  }

  return null; // não intercepta
}
