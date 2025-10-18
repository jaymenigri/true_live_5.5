
True Live — v2.10.8 (Heroku final)

Heroku Config Vars:
- OPENAI_API_KEY=xxxxxxxx
- ADMIN_TOKEN=truelive2025
- DATABASE_URL=postgres://... (com SSL)
- (opcional) TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID

Testes:
- GET /admin/health?token=truelive2025
- GET /admin/ingest/run?token=truelive2025&mode=rss&max=50
- POST /whatsapp { "from":"whatsapp:+55119...", "text":"Quem foi Ben-Gurion?" }
