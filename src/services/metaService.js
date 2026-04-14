const axios = require('axios');
const { query } = require('../config/database');
const { hashSHA256, unixTimestamp } = require('../utils/helpers');
const logger = require('../config/logger');

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
      config[row.key] = row.value;
    }
    return config;
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

    // User data - Meta exige hash SHA-256 para PII
    const user_data = {};

    // Email (hashado)
    if (userData.email_hash) {
      user_data.em = [userData.email_hash];
    } else if (userData.email) {
      user_data.em = [hashSHA256(userData.email.toLowerCase().trim())];
    }

    // Telefone (hashado)
    if (userData.phone_hash) {
      user_data.ph = [userData.phone_hash];
    } else if (userData.phone) {
      user_data.ph = [hashSHA256(userData.phone)];
    }

    // Nome (hashado)
    if (userData.first_name) {
      user_data.fn = [hashSHA256(userData.first_name.toLowerCase().trim())];
    }
    if (userData.last_name) {
      user_data.ln = [hashSHA256(userData.last_name.toLowerCase().trim())];
    }

    // País
    if (userData.country) {
      user_data.country = [hashSHA256(userData.country.toLowerCase())];
    }

    // Facebook Click ID (NÃO hashear)
    if (userData.fbc) {
      user_data.fbc = userData.fbc;
    }

    // Facebook Browser ID (NÃO hashear)
    if (userData.fbp) {
      user_data.fbp = userData.fbp;
    }

    // IP e User Agent (NÃO hashear)
    if (userData.ip_address) {
      user_data.client_ip_address = userData.ip_address;
    }
    if (userData.user_agent) {
      user_data.client_user_agent = userData.user_agent;
    }

    // External ID (hashado)
    if (userData.external_id) {
      user_data.external_id = [hashSHA256(String(userData.external_id))];
    }

    // Montar evento
    const event = {
      event_name: event_name,
      event_time: unixTimestamp(),
      event_id: event_id,
      action_source: action_source || 'website',
      user_data: user_data,
    };

    // Custom data (valor do depósito, etc)
    if (value || currency) {
      event.custom_data = {};
      if (value) event.custom_data.value = parseFloat(value);
      if (currency) event.custom_data.currency = currency || 'BRL';
    }

    // URL de origem
    if (source_url) {
      event.event_source_url = source_url;
    }

    return event;
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

    const eventPayload = this.buildEventPayload(eventData, userData);

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
        hasEmail: !!userData.email_hash || !!userData.email,
        hasFbc: !!userData.fbc,
        hasFbp: !!userData.fbp,
        hasIp: !!userData.ip_address,
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
      const errorMessage = error.response?.data?.error?.message || error.message;
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
