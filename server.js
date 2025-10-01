// server.js (teste de fumaça)
import express from "express";
const app = express();
app.get("/", (_req, res) => res.send("UP"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("UP on", PORT));
