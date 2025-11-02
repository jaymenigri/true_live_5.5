import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function getSubject(phone, subject) {
  const res = await pool.query(
    'SELECT data FROM tlcontext WHERE phone = $1 AND subject = $2',
    [phone, subject]
  );
  if (res.rows.length > 0) {
    return res.rows[0].data;
  }
  return null;
}

export async function setSubject(phone, subject, data) {
  const res = await pool.query(
    `INSERT INTO tlcontext (phone, subject, data, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (phone, subject) DO UPDATE SET data = EXCLUDED.data, updated_at=NOW()`,
    [phone, subject, data]
  );
  return res;
}
