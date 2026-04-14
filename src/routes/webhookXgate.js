const express = require('express');
const router = express.Router();
const eventService = require('../services/eventService');
const webhookLogger = require('../middleware/webhookLogger');
const logger = require('../config/logger');

// Logar todos os webhooks da XGate
router.use(webhookLogger('xgate'));

/**
 * POST /webhook/xgate
 * 
 * Recebe webhooks da processadora de pagamento XGate.
 * Evento principal: pagamento aprovado (PIX)
 * 
 * Payload esperado (adaptar conforme documentação real da XGate):
 * {
 *   "event": "payment_approved",
 *   "data": {
 *     "transaction_id": "...",
 *     "amount": 100.00,
 *     "currency": "BRL",
 *     "customer": {
 *       "email": "...",
 *       "name": "...",
 *       "phone": "...",
 *       "document": "..."
 *     },
 *     "metadata": {
 *       "external_id": "...",
 *       "utm_source": "...",
 *       "fbc": "...",
 *       "fbp": "..."
 *     }
 *   }
 * }
 */
router.post('/', async (req, res) => {
  const mark = require('../middleware/webhookLogger').markWebhookLog;
  try {
    const payload = req.body;

    logger.info('[XGate Webhook] Evento recebido', {
      event: payload.event || payload.type || payload.status || 'unknown',
      transactionId: payload.data?.transaction_id || payload.transaction_id || 'N/A',
    });

    // Identificar tipo de evento
    const eventType = identifyEventType(payload);

    if (!eventType) {
      logger.info('[XGate Webhook] Evento ignorado (não relevante)', {
        event: payload.event || payload.type || payload.status,
      });
      await mark(req.webhookLogId, false, 'Ignorado: evento não relevante');
      return res.status(200).json({ received: true, processed: false, reason: 'event_not_relevant' });
    }

    // Extrair dados do usuário do payload
    const userData = extractUserData(payload);

    // Extrair valor
    const value = extractValue(payload);

    // Processar evento
    const result = await eventService.processEvent({
      eventType,
      source: 'xgate',
      payload,
      userData,
      value,
      currency: payload.data?.currency || payload.currency || 'BRL',
    });

    await mark(req.webhookLogId, true, null);
    return res.status(200).json({
      received: true,
      processed: true,
      ...result,
    });
  } catch (error) {
    logger.error('[XGate Webhook] Erro ao processar', { error: error.message });
    await mark(req.webhookLogId, false, error.message);
    // Retorna 200 para a XGate não ficar reenviando em caso de erro nosso
    return res.status(200).json({
      received: true,
      processed: false,
      error: error.message,
    });
  }
});

/**
 * Identifica o tipo de evento baseado no payload da XGate
 * Adapte as condições conforme a documentação real
 */
function identifyEventType(payload) {
  const event = (
    payload.event ||
    payload.type ||
    payload.status ||
    payload.action ||
    ''
  ).toLowerCase();

  // Pagamento aprovado
  if (
    event.includes('approved') ||
    event.includes('completed') ||
    event.includes('paid') ||
    event.includes('confirmed') ||
    event === 'payment_approved' ||
    event === 'payment.approved' ||
    event === 'deposit.completed' ||
    event === 'payment.deposit.completed'
  ) {
    return 'payment.deposit.completed';
  }

  // Pagamento iniciado
  if (
    event.includes('started') ||
    event.includes('pending') ||
    event.includes('initiated') ||
    event.includes('created') ||
    event === 'payment.deposit.started'
  ) {
    return 'payment.deposit.started';
  }

  return null; // Evento não relevante (ex: estorno, rejeição)
}

/**
 * Extrai dados do usuário do payload da XGate
 */
function extractUserData(payload) {
  const data = payload.data || payload;
  const customer = data.customer || data.user || data.payer || data;
  const metadata = data.metadata || data.tracking || data.meta || {};

  return {
    email: customer.email || metadata.email || null,
    phone: customer.phone || customer.mobile || metadata.phone || null,
    first_name: extractFirstName(customer.name || customer.full_name),
    last_name: extractLastName(customer.name || customer.full_name),
    external_id: data.external_id || data.user_id || data.customer_id || metadata.external_id || null,
    fbc: metadata.fbc || customer.fbc || null,
    fbp: metadata.fbp || customer.fbp || null,
    click_id: metadata.click_id || metadata.fbclid || null,
    ip_address: metadata.ip || metadata.ip_address || req_ip(payload),
    user_agent: metadata.user_agent || metadata.ua || null,
    utm_source: metadata.utm_source || null,
    utm_medium: metadata.utm_medium || null,
    utm_campaign: metadata.utm_campaign || null,
    utm_content: metadata.utm_content || null,
    utm_term: metadata.utm_term || null,
    country: customer.country || 'BR',
    source: 'xgate',
  };
}

/**
 * Extrai valor do pagamento
 */
function extractValue(payload) {
  const data = payload.data || payload;
  return parseFloat(data.amount || data.value || data.total || 0);
}

function extractFirstName(fullName) {
  if (!fullName) return null;
  return fullName.split(' ')[0];
}

function extractLastName(fullName) {
  if (!fullName) return null;
  const parts = fullName.split(' ');
  return parts.length > 1 ? parts.slice(1).join(' ') : null;
}

function req_ip(payload) {
  return payload._request_ip || null;
}

module.exports = router;
