const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const eventService = require('../services/eventService');
const settingsService = require('../services/settingsService');
const webhookLogger = require('../middleware/webhookLogger');
const { markWebhookLog } = require('../middleware/webhookLogger');
const { normalizeCpf, normalizeEmail, normalizePhone } = require('../utils/helpers');
const logger = require('../config/logger');

// Logar todos os postbacks da plataforma
router.use(webhookLogger('postback'));

const SECRET_CACHE_TTL_MS = 30_000;
let dbSecretCache = { value: '', loadedAt: 0 };

/**
 * Janela usada para deduplicar eventos que a plataforma envia sem identificador
 * (saques e depósitos sem pix_code). Reenvios da plataforma caem na mesma janela;
 * dois eventos legítimos do mesmo usuário com o mesmo valor dentro dela colapsam.
 */
const NO_ID_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Converte valores monetários em número.
 * Aceita 10, "10", "10.50", "10,50" e "1.234,56".
 */
function parseAmount(raw) {
  if (raw == null) return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;

  let s = String(raw).trim().replace(/[^\d.,-]/g, '');
  if (!s) return 0;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // O separador decimal é o que aparece por último ("1.234,56" vs "1,234.56")
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = s.replace(',', '.');
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Separa "name" (nome completo) em first_name / last_name,
 * respeitando o "firstname" quando a plataforma o envia.
 */
function splitName(fullName, firstName) {
  const full = String(fullName || '').trim().replace(/\s+/g, ' ');
  const first = String(firstName || '').trim();

  if (first && full.toLowerCase().startsWith(first.toLowerCase())) {
    const rest = full.slice(first.length).trim();
    return { first_name: first, last_name: rest || null };
  }
  if (first) {
    const parts = full.split(' ');
    return { first_name: first, last_name: parts.length > 1 ? parts.slice(1).join(' ') : null };
  }
  if (!full) return { first_name: null, last_name: null };

  const parts = full.split(' ');
  return {
    first_name: parts[0],
    last_name: parts.length > 1 ? parts.slice(1).join(' ') : null,
  };
}

/** Identidade estável do jogador para compor chaves de deduplicação. */
function identityKey(data) {
  return (
    normalizeCpf(data.cpf) ||
    normalizeEmail(data.email) ||
    normalizePhone(data.phone) ||
    'anon'
  );
}

/** Chave de dedupe com janela de tempo, para eventos sem identificador próprio. */
function windowedKey(...parts) {
  const bucket = Math.floor(Date.now() / NO_ID_DEDUPE_WINDOW_MS);
  return `${parts.filter(Boolean).join(':')}:w${bucket}`;
}

/** pix_code é longo demais para virar chave: usa o hash. */
function pixKey(pixCode) {
  const s = String(pixCode || '').trim();
  if (!s) return null;
  return `pix:${crypto.createHash('sha1').update(s).digest('hex')}`;
}

async function resolveSecretFromDb() {
  const now = Date.now();
  if (now - dbSecretCache.loadedAt < SECRET_CACHE_TTL_MS) return dbSecretCache.value;
  const value = String((await settingsService.get('webhook_secret_postback')) || '').trim();
  dbSecretCache = { value, loadedAt: now };
  return value;
}

/**
 * Autenticação opcional. Se não houver secret configurado (env ou settings),
 * os endpoints ficam abertos — muitas plataformas só permitem configurar a URL.
 * Com secret configurado, aceita header, Bearer ou query string (?secret= / ?token=),
 * porque a maioria dos painéis de postback não permite enviar headers customizados.
 */
async function verifyPostbackSecret(req, res, next) {
  try {
    const envSecret = process.env.WEBHOOK_SECRET_POSTBACK?.trim();
    const secret = envSecret || (await resolveSecretFromDb());
    if (!secret) return next();

    const header = req.get('x-webhook-secret') || req.get('x-postback-secret');
    const bearer = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const fromQuery = String(req.query.secret || req.query.token || '').trim();

    const provided = [header, bearer, fromQuery].filter(Boolean);
    const expected = Buffer.from(secret, 'utf8');
    const isValid = provided.some((candidate) => {
      const buf = Buffer.from(candidate, 'utf8');
      return buf.length === expected.length && crypto.timingSafeEqual(buf, expected);
    });
    if (isValid) return next();

    logger.warn('[Postback] Secret inválido ou ausente', {
      endpoint: req.originalUrl.split('?')[0],
      ip: req.ip,
    });
    await markWebhookLog(req.webhookLogId, false, '401 Unauthorized — secret inválido');
    return res.status(401).json({
      error: 'Unauthorized',
      hint: 'Envie o secret em X-Webhook-Secret, Authorization: Bearer <secret> ou ?secret=<secret> na URL.',
    });
  } catch (error) {
    logger.error('[Postback] Erro ao validar secret', { error: error.message });
    return res.status(500).json({ error: 'internal_error' });
  }
}

/**
 * Monta os dados do usuário a partir do payload plano da plataforma.
 *
 * O IP da requisição NÃO é usado como ip_address: quem chama é o servidor da
 * plataforma, não o navegador do jogador — enviar esse IP à CAPI degradaria o
 * matching. Só usamos IP/user agent se vierem explicitamente no payload.
 */
function buildUserData(body) {
  const { first_name, last_name } = splitName(body.name, body.firstname);

  return {
    email: body.email || null,
    phone: body.phone || null,
    first_name,
    last_name,
    cpf: body.cpf || null,
    gender: body.gender || null,
    birthday: body.birthday || null,
    external_id: body.user_id || body.userId || body.external_id || null,
    // Campos de tracking: só existem se a plataforma for configurada para enviá-los
    fbc: body.fbc || null,
    fbp: body.fbp || null,
    click_id: body.click_id || body.fbclid || null,
    ip_address: body.ip || body.ip_address || null,
    user_agent: body.user_agent || null,
    utm_source: body.utm_source || null,
    utm_medium: body.utm_medium || null,
    utm_campaign: body.utm_campaign || null,
    utm_content: body.utm_content || null,
    utm_term: body.utm_term || null,
    country: body.country || 'BR',
    source: 'postback',
  };
}

/**
 * Cria o handler de um endpoint de postback.
 *
 * @param {string} eventType   Tipo interno (mapeado para o nome Meta em EVENT_MAP)
 * @param {string} label       Nome do evento na documentação da plataforma
 * @param {object} options     { withValue, dedupeKey(body) }
 */
function makeHandler(eventType, label, { withValue = false, dedupeKey } = {}) {
  return async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};

      // Sem nenhum identificador não há como correlacionar o jogador
      if (!body.email && !body.phone && !body.cpf) {
        logger.warn('[Postback] Payload sem identificador', { label });
        await markWebhookLog(req.webhookLogId, false, 'Payload sem email, phone ou cpf');
        return res.status(200).json({
          received: true,
          processed: false,
          reason: 'missing_identifier',
          hint: 'O payload precisa de pelo menos um entre email, phone e cpf.',
        });
      }

      const userData = buildUserData(body);
      const value = withValue ? parseAmount(body.value) : 0;

      logger.info('[Postback] Processando', {
        label,
        eventType,
        hasEmail: Boolean(body.email),
        hasCpf: Boolean(body.cpf),
        hasPixCode: Boolean(body.pix_code),
        value,
      });

      const result = await eventService.processEvent({
        eventType,
        source: 'postback',
        payload: body,
        userData,
        value,
        currency: body.currency || 'BRL',
        dedupeKey: dedupeKey ? dedupeKey(body) : null,
      });

      await markWebhookLog(req.webhookLogId, true, null);
      return res.status(200).json({ received: true, processed: true, event: label, ...result });
    } catch (error) {
      logger.error('[Postback] Erro ao processar', { label, error: error.message });
      await markWebhookLog(req.webhookLogId, false, error.message);
      // 200 evita que a plataforma entre em loop de retry por erro nosso
      return res.status(200).json({ received: true, processed: false, error: error.message });
    }
  };
}

// =============================================
// ENDPOINTS
// Um por evento — a plataforma envia payloads planos, sem campo de tipo,
// então o evento é identificado pela URL configurada no painel.
// =============================================

const ENDPOINTS = [
  {
    paths: ['/cadastro', '/registro', '/register'],
    eventType: 'user.register',
    label: 'Cadastro de Usuários',
    metaEvent: 'CompleteRegistration',
    options: {
      // O cadastro acontece uma vez por jogador: a própria identidade é a chave
      dedupeKey: (b) => `register:${identityKey(b)}`,
    },
  },
  {
    paths: ['/deposito-gerado', '/deposit-created'],
    eventType: 'payment.deposit.started',
    label: 'Depósito Gerado',
    metaEvent: 'InitiateCheckout',
    options: {
      withValue: true,
      dedupeKey: (b) => pixKey(b.pix_code) || windowedKey('dep-started', identityKey(b), parseAmount(b.value)),
    },
  },
  {
    paths: ['/primeiro-deposito-pago', '/first-deposit', '/ftd'],
    eventType: 'payment.deposit.first',
    label: 'Primeiro Depósito Pago',
    metaEvent: 'FirstDeposit (custom, sem value)',
    options: {
      withValue: true,
      dedupeKey: (b) => pixKey(b.pix_code) || windowedKey('ftd', identityKey(b), parseAmount(b.value)),
    },
  },
  {
    paths: ['/deposito-pago', '/deposit-paid'],
    eventType: 'payment.deposit.completed',
    label: 'Depósito Pago',
    metaEvent: 'Purchase',
    options: {
      withValue: true,
      dedupeKey: (b) => pixKey(b.pix_code) || windowedKey('dep-paid', identityKey(b), parseAmount(b.value)),
    },
  },
  {
    paths: ['/saque-solicitado', '/withdrawal-requested'],
    eventType: 'payment.withdrawal.requested',
    label: 'Saque Solicitado',
    metaEvent: 'WithdrawalRequested (custom)',
    options: {
      withValue: true,
      // Saques não trazem identificador — dedupe por janela de tempo
      dedupeKey: (b) => windowedKey('wd-req', identityKey(b), parseAmount(b.value)),
    },
  },
  {
    paths: ['/saque-pago', '/withdrawal-paid'],
    eventType: 'payment.withdrawal.paid',
    label: 'Saque Pago',
    metaEvent: 'WithdrawalPaid (custom)',
    options: {
      withValue: true,
      dedupeKey: (b) => windowedKey('wd-paid', identityKey(b), parseAmount(b.value)),
    },
  },
];

for (const { paths, eventType, label, options } of ENDPOINTS) {
  const handler = makeHandler(eventType, label, options);
  for (const path of paths) {
    router.post(path, verifyPostbackSecret, handler);
  }
}

/** Lista as URLs a configurar no painel da plataforma. */
router.get('/', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}/postback`;
  res.json({
    service: 'Bearbet Tracker — postbacks da plataforma',
    secretRequired: Boolean(
      process.env.WEBHOOK_SECRET_POSTBACK?.trim() || dbSecretCache.value,
    ),
    endpoints: ENDPOINTS.map((e) => ({
      evento: e.label,
      url: `${base}${e.paths[0]}`,
      aliases: e.paths.slice(1).map((p) => `${base}${p}`),
      meta: e.metaEvent,
      eventType: e.eventType,
    })),
  });
});

// URL errada no painel da plataforma é a falha mais comum: responder JSON com as válidas
router.all('*', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}/postback`;
  logger.warn('[Postback] Endpoint inexistente', { path: req.originalUrl.split('?')[0] });
  res.status(404).json({
    error: 'Endpoint de postback não encontrado',
    endpoints: ENDPOINTS.map((e) => `${base}${e.paths[0]} — ${e.label}`),
  });
});

function invalidatePostbackSecretCache() {
  dbSecretCache = { value: '', loadedAt: 0 };
}
router.invalidatePostbackSecretCache = invalidatePostbackSecretCache;

module.exports = router;
