const express = require('express');
const bodyParser = require('body-parser');
const { handleWhatsAppMessage } = require('./twilioHandler');
const { pool } = require('./db');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get('/', (req, res) => res.send('True Live ativo.'));
app.post('/twilio/whatsapp', handleWhatsAppMessage);

pool.connect().then(() => console.info('[INFO] Contexto/PG pronto.'));
app.listen(process.env.PORT || 3000, () => console.info('[INFO] Server ativo.'));
