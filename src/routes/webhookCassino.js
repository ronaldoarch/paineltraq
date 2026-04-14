const crypto = require('crypto');
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

/** Valor monetário do depósito (vários formatos Meta System / gateways). */
function extractDepositAmount(data) {
  if (!data || typeof data !== 'object') return 0;
  const candidates = [
    data.amount,
    data.value,
    data.deposit_amount,
    data.total,
    data.totalAmount,
    data.total_amount,
    data.paidAmount,
    data.paid_amount,
    data.money,
    data.amountPaid,
    data.price,
    data.netAmount,
    data.net_amount,
    data.transaction?.amount,
    data.payment?.amount,
    data.deposit?.amount,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string') {
      const normalized = c.replace(/\s/g, '').replace(',', '.');
      const n = parseFloat(normalized);
      if (Number.isFinite(n)) return n;
    }
    if (typeof c === 'object' && c.amount != null) {
      const n = parseFloat(String(c.amount).replace(/\s/g, '').replace(',', '.'));
      if (Number.isFinite(n)) return n;
    }
  }
  const cents = data.amountCents ?? data.amount_cent ?? data.valueInCents ?? data.value_cent;
  if (cents != null) {
    const n = Number(cents);
    if (Number.isFinite(n)) return n / 100;
  }
  return 0;
}

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
 * Meta System: HMAC-SHA256 do corpo em X-Webhook-Signature (formato sha256=hex).
 * Legado: mesmo secret em X-Webhook-Secret ou Authorization Bearer.
 */
function verifyMetaSystemSignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader || !rawBody || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    return false;
  }
  const sig = String(signatureHeader).trim();
  const lower = sig.toLowerCase();
  if (!lower.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(sig.trim().toLowerCase(), 'utf8');
  const b = Buffer.from(expected.toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function verifyCassinoWebhookSecret(req, res, next) {
  const mark = require('../middleware/webhookLogger').markWebhookLog;
  try {
    const envSecret = process.env.WEBHOOK_SECRET_CASSINO?.trim();
    const dbSecret = envSecret ? '' : await resolveCassinoSecretFromDb();
    const secret = envSecret || dbSecret;
    if (!secret) return next();

    const sigHeader = req.get('x-webhook-signature');
    const rawBody = req.rawBody;
    if (sigHeader && verifyMetaSystemSignature(secret, rawBody, sigHeader)) {
      return next();
    }

    const header =
      req.get('x-webhook-secret') ||
      req.get('x-cassino-webhook-secret') ||
      req.get('x-webhook-token');
    const auth = req.get('authorization');
    const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if ((header && header === secret) || (bearer && bearer === secret)) {
      return next();
    }

    logger.warn('[Cassino Webhook] Autenticação inválida ou ausente', {
      userAgent: (req.get('user-agent') || '').slice(0, 120),
      ip: req.ip,
      hasSignatureHeader: Boolean(sigHeader),
      hasRawBody: Boolean(rawBody && rawBody.length),
    });
    await mark(req.webhookLogId, false, '401 Unauthorized — X-Webhook-Signature ou secret inválido');
    return res.status(401).json({
      error: 'Unauthorized',
      hint:
        'Use a mesma chave secreta no Bearbet e no Meta System. O Meta System envia HMAC no header X-Webhook-Signature (sha256=… do corpo bruto). Alternativa legada: X-Webhook-Secret ou Bearer com o valor em claro. Documentação: verifique se o proxy não altera o corpo JSON.',
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
 * Meta System — exemplos:
 * - user.register: data.userId, fullName, tracking (fbc, utmSource / utm_source, …)
 * - payment.deposit.completed: data.amount, currency, transactionId, tracking.ga_client_id, ip_address, …
 */
router.post('/', verifyCassinoWebhookSecret, async (req, res) => {
  const mark = require('../middleware/webhookLogger').markWebhookLog;
  try {
    const payload = req.body;
    const eventType = payload.event || payload.type || '';
    const requestId = payload.metadata?.requestId || payload.requestId;
    const rawUid = payload.data?.user_id || payload.data?.userId;
    const hasUserSignal = Boolean(
      rawUid ||
        payload.data?.email ||
        payload.data?.phone ||
        payload.data?.transactionId,
    );

    if (!eventService.isCassinoEventAccepted(eventType)) {
      logger.info('[Cassino Webhook] Evento ignorado', { event: eventType });
      await mark(req.webhookLogId, false, 'Ignorado: tipo de evento não mapeado para CAPI');
      return res.status(200).json({ received: true, processed: false, reason: 'event_not_relevant' });
    }

    // Ping de teste do Meta System (sem utilizador/transação real) — não enviar à CAPI
    const isTestPing =
      payload.data?.test === true ||
      (payload.metadata?.isTest === true && !hasUserSignal);
    if (isTestPing) {
      logger.info('[Cassino Webhook] Ignorado (webhook de teste Meta System)', {
        event: eventType,
        requestId: requestId || undefined,
        hint: 'Com dados reais (email/userId/transactionId) o evento é processado mesmo com isTest.',
      });
      await mark(req.webhookLogId, true, null);
      return res.status(200).json({
        received: true,
        processed: true,
        skipped: true,
        reason: 'meta_system_test_webhook',
      });
    }

    logger.info('[Cassino Webhook] A processar', {
      event: eventType,
      requestId: requestId || undefined,
      userId: rawUid || undefined,
      hasEmail: Boolean(payload.data?.email),
    });

    // Extrair dados (snake_case legado + camelCase Meta System; depósito inclui transactionId, amount, tracking.*)
    const data = payload.data || payload;
    const tracking = data.tracking || data.meta || {};
    const fullName = data.fullName || data.name || null;
    const nameParts = fullName ? String(fullName).trim().split(/\s+/) : [];

    const userData = {
      email: data.email || data.player_email || null,
      phone: data.phone || data.mobile || data.player_phone || null,
      first_name: data.first_name || nameParts[0] || data.name?.split(' ')[0] || null,
      last_name:
        data.last_name || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : null) ||
        data.name?.split(' ').slice(1).join(' ') ||
        null,
      external_id:
        data.user_id || data.userId || data.external_id || data.player_id || data.id || null,
      fbc: tracking.fbc || data.fbc || null,
      fbp: tracking.fbp || data.fbp || null,
      click_id:
        tracking.click_id ||
        tracking.fbclid ||
        tracking.gclid ||
        tracking.ga_client_id ||
        tracking.gaClientId ||
        tracking.msclkid ||
        tracking.ttclid ||
        tracking.dclid ||
        data.click_id ||
        null,
      ip_address:
        tracking.ip ||
        tracking.ipAddress ||
        tracking.ip_address ||
        data.ip ||
        data.ip_address ||
        null,
      user_agent: tracking.user_agent || tracking.userAgent || data.user_agent || null,
      utm_source: tracking.utm_source || tracking.utmSource || data.utm_source || null,
      utm_medium: tracking.utm_medium || tracking.utmMedium || data.utm_medium || null,
      utm_campaign: tracking.utm_campaign || tracking.utmCampaign || data.utm_campaign || null,
      utm_content: tracking.utm_content || tracking.utmContent || data.utm_content || null,
      utm_term: tracking.utm_term || tracking.utmTerm || data.utm_term || null,
      country: data.country || 'BR',
      source: 'cassino',
    };

    const value = extractDepositAmount(data);

    const result = await eventService.processEvent({
      eventType: eventType.toLowerCase(),
      source: 'cassino',
      payload,
      userData,
      value,
      currency: data.currency || 'BRL',
    });

    await mark(req.webhookLogId, true, null);
    logger.info('[Cassino Webhook] Processado', {
      event: eventType,
      requestId: requestId || undefined,
      eventId: result.eventId,
      duplicate: result.duplicate || false,
    });
    return res.status(200).json({
      received: true,
      processed: true,
      ...result,
    });
  } catch (error) {
    logger.error('[Cassino Webhook] Erro ao processar', { error: error.message });
    await mark(req.webhookLogId, false, error.message);
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
