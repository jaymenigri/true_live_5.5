// services/context.js
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// =======================================================
// 🔧 Inicialização automática do contexto
// =======================================================
export async function init() {
  try {
    // Cria tabela se não existir
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tl_context (
        id SERIAL PRIMARY KEY,
        phone TEXT,
        subject TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Garante que a coluna "phone" exista (para versões antigas)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'tl_context' AND column_name = 'phone'
        ) THEN
          ALTER TABLE tl_context ADD COLUMN phone TEXT;
        END IF;
      END
      $$;
    `);

    console.log("[INFO] Contexto/PG pronto.");
  } catch (err) {
    console.error("[ERROR] Falha ao inicializar contexto PG:", err);
  }
}

// =======================================================
// 🔍 Funções de contexto
// =======================================================
export async function getSubject(phone) {
  try {
    const res = await pool.query(
      "SELECT subject FROM tl_context WHERE phone = $1 ORDER BY updated_at DESC LIMIT 1",
      [phone]
    );
    return res.rows[0]?.subject || null;
  } catch (err) {
    console.warn("[WARN] getSubject/PG:", err.message);
    return null;
  }
}

export async function setSubject(phone, subject) {
  try {
    await pool.query(
      `
      INSERT INTO tl_context (phone, subject, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (phone) DO UPDATE
      SET subject = EXCLUDED.subject, updated_at = NOW();
    `,
      [phone, subject]
    );
  } catch (err) {
    console.warn("[WARN] setSubject/PG:", err.message);
  }
}
