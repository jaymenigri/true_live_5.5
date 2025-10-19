// server.js — True Live v2.10.9 (PG-STABLE-FULL)
import express from "express";
import morgan from "morgan";
import { createServer } from "http";
import { chatWebhook, adminHealth } from "./controllers/chatController.js";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(morgan("tiny"));

// Health/Admin
app.get("/admin/health", adminHealth);

// Twilio WhatsApp webhook
app.post("/twilio/whatsapp", chatWebhook);

// Root
app.get("/", (req, res) => res.status(200).send("True Live v2.10.9 — online"));

// Boot
const PORT = process.env.PORT || 3000;
createServer(app).listen(PORT, () => {
  console.log(`[INFO] Server up on ${PORT}`);
});
