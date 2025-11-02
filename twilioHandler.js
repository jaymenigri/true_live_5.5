const { searchContext } = require('./rag');
const { setSubject, getSubject } = require('./db');
const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

async function handleWhatsAppMessage(req, res) {
  try {
    const from = req.body.From || '';
    // Remove "whatsapp:" e deixa só números
    const phoneRaw = from.replace('whatsapp:', '').replace(/\D/g, '');
    const phone = phoneRaw.length > 10 ? phoneRaw : null;

    if (!phone) {
      console.error('[ERROR] Número de telefone inválido ou vazio:', from);
      return res.status(400).send('Número de telefone inválido.');
    }

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
      from: 'whatsapp:+14155238886', // Número oficial Twilio WhatsApp
      to: `whatsapp:+${phone}`,      // Telefone formatado corretamente
      body: answer
    });

    res.sendStatus(200);
  } catch (error) {
    console.error('Erro no handler WhatsApp:', error);
    res.status(500).send('Erro interno do servidor.');
  }
}

module.exports = { handleWhatsAppMessage };
