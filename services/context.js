import pg from "pg";
const { Pool } = pg;
let pool = null;
let ready = false;

export async function init() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn("[WARN] Contexto: usando memória local (sem Postgres).");
    return false;
  }
  pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false }
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tl_context (
      id SERIAL PRIMARY KEY,
      from_number TEXT NOT NULL,
      subject TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS tl_context_from_idx ON tl_context(from_number);
  `);
  ready = true;
  console.info("[INFO] Postgres conectado.");
  return true;
}

export async function setSubject(from, subject) {
  if (!ready) return;
  // ensure row exists (simple upsert approach for broad PG versions)
  try {
    await pool.query(
      "INSERT INTO tl_context(from_number, subject) VALUES($1,$2)",
      [from, subject]
    );
  } catch {}
  await pool.query(
    "UPDATE tl_context SET subject=$2, updated_at=NOW() WHERE from_number=$1",
    [from, subject]
  );
}

export async function getSubject(from) {
  if (!ready) return null;
  const r = await pool.query(
    "SELECT subject FROM tl_context WHERE from_number=$1 ORDER BY updated_at DESC LIMIT 1",
    [from]
  );
  return r.rows[0]?.subject || null;
}
