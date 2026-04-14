const { query } = require('../config/database');
const logger = require('../config/logger');

/**
 * Atualiza webhook_logs após processar (o INSERT inicial deixa processed = false).
 */
async function markWebhookLog(logId, processed, errorMessage = null) {
  if (!logId) return;
  try {
    await query(
      `UPDATE webhook_logs SET processed = $2, error_message = $3 WHERE id = $1`,
      [logId, Boolean(processed), errorMessage],
    );
  } catch (error) {
    logger.error('[WebhookLogger] Erro ao atualizar webhook_logs', { error: error.message });
  }
}

/**
 * Middleware que registra TODOS os webhooks recebidos
 * Isso garante que mesmo webhooks com erro sejam auditáveis
 */
function webhookLogger(source) {
  return async (req, res, next) => {
    try {
      const result = await query(
        `INSERT INTO webhook_logs (source, endpoint, method, headers, body, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          source,
          req.originalUrl,
          req.method,
          JSON.stringify({
            'content-type': req.headers['content-type'],
            'user-agent': req.headers['user-agent'],
            'x-forwarded-for': req.headers['x-forwarded-for'],
            'x-webhook-signature': req.headers['x-webhook-signature']
              ? '(presente)'
              : undefined,
          }),
          JSON.stringify(req.body),
          req.ip || req.headers['x-forwarded-for'] || 'unknown',
        ],
      );
      req.webhookLogId = result.rows[0]?.id;
    } catch (error) {
      logger.error('[WebhookLogger] Erro ao registrar webhook', { error: error.message });
    }
    next();
  };
}

webhookLogger.markWebhookLog = markWebhookLog;

module.exports = webhookLogger;
