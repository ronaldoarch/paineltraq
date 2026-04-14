const { query } = require('../config/database');
const logger = require('../config/logger');

/**
 * Middleware que registra TODOS os webhooks recebidos
 * Isso garante que mesmo webhooks com erro sejam auditáveis
 */
function webhookLogger(source) {
  return async (req, res, next) => {
    try {
      await query(
        `INSERT INTO webhook_logs (source, endpoint, method, headers, body, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          source,
          req.originalUrl,
          req.method,
          JSON.stringify({
            'content-type': req.headers['content-type'],
            'user-agent': req.headers['user-agent'],
            'x-forwarded-for': req.headers['x-forwarded-for'],
          }),
          JSON.stringify(req.body),
          req.ip || req.headers['x-forwarded-for'] || 'unknown',
        ]
      );
    } catch (error) {
      logger.error('[WebhookLogger] Erro ao registrar webhook', { error: error.message });
    }
    next();
  };
}

module.exports = webhookLogger;
