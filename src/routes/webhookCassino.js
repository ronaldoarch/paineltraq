const express = require('express');
const router = express.Router();
const eventService = require('../services/eventService');
const webhookLogger = require('../middleware/webhookLogger');
const settingsService = require('../services/settingsService');
const logger = require('../config/logger');

// Logar todos os webhooks do cassino
router.use(webhookLogger('cassino'));

const CASSINO_SECRET_CACHE_TTL_MS = 30_000;
let cassinoDbSecretCache = { value: '', loadedAt: 0 };

async function resolveCassinoSecretFromDb() {
  const now = Date.now();
  if (now - cassinoDbSecretCache.loadedAt < CASSINO_SECRET_CACHE_TTL_MS) {
    return cassinoDbSecretCache.value;
  }
  const db = String((await settingsService.get('webhook_secret_cassino')) || '').trim();
  cassinoDbSecretCache = { value: db, loadedAt: now };
  return db;
}

/**
 * Se WEBHOOK_SECRET_CASSINO (env) ou webhook_secret_cassino (BD) existir, exige header ou Bearer.
 */
async function verifyCassinoWebhookSecret(req, res, next) {
  try {
    const envSecret = process.env.WEBHOOK_SECRET_CASSINO?.trim();
    const dbSecret = envSecret ? '' : await resolveCassinoSecretFromDb();
    const secret = envSecret || dbSecret;
    if (!secret) return next();

    const header =
      req.get('x-webhook-secret') ||
      req.get('x-cassino-webhook-secret') ||
      req.get('x-webhook-token');
    const auth = req.get('authorization');
    const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if ((header && header === secret) || (bearer && bearer === secret)) {
      return next();
    }

    logger.warn('[Cassino Webhook] Secret inválida ou ausente');
    return res.status(401).json({
      error: 'Unauthorized',
      hint:
        'Envie o mesmo secret no header X-Webhook-Secret ou Authorization: Bearer <secret>. Gere o valor em Configurações ou defina WEBHOOK_SECRET_CASSINO no servidor.',
    });
  } catch (err) {
    logger.error('[Cassino Webhook] Erro ao validar secret', { error: err.message });
    return res.status(500).json({ error: 'internal_error' });
  }
}

/**
 * POST /webhook/cassino
 * 
 * Recebe webhooks do backoffice do cassino.
 * Eventos:
 * - user.register
 * - payment.deposit.started
 * - payment.deposit.completed
 * 
 * Payload esperado:
 * {
 *   "event": "user.register",
 *   "data": {
 *     "user_id": "...",
 *     "email": "...",
 *     "phone": "...",
 *     "tracking": {
 *       "utm_source": "facebook",
 *       "fbc": "...",
 *       "fbp": "...",
 *       "click_id": "..."
 *     }
 *   }
 * }
 */
router.post('/', verifyCassinoWebhookSecret, async (req, res) => {
  try {
    const payload = req.body;
    const eventType = payload.event || payload.type || '';

    logger.info('[Cassino Webhook] Evento recebido', {
      event: eventType,
      userId: payload.data?.user_id || 'N/A',
    });

    // Verificar se é um evento relevante
    const relevantEvents = [
      'user.register',
      'payment.deposit.started',
      'payment.deposit.completed',
      'register',
      'deposit_started',
      'deposit_completed',
    ];

    if (!relevantEvents.some(e => eventType.toLowerCase().includes(e.replace('.', '')))) {
      logger.info('[Cassino Webhook] Evento ignorado', { event: eventType });
      return res.status(200).json({ received: true, processed: false, reason: 'event_not_relevant' });
    }

    // Extrair dados
    const data = payload.data || payload;
    const tracking = data.tracking || data.meta || data.metadata || {};

    const userData = {
      email: data.email || data.player_email || null,
      phone: data.phone || data.mobile || data.player_phone || null,
      first_name: data.first_name || data.name?.split(' ')[0] || null,
      last_name: data.last_name || data.name?.split(' ').slice(1).join(' ') || null,
      external_id: data.user_id || data.player_id || data.id || null,
      fbc: tracking.fbc || data.fbc || null,
      fbp: tracking.fbp || data.fbp || null,
      click_id: tracking.click_id || tracking.fbclid || data.click_id || null,
      ip_address: tracking.ip || data.ip || data.ip_address || null,
      user_agent: tracking.user_agent || data.user_agent || null,
      utm_source: tracking.utm_source || data.utm_source || null,
      utm_medium: tracking.utm_medium || data.utm_medium || null,
      utm_campaign: tracking.utm_campaign || data.utm_campaign || null,
      utm_content: tracking.utm_content || data.utm_content || null,
      utm_term: tracking.utm_term || data.utm_term || null,
      country: data.country || 'BR',
      source: 'cassino',
    };

    const value = parseFloat(data.amount || data.value || data.deposit_amount || 0);

    const result = await eventService.processEvent({
      eventType: eventType.toLowerCase(),
      source: 'cassino',
      payload,
      userData,
      value,
      currency: data.currency || 'BRL',
    });

    return res.status(200).json({
      received: true,
      processed: true,
      ...result,
    });
  } catch (error) {
    logger.error('[Cassino Webhook] Erro ao processar', { error: error.message });
    return res.status(200).json({
      received: true,
      processed: false,
      error: error.message,
    });
  }
});

function invalidateCassinoWebhookSecretCache() {
  cassinoDbSecretCache = { value: '', loadedAt: 0 };
}
router.invalidateCassinoWebhookSecretCache = invalidateCassinoWebhookSecretCache;

module.exports = router;
