const { query } = require('../config/database');
const logger = require('../config/logger');

class SettingsService {
  async get(key) {
    const result = await query('SELECT value FROM settings WHERE key = $1', [key]);
    return result.rows[0]?.value || null;
  }

  async getAll() {
    const result = await query('SELECT key, value, description, updated_at FROM settings ORDER BY key');
    const settings = {};
    for (const row of result.rows) {
      settings[row.key] = {
        value: row.key.includes('token') || row.key.includes('secret') ? '***REDACTED***' : row.value,
        raw: row.value,
        description: row.description,
        updated_at: row.updated_at,
      };
    }
    return settings;
  }

  async set(key, value, description = null) {
    await query(
      `INSERT INTO settings (key, value, description, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value, description]
    );
    logger.info('[Settings] Configuração atualizada', { key });
  }

  async setMultiple(settings) {
    for (const [key, value] of Object.entries(settings)) {
      await this.set(key, value);
    }
  }

  /**
   * Retorna configurações seguras (sem tokens/secrets em claro) para o frontend
   */
  async getSafe() {
    const all = await this.getAll();
    const safe = {};
    for (const [key, data] of Object.entries(all)) {
      const isSecretField =
        key.includes('secret') || key.includes('token') || key.includes('password');
      safe[key] = {
        value: isSecretField ? '' : data.value,
        configured: isSecretField ? Boolean(data.raw?.trim()) : undefined,
        description: data.description,
        updated_at: data.updated_at,
      };
    }
    return safe;
  }
}

module.exports = new SettingsService();
