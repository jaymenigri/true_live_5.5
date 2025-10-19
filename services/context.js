// services/context.js — conversa/assunto com Postgres (fail-safe em memória)
import pkg from "pg";
const { Pool } = pkg;

const memory = new Map();
let pool = null;
let dbOk = false;

export async function initContext() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn("[WARN] Contexto: DATABASE_URL ausente, usando memória local.");
    return { db: false };
  }
  try {
    pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await pool.query("create table if not exists tl_context (phone text primary key, subject text, updated_at timestamptz default now())");
    dbOk = true;
    console.log("[INFO] Contexto/PG pronto.");
  } catch (e) {
    console.warn("[WARN] Contexto/PG indisponível, usando memória local.", e.message);
    dbOk = false;
  }
  return { db: dbOk };
}

export async function setSubject(phone, subject) {
  if (!phone) return;
  if (dbOk) {
    try {
      await pool.query(
        "insert into tl_context(phone, subject) values($1,$2) on conflict(phone) do update set subject=excluded.subject, updated_at=now()",
        [phone, subject || null]
      );
      return;
    } catch (e) {
      console.warn("[WARN] setSubject/PG:", e.message);
    }
  }
  memory.set(phone, { subject, updated_at: Date.now() });
}

export async function getSubject(phone) {
  if (!phone) return null;
  if (dbOk) {
    try {
      const r = await pool.query("select subject from tl_context where phone=$1", [phone]);
      return r.rows[0]?.subject || null;
    } catch (e) {
      console.warn("[WARN] getSubject/PG:", e.message);
    }
  }
  return memory.get(phone)?.subject || null;
}

export function contextStatus() {
  return dbOk;
}
