const crypto = require('crypto');
const { query } = require('../config/database');
const { generateEventId, generateDeterministicEventId } = require('../utils/helpers');
const userService = require('./userService');
const metaService = require('./metaService');
const { eventQueue } = require('../config/queue');
const logger = require('../config/logger');

/** URL real da página (CAPI website + event_source_url); webhooks do backoffice raramente trazem isto. */
function extractEventSourceUrlFromPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') return null;
  const d = rawPayload.data ?? rawPayload;
  const t = d.tracking || d.meta || {};
  const candidates = [
    d.event_source_url,
    d.page_url,
    d.pageUrl,
    d.landing_page,
    d.landingPage,
    d.url,
    d.source_url,
    d.sourceUrl,
    d.referrer,
    d.document_location,
    d.documentLocation,
    t.page_url,
    t.pageUrl,
    t.landing_page,
    t.landingPage,
    t.event_source_url,
    t.source_url,
    rawPayload.event_source_url,
  ];
  for (const c of candidates) {
    if (typeof c === 'string') {
      const u = c.trim();
      if (u.startsWith('http')) return u.slice(0, 2048);
    }
  }
  return null;
}

/** Último recurso para dedupe: corpo distinto ⇒ ID distinto (evita colapsar vários depósitos no mesmo minuto). */
function fingerprintWebhookPayload(payload) {
  try {
    return crypto.createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex').slice(0, 40);
  } catch {
    return `t_${Date.now()}`;
  }
}

class EventService {
  /**
   * Mapeia eventos internos para nomes do Meta
   */
  static EVENT_MAP = {
    // Registro
    'user.register': 'CompleteRegistration',
    'register': 'CompleteRegistration',
    'registration': 'CompleteRegistration',
    'signup': 'CompleteRegistration',

    // Início de depósito
    'payment.deposit.started': 'InitiateCheckout',
    'deposit.started': 'InitiateCheckout',
    'deposit_started': 'InitiateCheckout',
    'initiate_checkout': 'InitiateCheckout',

    // Depósito aprovado
    'payment.deposit.completed': 'Purchase',
    'deposit.completed': 'Purchase',
    'deposit_completed': 'Purchase',
    'deposit_approved': 'Purchase',
    'payment_approved': 'Purchase',
    'purchase': 'Purchase',

    // FTD (First Time Deposit) - também mapeia para Purchase
    'ftd': 'Purchase',
    'first_deposit': 'Purchase',

    // Variantes comuns de gateways / Meta System
    deposit: 'Purchase',
    'deposit.success': 'Purchase',
    deposit_success: 'Purchase',
    depositsuccess: 'Purchase',
    'wallet.deposit.completed': 'Purchase',
    'payment.pix.completed': 'Purchase',
    pix_completed: 'Purchase',
    'pix.completed': 'Purchase',
    payment_confirmed: 'Purchase',
  };

  /**
   * Aceita o webhook do cassino se o tipo (exacto ou compacto) existir no EVENT_MAP.
   */
  isCassinoEventAccepted(eventType) {
    const t = String(eventType || '').toLowerCase().trim();
    if (!t) return false;
    if (EventService.EVENT_MAP[t]) return true;
    const compact = t.replace(/[^a-z0-9]/gi, '');
    if (!compact) return false;
    for (const k of Object.keys(EventService.EVENT_MAP)) {
      const kc = k.toLowerCase().replace(/[^a-z0-9]/gi, '');
      if (kc === compact) return true;
    }
    return false;
  }

  /**
   * Processa um evento recebido de qualquer fonte
   * 
   * Fluxo:
   * 1. Registrar webhook raw
   * 2. Identificar tipo do evento
   * 3. Encontrar/criar usuário
   * 4. Verificar deduplicação
   * 5. Registrar evento
   * 6. Enfileirar envio ao Meta
   */
  async processEvent({ eventType, source, payload, userData = {}, value = 0, currency = 'BRL' }) {
    try {
      // 1. Mapear evento para nome do Meta
      const metaEventName = EventService.EVENT_MAP[eventType.toLowerCase()] || eventType;

      logger.info('[EventService] Processando evento', {
        eventType,
        metaEventName,
        source,
        hasEmail: !!userData.email,
        hasFbc: !!userData.fbc,
        value,
      });

      // 2. Encontrar ou criar usuário
      const { user, matchedBy, isNew } = await userService.findOrCreate(userData);

      if (!user) {
        logger.error('[EventService] Não foi possível encontrar/criar usuário', { userData });
        throw new Error('Falha ao encontrar/criar usuário');
      }

      // 3. Gerar event_id para deduplicação (prioriza transactionId / referência do gateway)
      const pData = payload?.data || payload || {};
      const dedupeKey =
        pData.transactionId ||
        pData.transaction_id ||
        pData.depositReference ||
        pData.deposit_reference ||
        pData.pixEndToEndId ||
        pData.pix_end_to_end_id ||
        pData.onzTxid ||
        pData.paymentId ||
        pData.payment_id ||
        pData.orderId ||
        pData.order_id ||
        pData.depositId ||
        pData.deposit_id ||
        pData.invoice_id ||
        pData.invoiceId ||
        payload?.metadata?.requestId ||
        payload?.requestId ||
        fingerprintWebhookPayload(payload);
      const eventId = generateDeterministicEventId(source, eventType, user.id, String(dedupeKey));

      let insertValue = value;
      if (insertValue != null && typeof insertValue === 'object') {
        insertValue = parseFloat(String(insertValue));
      } else {
        insertValue = Number(insertValue);
      }
      if (!Number.isFinite(insertValue)) insertValue = 0;

      let insertCurrency = 'BRL';
      if (currency != null && typeof currency === 'string') {
        insertCurrency = currency.trim().slice(0, 10) || 'BRL';
      } else if (currency != null && typeof currency === 'number') {
        insertCurrency = String(currency).slice(0, 10);
      }

      // 4. Verificar se evento já existe (deduplicação)
      const isDuplicate = await this.checkDuplicate(eventId);
      if (isDuplicate) {
        logger.warn('[EventService] Evento duplicado ignorado', { eventId, eventType, userId: user.id });
        return {
          success: true,
          duplicate: true,
          eventId,
          message: 'Evento duplicado - ignorado',
        };
      }

      // 5. Registrar evento no banco
      const eventRecord = await query(
        `INSERT INTO events (
          event_id, user_id, event_type, event_name, value, currency,
          source, status, raw_payload, matched_by, ip_address, user_agent
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *`,
        [
          eventId, user.id, eventType, metaEventName, insertValue, insertCurrency,
          source, 'queued', JSON.stringify(payload), matchedBy,
          userData.ip_address, userData.user_agent
        ]
      );

      // 6. Enfileirar para envio ao Meta
      await eventQueue.add('send-to-meta', {
        eventId,
        eventType,
        metaEventName,
        value: insertValue,
        currency: insertCurrency,
        userId: user.id,
      }, {
        jobId: eventId, // previne jobs duplicados
        priority: metaEventName === 'Purchase' ? 1 : 2, // Purchase tem prioridade
      });

      logger.info('[EventService] Evento registrado e enfileirado', {
        eventId,
        eventType,
        metaEventName,
        userId: user.id,
        matchedBy,
        value: insertValue,
      });

      return {
        success: true,
        duplicate: false,
        eventId,
        userId: user.id,
        matchedBy,
        metaEventName,
      };
    } catch (error) {
      logger.error('[EventService] Erro ao processar evento', {
        eventType,
        source,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Verifica se evento é duplicado
   */
  async checkDuplicate(eventId) {
    const result = await query(
      'SELECT id FROM events WHERE event_id = $1',
      [eventId]
    );
    return result.rows.length > 0;
  }

  /**
   * Processa job da fila - envia evento ao Meta
   * Chamado pelo worker da fila
   */
  async processQueueJob(job) {
    const { eventId, metaEventName, currency, userId } = job.data;
    let value = job.data.value;
    if (value != null && typeof value === 'object') {
      value = parseFloat(String(value));
    } else {
      value = Number(value);
    }
    if (!Number.isFinite(value)) value = 0;

    logger.info('[EventService] Processando job da fila', {
      jobId: job.id,
      eventId,
      metaEventName,
      attempt: job.attemptsMade + 1,
    });

    // Buscar dados do usuário
    const userResult = await query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];

    if (!user) {
      logger.error('[EventService] Usuário não encontrado para job', { userId, eventId });
      throw new Error(`Usuário ${userId} não encontrado`);
    }

    const eventRow = await query('SELECT raw_payload FROM events WHERE event_id = $1', [eventId]);
    const rawPayload = eventRow.rows[0]?.raw_payload;
    const sourceUrl = extractEventSourceUrlFromPayload(rawPayload);
    const actionSource = sourceUrl ? 'website' : 'other';

    // Enviar para o Meta
    const result = await metaService.sendEvent(
      {
        event_name: metaEventName,
        event_id: eventId,
        value,
        currency: currency || 'BRL',
        action_source: actionSource,
        source_url: sourceUrl || undefined,
      },
      user
    );

    if (result.success) {
      // Atualizar status do evento
      await query(
        `UPDATE events SET
          meta_sent = true,
          meta_sent_at = NOW(),
          meta_response = $2,
          status = 'sent'
        WHERE event_id = $1`,
        [eventId, JSON.stringify(result.response)]
      );

      return result;
    } else {
      // Atualizar status de erro
      await query(
        `UPDATE events SET
          status = 'error',
          meta_response = $2
        WHERE event_id = $1`,
        [eventId, JSON.stringify({ error: result.error, http_status: result.statusCode })]
      );

      // Se é um erro 4xx (exceto 429), não vale retry
      if (result.statusCode && result.statusCode >= 400 && result.statusCode < 500 && result.statusCode !== 429) {
        logger.error('[EventService] Erro permanente, cancelando retries', {
          eventId,
          http_status: result.statusCode,
          error: result.error,
        });
        return result; // Não lança erro = não faz retry
      }

      throw new Error(result.error); // Lança erro = Bull faz retry
    }
  }

  /**
   * Lista eventos com paginação e filtros
   */
  async list({ page = 1, limit = 50, eventType = null, status = null, source = null, startDate = null, endDate = null }) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (eventType) {
      conditions.push(`e.event_type = $${paramIndex++}`);
      params.push(eventType);
    }
    if (status) {
      conditions.push(`e.status = $${paramIndex++}`);
      params.push(status);
    }
    if (source) {
      conditions.push(`e.source = $${paramIndex++}`);
      params.push(source);
    }
    if (startDate) {
      conditions.push(`e.created_at >= $${paramIndex++}`);
      params.push(startDate);
    }
    if (endDate) {
      conditions.push(`e.created_at <= $${paramIndex++}`);
      params.push(endDate);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (page - 1) * limit;

    params.push(limit, offset);

    const [eventsResult, countResult] = await Promise.all([
      query(
        `SELECT e.*, u.email, u.external_id, u.fbc, u.click_id
         FROM events e
         LEFT JOIN users u ON e.user_id = u.id
         ${whereClause}
         ORDER BY e.created_at DESC
         LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
        params
      ),
      query(
        `SELECT COUNT(*) as total FROM events e ${whereClause}`,
        params.slice(0, -2)
      ),
    ]);

    return {
      events: eventsResult.rows,
      total: parseInt(countResult.rows[0].total),
      page,
      limit,
      totalPages: Math.ceil(parseInt(countResult.rows[0].total) / limit),
    };
  }

  /**
   * Estatísticas para o dashboard
   */
  async getStats({ startDate = null, endDate = null } = {}) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (startDate) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(startDate);
    }
    if (endDate) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(endDate);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const [totals, byType, byDay, recentErrors, webhookTotal, webhookBySource] = await Promise.all([
      // Totais gerais
      query(
        `SELECT
          COUNT(*) as total_events,
          COUNT(CASE WHEN meta_sent = true THEN 1 END) as sent_to_meta,
          COUNT(CASE WHEN status = 'error' THEN 1 END) as errors,
          COALESCE(SUM(value), 0) as total_value,
          COUNT(DISTINCT user_id) as unique_users,
          COUNT(CASE WHEN event_name = 'Purchase' THEN 1 END) as total_purchases,
          COALESCE(SUM(CASE WHEN event_name = 'Purchase' THEN value ELSE 0 END), 0) as purchase_value,
          COUNT(CASE WHEN event_name = 'CompleteRegistration' THEN 1 END) as total_registrations,
          COUNT(CASE WHEN event_name = 'InitiateCheckout' THEN 1 END) as total_initiates
        FROM events ${whereClause}`,
        params
      ),

      // Por tipo de evento
      query(
        `SELECT
          event_name, event_type,
          COUNT(*) as total,
          COUNT(CASE WHEN meta_sent = true THEN 1 END) as sent,
          COALESCE(SUM(value), 0) as total_value
        FROM events ${whereClause}
        GROUP BY event_name, event_type
        ORDER BY total DESC`,
        params
      ),

      // Por dia (últimos 30 dias)
      query(
        `SELECT
          DATE(created_at) as date,
          COUNT(*) as total_events,
          COUNT(CASE WHEN event_name = 'Purchase' THEN 1 END) as purchases,
          COUNT(CASE WHEN event_name = 'CompleteRegistration' THEN 1 END) as registrations,
          COALESCE(SUM(CASE WHEN event_name = 'Purchase' THEN value ELSE 0 END), 0) as revenue,
          COUNT(CASE WHEN meta_sent = true THEN 1 END) as sent_to_meta
        FROM events
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at)
        ORDER BY date DESC`
      ),

      // Erros recentes
      query(
        `SELECT e.event_id, e.event_type, e.event_name, e.status,
                e.meta_response, e.created_at, u.email
         FROM events e
         LEFT JOIN users u ON e.user_id = u.id
         WHERE e.status = 'error'
         ORDER BY e.created_at DESC
         LIMIT 10`
      ),
      // Mesmo filtro de datas que em `events`: cada POST ao /webhook/* entra aqui
      query(
        `SELECT COUNT(*)::int AS total FROM webhook_logs ${whereClause}`,
        params
      ),
      query(
        `SELECT source, COUNT(*)::int AS total
         FROM webhook_logs ${whereClause}
         GROUP BY source
         ORDER BY total DESC`,
        params
      ),
    ]);

    return {
      totals: totals.rows[0],
      byType: byType.rows,
      byDay: byDay.rows,
      recentErrors: recentErrors.rows,
      webhooks: {
        total: webhookTotal.rows[0]?.total ?? 0,
        bySource: webhookBySource.rows,
      },
    };
  }

  /**
   * Busca logs detalhados de um evento específico
   */
  async getEventLogs(eventId) {
    const [eventResult, logsResult] = await Promise.all([
      query(
        `SELECT e.*, u.email, u.phone, u.fbc, u.fbp, u.click_id,
                u.ip_address as user_ip, u.user_agent as user_ua
         FROM events e
         LEFT JOIN users u ON e.user_id = u.id
         WHERE e.event_id = $1`,
        [eventId]
      ),
      query(
        `SELECT * FROM event_logs
         WHERE event_id = $1
         ORDER BY created_at ASC`,
        [eventId]
      ),
    ]);

    return {
      event: eventResult.rows[0] || null,
      logs: logsResult.rows,
    };
  }

  /**
   * Reprocessar evento que falhou
   */
  async retryEvent(eventId) {
    const eventResult = await query(
      'SELECT * FROM events WHERE event_id = $1',
      [eventId]
    );

    const event = eventResult.rows[0];
    if (!event) throw new Error('Evento não encontrado');

    // Resetar status
    await query(
      `UPDATE events SET status = 'queued', meta_sent = false WHERE event_id = $1`,
      [eventId]
    );

    // Re-enfileirar
    await eventQueue.add('send-to-meta', {
      eventId: event.event_id,
      eventType: event.event_type,
      metaEventName: event.event_name,
      value: event.value,
      currency: event.currency,
      userId: event.user_id,
    }, {
      jobId: `retry_${eventId}_${Date.now()}`,
      priority: 1,
    });

    logger.info('[EventService] Evento re-enfileirado', { eventId });

    return { success: true, message: 'Evento re-enfileirado para envio' };
  }
}

module.exports = new EventService();
