const { searchContext } = require('./rag');
const { setSubject, getSubject } = require('./db');
const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

async function handleWhatsAppMessage(req, res) {
  try {
    console.info('[DEBUG] Corpo da requisição:', req.body);

    if (!req.body || typeof req.body.From !== 'string' || req.body.From.trim() === '') {
      console.error('[ERROR] Campo From está ausente ou inválido na requisição:', req.body);
      return res.status(400).send('Campo From inválido.');
    }

    const from = req.body.From;
    const phoneRaw = from.replace('whatsapp:', '').replace(/\D/g, '');
    if (phoneRaw.length < 10) {
      console.error('[ERROR] Número de telefone inválido ou vazio:', from);
      return res.status(400).send('Número de telefone inválido.');
    }
    const phone = phoneRaw;
    const query = (req.body.Body || '').trim();

    console.info('[INFO] Mensagem recebida:', { phone, query });

    const previous = await getSubject(phone, 'last_topic');
    const baseQuery = previous ? `${previous.prompt} ${query}` : query;

    const context = searchContext(baseQuery);
    let answer = context.pass ? context.response : `Não encontrei nada específico, mas posso te ajudar: ${query}`;

    await setSubject(phone, 'last_topic', { prompt: query, reply: answer });

    await twilio.messages.create({
      from: 'whatsapp:+14155238886',
      to: `whatsapp:+${phone}`,
      body: answer,
    });

    res.sendStatus(200);
  } catch (error) {
    console.error('[ERROR] Erro no handler WhatsApp:', error);
    res.status(500).send('Erro interno do servidor.');
  }
}

module.exports = { handleWhatsAppMessage };
