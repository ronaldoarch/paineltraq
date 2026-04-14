const express = require('express');
const router = express.Router();
const eventService = require('../services/eventService');
const webhookLogger = require('../middleware/webhookLogger');
const logger = require('../config/logger');

// Logar todos os webhooks do FluxLab
router.use(webhookLogger('fluxlab'));

/**
 * POST /webhook/fluxlab
 * 
 * Recebe webhooks do FluxLab.
 * Usado como fonte complementar de dados (enriquecimento)
 * 
 * Payload esperado:
 * {
 *   "event": "lead.created" | "deposit" | "register",
 *   "lead": {
 *     "email": "...",
 *     "phone": "...",
 *     "name": "...",
 *     "last_name": "...",
 *     "country": "BR",
 *     "ip": "...",
 *     "user_agent": "...",
 *     "fbc": "...",
 *     "fbp": "...",
 *     "click_id": "..."
 *   },
 *   "value": 0
 * }
 */
router.post('/', async (req, res) => {
  try {
    const payload = req.body;
    const eventType = payload.event || payload.type || 'lead.created';
    const lead = payload.lead || payload.data || payload;

    logger.info('[FluxLab Webhook] Evento recebido', {
      event: eventType,
      email: lead.email ? '***' : null,
    });

    const userData = {
      email: lead.email || null,
      phone: lead.phone || lead.telefone || null,
      first_name: lead.name || lead.first_name || lead.nome || null,
      last_name: lead.last_name || lead.sobrenome || null,
      external_id: lead.external_id || lead.user_id || null,
      fbc: lead.fbc || null,
      fbp: lead.fbp || null,
      click_id: lead.click_id || lead.fbclid || null,
      ip_address: lead.ip || lead.ip_address || null,
      user_agent: lead.user_agent || lead.ua || null,
      utm_source: lead.utm_source || null,
      utm_medium: lead.utm_medium || null,
      utm_campaign: lead.utm_campaign || null,
      utm_content: lead.utm_content || null,
      utm_term: lead.utm_term || null,
      country: lead.country || lead.pais || 'BR',
      source: 'fluxlab',
    };

    const value = parseFloat(payload.value || lead.value || lead.amount || 0);

    // Mapear evento do FluxLab
    let mappedEvent = eventType.toLowerCase();
    if (mappedEvent === 'lead.created' || mappedEvent === 'new_lead') {
      mappedEvent = 'user.register';
    }

    const result = await eventService.processEvent({
      eventType: mappedEvent,
      source: 'fluxlab',
      payload,
      userData,
      value,
      currency: payload.currency || 'BRL',
    });

    return res.status(200).json({
      received: true,
      processed: true,
      ...result,
    });
  } catch (error) {
    logger.error('[FluxLab Webhook] Erro ao processar', { error: error.message });
    return res.status(200).json({
      received: true,
      processed: false,
      error: error.message,
    });
  }
});

module.exports = router;
