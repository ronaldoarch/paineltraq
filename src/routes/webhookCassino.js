const express = require('express');
const router = express.Router();
const eventService = require('../services/eventService');
const webhookLogger = require('../middleware/webhookLogger');
const logger = require('../config/logger');

// Logar todos os webhooks do cassino
router.use(webhookLogger('cassino'));

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
router.post('/', async (req, res) => {
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

module.exports = router;
