// ===== True Live v2.10.9-autoingest =====
// Server principal com ingest automático + integração Twilio + RAG + fallback seguro

import express from "express";
import morgan from "morgan";
import bodyParser from "body-parser";
import pkg from "pg";
import { ingestAll } from "./services/ingest.js";
import { loadCorpus } from "./services/context.js";
import { handleIncoming } from "./controllers/chatController.js";
import { fileURLToPath } from "url";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const twilio = require("twilio");

const { Pool } = pkg;

// =============================
// Inicialização do servidor
// =============================
const app = express();
app.use(morgan("dev"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// =============================
// Banco de dados
// =============================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let corpus = [];
let corpusCount = 0;

// =============================
// Ingest automático no startup
// =============================
try {
  console.log("[INIT] Executando ingest automático...");
  const added = await ingestAll();
  console.log(`[INIT] Ingest concluído. Documentos adicionados: ${added}`);
} catch (err) {
  console.warn("[INIT] Ingest automático falhou:", err.message);
}

try {
  corpus = await loadCorpus();
  corpusCount = corpus.length;
  console.log(`[INFO] Corpus carregado com ${corpusCount} itens.`);
} catch (err) {
  console.error("[ERRO] Falha ao carregar corpus:", err.message);
}

// =============================
// Twilio Client
// =============================
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    console.log("[INFO] Twilio client pronto.");
  } catch (err) {
    console.error("[ERRO] Falha ao inicializar Twilio:", err.message);
  }
} else {
  console.warn("[WARN] Twilio não configurado.");
}

// =============================
// Rotas principais
// =============================
app.get("/", (req, res) => {
  res.send("✅ True Live v2.10.9-autoingest rodando com sucesso.");
});

app.post("/twilio/whatsapp", async (req, res) => {
  try {
    res.sendStatus(200); // responde rápido para evitar timeout do Twilio
    await handleIncoming(req, twilioClient);
  } catch (err) {
    console.error("[ERROR] /twilio/whatsapp:", err.message);
  }
});

// =============================
// Rotas administrativas
// =============================
app.get("/admin/health", async (req, res) => {
  const token = req.query.token;
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }

  let dbStatus = false;
  try {
    const client = await pool.connect();
    await client.query("SELECT NOW()");
    client.release();
    dbStatus = true;
  } catch {
    dbStatus = false;
  }

  res.json({
    status: "ok",
    version: "v2.10.9-autoingest",
    corpus_items: corpusCount,
    db: dbStatus,
  });
});

app.get("/admin/ingest/run", async (req, res) => {
  const token = req.query.token;
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const added = await ingestAll();
    corpus = await loadCorpus();
    corpusCount = corpus.length;
    res.json({ added, total: corpusCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================
// Inicialização
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[INFO] Server up { port: '${PORT}', corpus_items: ${corpusCount} }`);
});
