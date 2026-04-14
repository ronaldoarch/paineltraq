require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../src/config/database');

async function seed() {
  console.log('🌱 Criando dados iniciais...\n');

  // Criar usuário admin padrão (user: admin / pass: bearbet2024)
  const passwordHash = await bcrypt.hash('bearbet2024', 12);
  const resetAdmin = process.env.RESET_ADMIN_PASSWORD === 'true';
  if (resetAdmin) {
    await pool.query(
      `INSERT INTO admin_users (username, password_hash, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role`,
      ['admin', passwordHash, 'superadmin']
    );
    console.log('  ✅ Admin atualizado (RESET_ADMIN_PASSWORD=true → senha reposta: bearbet2024)');
  } else {
    await pool.query(
      `INSERT INTO admin_users (username, password_hash, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING`,
      ['admin', passwordHash, 'superadmin']
    );
    console.log('  ✅ Usuário admin: criado se não existia (user: admin / pass: bearbet2024)');
    console.log('  ℹ️  Se o login falhar mas o admin já existia, use RESET_ADMIN_PASSWORD=true uma vez.');
  }
  console.log('  ⚠️  TROQUE A SENHA APÓS O PRIMEIRO LOGIN!\n');

  // Configurações iniciais
  const settings = [
    ['meta_pixel_id', process.env.META_PIXEL_ID || '', 'ID do Pixel do Meta'],
    ['meta_access_token', process.env.META_ACCESS_TOKEN || '', 'Access Token da CAPI do Meta'],
    ['meta_api_version', process.env.META_API_VERSION || 'v19.0', 'Versão da API do Meta'],
    ['meta_test_event_code', process.env.META_TEST_EVENT_CODE || '', 'Código de teste (deixe vazio em produção)'],
    ['debug_mode', process.env.DEBUG_MODE || 'false', 'Modo debug ativo'],
    ['deduplication_window_minutes', '60', 'Janela de deduplicação em minutos'],
  ];

  for (const [key, value, description] of settings) {
    await pool.query(
      `INSERT INTO settings (key, value, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value, description]
    );
    console.log(`  ✅ Setting: ${key}`);
  }

  console.log('\n✅ Seed concluído!');
  await pool.end();
}

seed().catch((err) => {
  console.error('❌ Erro no seed:', err);
  process.exit(1);
});
