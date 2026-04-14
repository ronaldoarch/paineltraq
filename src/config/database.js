const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'bearbet_tracker',
  user: process.env.DB_USER || 'bearbet',
  password: process.env.DB_PASSWORD || '',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '20000', 10),
  // Impede que uma query travada bloqueie a conexão por tempo indefinido,
  // o que causaria 504 no proxy. O default 25s está abaixo do timeout do Traefik.
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '25000', 10),
});

pool.on('error', (err) => {
  console.error('[DB] Erro inesperado no pool:', err);
});

pool.on('connect', () => {
  console.log('[DB] Nova conexão estabelecida');
});

/**
 * Executa uma query no banco
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.DEBUG_MODE === 'true') {
      console.log('[DB] Query executada', { text: text.substring(0, 80), duration: `${duration}ms`, rows: result.rowCount });
    }
    return result;
  } catch (error) {
    console.error('[DB] Erro na query:', { text: text.substring(0, 80), error: error.message });
    throw error;
  }
}

/**
 * Executa uma transação
 */
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, transaction };
