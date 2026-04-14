require('dotenv').config();
const { pool } = require('../src/config/database');

const migrations = [
  // =============================================
  // TABELA: users
  // Armazena dados de usuários para matching
  // =============================================
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    external_id VARCHAR(255),
    email VARCHAR(255),
    email_hash VARCHAR(64),
    phone VARCHAR(50),
    phone_hash VARCHAR(64),
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    country VARCHAR(10) DEFAULT 'BR',
    fbc VARCHAR(500),
    fbp VARCHAR(500),
    click_id VARCHAR(500),
    ip_address VARCHAR(45),
    user_agent TEXT,
    utm_source VARCHAR(255),
    utm_medium VARCHAR(255),
    utm_campaign VARCHAR(500),
    utm_content VARCHAR(500),
    utm_term VARCHAR(255),
    source VARCHAR(50) DEFAULT 'unknown',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Índices para busca rápida de usuários
  `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
  `CREATE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)`,
  `CREATE INDEX IF NOT EXISTS idx_users_external_id ON users(external_id)`,
  `CREATE INDEX IF NOT EXISTS idx_users_click_id ON users(click_id)`,
  `CREATE INDEX IF NOT EXISTS idx_users_fbc ON users(fbc)`,
  `CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at)`,

  // =============================================
  // TABELA: events
  // Registra todos os eventos recebidos
  // =============================================
  `CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(100) UNIQUE NOT NULL,
    user_id INTEGER REFERENCES users(id),
    event_type VARCHAR(50) NOT NULL,
    event_name VARCHAR(100) NOT NULL,
    value DECIMAL(15, 2) DEFAULT 0,
    currency VARCHAR(10) DEFAULT 'BRL',
    source VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'received',
    meta_sent BOOLEAN DEFAULT FALSE,
    meta_sent_at TIMESTAMP WITH TIME ZONE,
    meta_response JSONB,
    raw_payload JSONB NOT NULL,
    matched_by VARCHAR(50),
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Índices para events
  `CREATE INDEX IF NOT EXISTS idx_events_event_id ON events(event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)`,
  `CREATE INDEX IF NOT EXISTS idx_events_meta_sent ON events(meta_sent)`,
  `CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_events_source ON events(source)`,

  // =============================================
  // TABELA: event_logs
  // Log detalhado de cada tentativa de envio ao Meta
  // =============================================
  `CREATE TABLE IF NOT EXISTS event_logs (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(100) NOT NULL,
    action VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL,
    request_payload JSONB,
    response_payload JSONB,
    error_message TEXT,
    attempt_number INTEGER DEFAULT 1,
    duration_ms INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_event_logs_event_id ON event_logs(event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_event_logs_created_at ON event_logs(created_at)`,

  // =============================================
  // TABELA: webhook_logs
  // Registra TODOS os webhooks recebidos (raw)
  // =============================================
  `CREATE TABLE IF NOT EXISTS webhook_logs (
    id SERIAL PRIMARY KEY,
    source VARCHAR(50) NOT NULL,
    endpoint VARCHAR(100) NOT NULL,
    method VARCHAR(10) DEFAULT 'POST',
    headers JSONB,
    body JSONB,
    ip_address VARCHAR(45),
    processed BOOLEAN DEFAULT FALSE,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_webhook_logs_source ON webhook_logs(source)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_logs_created_at ON webhook_logs(created_at)`,

  // =============================================
  // TABELA: settings
  // Configurações do sistema
  // =============================================
  `CREATE TABLE IF NOT EXISTS settings (
    id SERIAL PRIMARY KEY,
    key VARCHAR(100) UNIQUE NOT NULL,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // =============================================
  // TABELA: admin_users
  // Usuários do dashboard
  // =============================================
  `CREATE TABLE IF NOT EXISTS admin_users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'admin',
    last_login TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // =============================================
  // ÍNDICES EXTRAS: performance das queries de stats
  // Evitam full table scan nas consultas do /api/stats, reduzindo risco de 504
  // =============================================
  `CREATE INDEX IF NOT EXISTS idx_events_event_name ON events(event_name)`,
  `CREATE INDEX IF NOT EXISTS idx_events_created_at_event_name ON events(created_at, event_name)`,
  `CREATE INDEX IF NOT EXISTS idx_events_created_at_status ON events(created_at, status)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_logs_created_at_source ON webhook_logs(created_at, source)`,

  // =============================================
  // VIEW: dashboard_stats
  // View materializada para performance do dashboard
  // =============================================
  `CREATE OR REPLACE VIEW dashboard_stats AS
  SELECT
    DATE(created_at) as date,
    event_type,
    COUNT(*) as total_events,
    COUNT(CASE WHEN meta_sent = true THEN 1 END) as sent_to_meta,
    COUNT(CASE WHEN status = 'error' THEN 1 END) as errors,
    SUM(value) as total_value,
    COUNT(DISTINCT user_id) as unique_users
  FROM events
  GROUP BY DATE(created_at), event_type
  ORDER BY date DESC`,
];

async function runMigrations() {
  console.log('🚀 Iniciando migrações...\n');

  for (let i = 0; i < migrations.length; i++) {
    try {
      await pool.query(migrations[i]);
      const name = migrations[i].substring(0, 60).replace(/\s+/g, ' ').trim();
      console.log(`  ✅ [${i + 1}/${migrations.length}] ${name}...`);
    } catch (error) {
      console.error(`  ❌ [${i + 1}/${migrations.length}] Erro:`, error.message);
      throw error;
    }
  }

  console.log('\n✅ Todas as migrações executadas com sucesso!');
  await pool.end();
}

runMigrations().catch((err) => {
  console.error('❌ Falha nas migrações:', err);
  process.exit(1);
});
