import pg from "pg";
import { CONFIG } from "../config/appConfig.js";

const pool = CONFIG.DB_URL ? new pg.Pool({ connectionString: CONFIG.DB_URL, ssl: { rejectUnauthorized: false } }) : null;

const SQL_CREATE_SESSIONS = `
CREATE TABLE IF NOT EXISTS tl_sessions(
  user_id TEXT PRIMARY KEY,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

const SQL_CREATE_STATE = `
CREATE TABLE IF NOT EXISTS tl_state(
  user_id TEXT PRIMARY KEY,
  subject TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

export async function initMemory() {
  if (!pool) return;
  await pool.query(SQL_CREATE_SESSIONS);
  await pool.query(SQL_CREATE_STATE);
}

export async function readHistory(userId) {
  if (!pool) return [];
  const { rows } = await pool.query("SELECT history, updated_at FROM tl_sessions WHERE user_id=$1",[userId]);
  if (!rows.length) return [];
  const ageH = (Date.now() - new Date(rows[0].updated_at).getTime()) / 36e5;
  if (ageH > CONFIG.MEMORY.GC_HOURS) { await pool.query("DELETE FROM tl_sessions WHERE user_id=$1",[userId]); return []; }
  if (ageH > CONFIG.MEMORY.TTL_HOURS) return [];
  return rows[0].history || [];
}

export async function writeTurn(userId, role, content) {
  if (!pool) return;
  const hist = await readHistory(userId);
  const next = [...hist, { role, content, t: new Date().toISOString() }].slice(-CONFIG.MEMORY.MAX_TURNS);
  await pool.query(
    `INSERT INTO tl_sessions(user_id, history, updated_at) VALUES($1,$2,now())
     ON CONFLICT (user_id) DO UPDATE SET history=EXCLUDED.history, updated_at=now()`,
    [userId, JSON.stringify(next)]
  );
}

export async function getSubject(userId) {
  if (!pool) return null;
  const { rows } = await pool.query("SELECT subject, updated_at FROM tl_state WHERE user_id=$1",[userId]);
  if (!rows.length) return null;
  const ageH = (Date.now() - new Date(rows[0].updated_at).getTime()) / 36e5;
  if (ageH > CONFIG.MEMORY.TTL_HOURS) return null;
  return rows[0].subject || null;
}

export async function setSubject(userId, subject) {
  if (!pool || !subject) return;
  await pool.query(
    `INSERT INTO tl_state(user_id, subject, updated_at) VALUES($1,$2,now())
     ON CONFLICT (user_id) DO UPDATE SET subject=EXCLUDED.subject, updated_at=now()`,
    [userId, subject]
  );
}
