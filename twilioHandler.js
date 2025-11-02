const { searchContext } = require('./rag');
const { setSubject, getSubject } = require('./db');
const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

async function handleWhatsAppMessage(req, res) {
  const from = req.body.From || '';
  const phone = from.replace('whatsapp:+', '');
  const query = req.body.Body?.trim() || '';

  console.info('[INFO] Mensagem recebida:', { phone, query });

  const previous = await getSubject(phone, 'last_topic');
  const baseQuery = previous ? `${previous.prompt} ${query}` : query;

  const context = searchContext(baseQuery);
  let answer;

  if (context.pass) {
    answer = context.response;
  } else {
    answer = `Não encontrei nada específico, mas posso te ajudar: ${query}`;
  }

  await setSubject(phone, 'last_topic', { prompt: query, reply: answer });

  await twilio.messages.create({
    from: 'whatsapp:+14155238886',
    to: `whatsapp:+${phone}`,
    body: answer
  });

  res.sendStatus(200);
}

module.exports = { handleWhatsAppMessage };
