// db.js — ESM-safe pg import
import pkg from "pg";
const { Pool } = pkg;

export function pgPool() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const ssl = url && !/sslmode=/.test(url) ? { rejectUnauthorized: false } : undefined;
  return new Pool({ connectionString: url, ssl });
}
