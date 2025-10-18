// db.js — tiny pg ping
import { Pool } from "pg";
export function pgPool(){
  const url = process.env.DATABASE_URL;
  if(!url) return null;
  const ssl = url && !/sslmode=/.test(url) ? { rejectUnauthorized: false } : undefined;
  return new Pool({ connectionString: url, ssl });
}