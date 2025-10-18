// services/context.js — v2.10.8 (ESM-safe Postgres)
import pkg from "pg";
const { Pool } = pkg;

const url = process.env.DATABASE_URL;
const ssl = url && !/sslmode=/.test(url) ? { rejectUnauthorized: false } : undefined;
const pool = url ? new Pool({ connectionString: url, ssl }) : null;

async function ensure() {
  if (!pool) throw new Error("DATABASE_URL ausente.");
  await pool.query(`
    create table if not exists tl_context (
      id serial primary key,
      user_id text not null,
      subject text,
      data jsonb default '{}'::jsonb,
      updated_at timestamp default now()
    );
    create index if not exists tl_context_user on tl_context(user_id);
  `);
}

export async function init() {
  if (!pool) return { ok:false, db:false };
  await ensure();
  return { ok:true, db:true };
}

export async function get(user) {
  if (!pool) return null;
  const r = await pool.query(
    "select * from tl_context where user_id=$1 order by updated_at desc limit 1",
    [user]
  );
  return r.rows[0] || null;
}

export async function remember(user, subject, data = {}) {
  if (!pool) return;
  await pool.query(
    `insert into tl_context (user_id, subject, data, updated_at)
     values ($1,$2,$3,now())`,
    [user, subject, data]
  );
}
