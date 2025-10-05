// services/context.js — Postgres OBRIGATÓRIO (fail-fast)

import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL || "";
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL ausente. Memória persistente é obrigatória.");
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages_context (
      user_id TEXT PRIMARY KEY,
      subject TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
await init();

export async function loadContext(userId) {
  if (!userId) return {};
  const { rows } = await pool.query(
    "SELECT subject FROM messages_context WHERE user_id = $1",
    [userId]
  );
  if (rows.length === 0) return {};
  return { subject: rows[0].subject || null };
}

export async function saveContext(userId, subject) {
  if (!userId) return;
  await pool.query(
    `
    INSERT INTO messages_context (user_id, subject, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET subject = EXCLUDED.subject, updated_at = NOW()
    `,
    [userId, subject || null]
  );
}

// opcional: limpeza de itens muito antigos (não é chamada automaticamente)
// export async function cleanup(days = 3) {
//   await pool.query(`DELETE FROM messages_context WHERE updated_at < NOW() - ($1 || ' days')::INTERVAL`, [days]);
// }
