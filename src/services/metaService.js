const axios = require('axios');
const { query } = require('../config/database');
const { hashSHA256, unixTimestamp } = require('../utils/helpers');
const logger = require('../config/logger');

function normalizeCurrency(currency) {
  const s = String(currency || 'BRL')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  return s.length >= 3 ? s.slice(0, 3) : 'BRL';
}

/** Resposta Graph / CAPI em texto útil para logs e coluna meta_response */
/** Chaves permitidas na CAPI — a Meta devolve 400 se aparecerem campos extra (ex.: statusCode) em user_data/custom_data. */
const ALLOWED_SERVER_EVENT_KEYS = new Set([
  'event_name',
  'event_time',
  'event_id',
  'event_source_url',
  'action_source',
  'user_data',
  'custom_data',
  'opt_out',
]);

const ALLOWED_USER_DATA_KEYS = new Set([
  'em',
  'ph',
  'fn',
  'ln',
  'ge',
  'db',
  'ct',
  'st',
  'zp',
  'country',
  'external_id',
  'client_ip_address',
  'client_user_agent',
  'fbc',
  'fbp',
  'subscription_id',
  'lead_id',
  'madid',
  'anon_id',
  'partner_id',
  'dobd',
  'dobm',
  'doby',
]);

const ALLOWED_CUSTOM_DATA_KEYS = new Set([
  'value',
  'currency',
  'content_name',
  'content_category',
  'content_ids',
  'contents',
  'content_type',
  'order_id',
  'predicted_ltv',
  'num_items',
  'status',
  'search_string',
  'item_number',
  'delivery_category',
  'shipping_contact',
]);

function formatGraphApiError(error) {
  const d = error.response?.data;
  if (!d) return error.message;
  if (typeof d === 'string') return d;
  if (d.error && typeof d.error === 'object') {
    const e = d.error;
    const parts = [
      e.message,
      e.error_user_msg,
      e.error_user_title,
      e.type && `type=${e.type}`,
      e.code != null && `code=${e.code}`,
      e.error_subcode != null && `subcode=${e.error_subcode}`,
      e.fbtrace_id && `fbtrace_id=${e.fbtrace_id}`,
    ].filter(Boolean);
    if (parts.length) return parts.join(' | ');
  }
  if (typeof d.error === 'string') return d.error;
  try {
    return JSON.stringify(d);
  } catch {
    return error.message;
  }
}

class MetaService {
  constructor() {
    this.baseUrl = 'https://graph.facebook.com';
  }

  /**
   * Busca configurações do Meta do banco de dados
   */
  async getConfig() {
    const result = await query(
      `SELECT key, value FROM settings WHERE key IN (
        'meta_pixel_id', 'meta_access_token', 'meta_api_version', 'meta_test_event_code', 'debug_mode'
      )`
    );
    const config = {};
    for (const row of result.rows) {
      const v = row.value;
      config[row.key] = typeof v === 'string' ? v.trim() : v;
    }
    return config;
  }

  /**
   * Apenas campos aceites na CAPI (evita chaves extra vindas do SELECT * em users).
   */
  pickUserDataForCapI(row) {
    if (!row || typeof row !== 'object') return {};
    return {
      email: row.email,
      email_hash: row.email_hash,
      phone: row.phone,
      phone_hash: row.phone_hash,
      first_name: row.first_name,
      last_name: row.last_name,
      country: row.country,
      fbc: row.fbc,
      fbp: row.fbp,
      ip_address: row.ip_address,
      user_agent: row.user_agent,
      external_id: row.external_id,
    };
  }

  /**
   * Monta o payload do evento no formato exigido pela Meta CAPI
   * 
   * Documentação: https://developers.facebook.com/docs/marketing-api/conversions-api/parameters
   */
  buildEventPayload(eventData, userData) {
    const {
      event_name, event_id, value, currency, source_url, action_source
    } = eventData;

    const u = this.pickUserDataForCapI(userData);

    // User data - Meta exige hash SHA-256 para PII
    const user_data = {};

    // Email (hashado)
    if (u.email_hash) {
      user_data.em = [u.email_hash];
    } else if (u.email) {
      user_data.em = [hashSHA256(u.email.toLowerCase().trim())];
    }

    // Telefone (hashado)
    if (u.phone_hash) {
      user_data.ph = [u.phone_hash];
    } else if (u.phone) {
      user_data.ph = [hashSHA256(u.phone)];
    }

    // Nome (hashado)
    if (u.first_name) {
      user_data.fn = [hashSHA256(u.first_name.toLowerCase().trim())];
    }
    if (u.last_name) {
      user_data.ln = [hashSHA256(u.last_name.toLowerCase().trim())];
    }

    // País
    if (u.country) {
      user_data.country = [hashSHA256(u.country.toLowerCase())];
    }

    // Facebook Click ID (NÃO hashear)
    if (u.fbc) {
      user_data.fbc = u.fbc;
    }

    // Facebook Browser ID (NÃO hashear)
    if (u.fbp) {
      user_data.fbp = u.fbp;
    }

    // IP e User Agent (NÃO hashear)
    if (u.ip_address) {
      user_data.client_ip_address = u.ip_address;
    }
    if (u.user_agent) {
      user_data.client_user_agent = u.user_agent;
    }

    // External ID (hashado)
    if (u.external_id) {
      user_data.external_id = [hashSHA256(String(u.external_id))];
    }

    // Website na CAPI exige event_source_url; webhooks do cassino raramente têm URL → usar "other".
    let resolvedAction = action_source || 'other';
    if (resolvedAction === 'website' && !source_url) {
      logger.warn('[MetaService] action_source website sem event_source_url — a usar other', {
        event_name,
        event_id,
      });
      resolvedAction = 'other';
    }

    // Montar evento
    const event = {
      event_name: event_name,
      event_time: unixTimestamp(),
      event_id: event_id,
      action_source: resolvedAction,
      user_data: user_data,
    };

    const numVal = value != null && value !== '' ? Number(value) : NaN;
    const hasFiniteValue = Number.isFinite(numVal);
    const commerceEvents = ['Purchase', 'InitiateCheckout'];
    const needsCurrency = commerceEvents.includes(event_name);

    // Valor 0 não entra em custom_data (evita lixo em CompleteRegistration); Purchase/Checkout mantêm moeda.
    const includeValueKey = hasFiniteValue && numVal !== 0;
    if (includeValueKey || currency || needsCurrency) {
      event.custom_data = {};
      if (includeValueKey) event.custom_data.value = numVal;
      if (needsCurrency || currency) {
        event.custom_data.currency = normalizeCurrency(currency);
      }
    }

    // URL de origem
    if (source_url) {
      event.event_source_url = source_url;
    }

    return this.sanitizeServerEventForCapI(event);
  }

  /**
   * Remove chaves não documentadas na CAPI (evita 400 "Invalid parameter '…'").
   */
  sanitizeServerEventForCapI(ev) {
    if (!ev || typeof ev !== 'object') return {};
    const out = {};
    for (const k of Object.keys(ev)) {
      if (!ALLOWED_SERVER_EVENT_KEYS.has(k)) continue;
      if (k === 'user_data' && ev.user_data && typeof ev.user_data === 'object') {
        const ud = {};
        for (const uk of Object.keys(ev.user_data)) {
          if (!ALLOWED_USER_DATA_KEYS.has(uk)) continue;
          const v = ev.user_data[uk];
          if (v !== undefined && v !== null) ud[uk] = v;
        }
        out.user_data = ud;
      } else if (k === 'custom_data' && ev.custom_data && typeof ev.custom_data === 'object') {
        const cd = {};
        for (const ck of Object.keys(ev.custom_data)) {
          if (!ALLOWED_CUSTOM_DATA_KEYS.has(ck)) continue;
          let v = ev.custom_data[ck];
          if (ck === 'value' && typeof v !== 'number') {
            const n = Number(v);
            v = Number.isFinite(n) ? n : undefined;
          }
          if (v !== undefined && v !== null) cd[ck] = v;
        }
        if (Object.keys(cd).length > 0) out.custom_data = cd;
      } else if (ev[k] !== undefined && ev[k] !== null) {
        out[k] = ev[k];
      }
    }
    return out;
  }

  /**
   * Envia evento para a Meta CAPI
   * 
   * Retorna: { success, response, error }
   */
  async sendEvent(eventData, userData) {
    const startTime = Date.now();
    const config = await this.getConfig();

    if (!config.meta_pixel_id || !config.meta_access_token) {
      logger.error('[MetaService] Pixel ID ou Access Token não configurado');
      return {
        success: false,
        error: 'Meta CAPI não configurada (falta pixel_id ou access_token)',
      };
    }

    const apiVersion = config.meta_api_version || 'v19.0';
    const url = `${this.baseUrl}/${apiVersion}/${config.meta_pixel_id}/events`;

    const capiUser = this.pickUserDataForCapI(userData);
    const eventPayload = this.buildEventPayload(eventData, capiUser);

    const requestBody = {
      data: [eventPayload],
      access_token: config.meta_access_token,
    };

    // Se tem código de teste, incluir
    if (config.meta_test_event_code) {
      requestBody.test_event_code = config.meta_test_event_code;
    }

    try {
      logger.info('[MetaService] Enviando evento', {
        event_name: eventData.event_name,
        event_id: eventData.event_id,
        action_source: eventPayload.action_source,
        hasEventSourceUrl: Boolean(eventPayload.event_source_url),
        hasEmail: !!capiUser.email_hash || !!capiUser.email,
        hasFbc: !!capiUser.fbc,
        hasFbp: !!capiUser.fbp,
        hasIp: !!capiUser.ip_address,
      });

      const response = await axios.post(url, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000, // 30 segundos
      });

      const duration = Date.now() - startTime;

      // Registrar log de sucesso
      await this.logEventSend(eventData.event_id, 'send_success', 'success', requestBody, response.data, null, duration);

      logger.info('[MetaService] Evento enviado com sucesso', {
        event_name: eventData.event_name,
        event_id: eventData.event_id,
        events_received: response.data?.events_received,
        duration: `${duration}ms`,
      });

      return {
        success: true,
        response: response.data,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = formatGraphApiError(error);
      const errorData = error.response?.data || null;

      // Registrar log de erro
      await this.logEventSend(
        eventData.event_id, 'send_error', 'error',
        requestBody, errorData, errorMessage, duration
      );

      logger.error('[MetaService] Erro ao enviar evento', {
        event_name: eventData.event_name,
        event_id: eventData.event_id,
        error: errorMessage,
        status: error.response?.status,
        responseBody: errorData,
        duration: `${duration}ms`,
      });

      return {
        success: false,
        error: errorMessage,
        statusCode: error.response?.status,
        response: errorData,
        duration,
      };
    }
  }

  /**
   * Registra log de tentativa de envio ao Meta
   */
  async logEventSend(eventId, action, status, requestPayload, responsePayload, errorMessage, duration) {
    try {
      // Sanitizar o payload de request (remover access_token)
      const sanitizedRequest = { ...requestPayload };
      if (sanitizedRequest.access_token) {
        sanitizedRequest.access_token = '***REDACTED***';
      }

      await query(
        `INSERT INTO event_logs (event_id, action, status, request_payload, response_payload, error_message, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [eventId, action, status, JSON.stringify(sanitizedRequest), JSON.stringify(responsePayload), errorMessage, duration]
      );
    } catch (error) {
      logger.error('[MetaService] Erro ao registrar log', { error: error.message });
    }
  }

  /**
   * Testa conexão com a Meta CAPI
   */
  async testConnection() {
    const config = await this.getConfig();
    if (!config.meta_pixel_id || !config.meta_access_token) {
      return { success: false, error: 'Configuração incompleta' };
    }

    try {
      const apiVersion = config.meta_api_version || 'v19.0';
      const url = `${this.baseUrl}/${apiVersion}/${config.meta_pixel_id}`;
      const response = await axios.get(url, {
        params: { access_token: config.meta_access_token },
        timeout: 10000,
      });

      return {
        success: true,
        pixelName: response.data?.name,
        pixelId: response.data?.id,
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message,
      };
    }
  }
}

module.exports = new MetaService();
