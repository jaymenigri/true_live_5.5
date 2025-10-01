// services/memory.js
import pg from "pg";
import { CONFIG } from "../config/appConfig.js";

/**
 * Pool opcional: se não houver DATABASE_URL o módulo funciona “no-op”
 * (não quebra o app; só não persiste entre reinícios).
 */
let pool = null;
if (CONFIG.DB_URL) {
  try {
    pool = new pg.Pool({
      connectionString: CONFIG.DB_URL,
      ssl: { rejectUnauthorized: false }
    });
  } catch (e) {
    console.warn("[MEMORY] não foi possível criar pool Postgres:", e?.message || e);
    pool = null;
  }
}

const SQL_CREATE_SESSIONS = `
CREATE TABLE IF NOT EXISTS tl_sessions(
  user_id    TEXT PRIMARY KEY,
  history    JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

const SQL_CREATE_STATE = `
CREATE TABLE IF NOT EXISTS tl_state(
  user_id    TEXT PRIMARY KEY,
  subject    TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

/** Cria tabelas (se houver DB). */
export async function initMemory() {
  if (!pool) return;
  await pool.query(SQL_CREATE_SESSIONS);
  await pool.query(SQL_CREATE_STATE);
}

/** Lê o histórico de turnos (respeitando TTL/GC). */
export async function readHistory(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    "SELECT history, updated_at FROM tl_sessions WHERE user_id=$1",
    [userId]
  );
  if (!rows.length) return [];
  const ageH = (Date.now() - new Date(rows[0].updated_at).getTime()) / 36e5;
  if (ageH > CONFIG.MEMORY.GC_HOURS) {
    await pool.query("DELETE FROM tl_sessions WHERE user_id=$1", [userId]);
    return [];
  }
  if (ageH > CONFIG.MEMORY.TTL_HOURS) return [];
  return rows[0].history || [];
}

/** Anexa um turno ao histórico (mantém no máx. MAX_TURNS). */
export async function writeTurn(userId, role, content) {
  if (!pool) return;
  const hist = await readHistory(userId);
  const next = [...hist, { role, content, t: new Date().toISOString() }]
    .slice(-CONFIG.MEMORY.MAX_TURNS);
  await pool.query(
    `INSERT INTO tl_sessions(user_id, history, updated_at)
     VALUES($1,$2,now())
     ON CONFLICT (user_id)
     DO UPDATE SET history=EXCLUDED.history, updated_at=now()`,
    [userId, JSON.stringify(next)]
  );
}

/** Lê o “sujeito” corrente (para resolver pronomes), respeitando TTL. */
export async function getSubject(userId) {
  if (!pool) return null;
  const { rows } = await pool.query(
    "SELECT subject, updated_at FROM tl_state WHERE user_id=$1",
    [userId]
  );
  if (!rows.length) return null;
  const ageH = (Date.now() - new Date(rows[0].updated_at).getTime()) / 36e5;
  if (ageH > CONFIG.MEMORY.TTL_HOURS) return null;
  return rows[0].subject || null;
}

/** Grava/atualiza o “sujeito” (renova o TTL). */
export async function setSubject(userId, subject) {
  if (!pool || !subject) return;
  await pool.query(
    `INSERT INTO tl_state(user_id, subject, updated_at)
     VALUES($1,$2,now())
     ON CONFLICT (user_id)
     DO UPDATE SET subject=EXCLUDED.subject, updated_at=now()`,
    [userId, subject]
  );
}
