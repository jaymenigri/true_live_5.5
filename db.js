const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function setSubject(phone, subject, data) {
  await pool.query(`
    INSERT INTO tlcontext (phone, subject, data, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (phone, subject)
    DO UPDATE SET data = EXCLUDED.data, updated_at = NOW();
  `, [phone, subject, data]);
}

async function getSubject(phone, subject) {
  const res = await pool.query(`
    SELECT data FROM tlcontext
    WHERE phone = $1 AND subject = $2
    ORDER BY updated_at DESC
    LIMIT 1;
  `, [phone, subject]);
  return res.rows.length ? res.rows[0].data : null;
}

module.exports = { setSubject, getSubject, pool };
