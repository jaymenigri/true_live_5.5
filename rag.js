const corpus = require('./corpus.json');
const natural = require('natural');
const tokenizer = new natural.WordTokenizer();

function searchContext(query) {
  const tokens = tokenizer.tokenize(query.toLowerCase());
  let best = { score: 0, text: null };

  for (const item of corpus) {
    const textTokens = tokenizer.tokenize(item.text.toLowerCase());
    const intersection = tokens.filter(t => textTokens.includes(t));
    const score = intersection.length / Math.max(tokens.length, 1);
    if (score > best.score) best = { score, text: item.text };
  }

  const pass = best.score >= 0.5;
  return { score: best.score, pass, response: best.text || "Não encontrei algo relevante." };
}

module.exports = { searchContext };
