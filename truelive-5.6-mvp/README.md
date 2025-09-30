# True Live 5.6-MVP

Deploy rápido (Heroku):
1) Configure as Config Vars: OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM (whatsapp:+1...), DATABASE_URL, ADMIN_TOKEN, RAG_THRESHOLD=0.5, ANSWER_OUTSIDE_CORPUS=1
2) Webhook Twilio: https://SEU-APP.herokuapp.com/whatsapp (também aceita /twilio/whatsapp)
3) Health (navegador): /admin/health → {"ok":false} (normal sem token)

Substitua `corpus/corpus.json` pelo seu acervo real.
