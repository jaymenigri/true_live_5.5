const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Salva contexto do usuário por telefone
async function setSubject(phone, subject, data = {}) {
  await pool.query(
    `INSERT INTO tlcontext (phone, subject, data, created_at, updated_at)
    VALUES ($1, $2, $3, NOW(), NOW())
    ON CONFLICT (phone) DO UPDATE SET subject=$2, data=$3, updated_at=NOW()`,
    [phone, subject, JSON.stringify(data)]
  );
}

// Recupera o contexto salvo de um telefone
async function getSubject(phone, subject) {
  const result = await pool.query(
    `SELECT * FROM tlcontext WHERE phone=$1 AND subject=$2 ORDER BY updated_at DESC LIMIT 1`,
    [phone, subject]
  );
  return result.rows[0];
}

module.exports = { setSubject, getSubject, pool };
