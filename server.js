const express = require('express');
const { handleWhatsAppMessage } = require('./twilioHandler');
const app = express();

app.use(express.json());
app.post('/twilio/whatsapp', handleWhatsAppMessage);

app.listen(process.env.PORT || 3000, () => {
  console.log('[INFO] Server ativo.');
});
