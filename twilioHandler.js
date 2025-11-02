const { searchContext } = require('./rag');
const { setSubject, getSubject } = require('./db');
const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

async function handleWhatsAppMessage(req, res) {
  const from = req.body.From || '';
  const phoneRaw = from.replace('whatsapp:', '').replace(/\D/g, ''); // Remove tudo exceto números
  const phone = phoneRaw.length > 0 ? phoneRaw : null;
  const query = req.body.Body?.trim() || '';

  if (!phone) {
    console.error('[ERROR] Número de telefone inválido ou vazio:', from);
    return res.status(400).send('Número de telefone inválido.');
  }

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
    from: 'whatsapp:+14155238886', // Número oficial Twilio WhatsApp
    to: `whatsapp:+${phone}`,      // Formata telefone corretamente para Twilio
    body: answer
  });

  res.sendStatus(200);
}

module.exports = { handleWhatsAppMessage };
