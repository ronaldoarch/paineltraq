const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

/**
 * Gera hash SHA-256 para dados do usuário (exigido pelo Meta CAPI)
 * O Meta exige que email e telefone sejam enviados como SHA-256
 */
function hashSHA256(value) {
  if (!value) return null;
  const normalized = String(value).toLowerCase().trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Normaliza email para hashing
 * Remove espaços, converte para lowercase
 */
function normalizeEmail(email) {
  if (!email) return null;
  return email.toLowerCase().trim();
}

/**
 * Normaliza telefone para formato E.164
 * Ex: (16) 99999-9999 → 5516999999999
 */
function normalizePhone(phone) {
  if (!phone) return null;
  // Remove tudo que não é número
  let cleaned = phone.replace(/\D/g, '');
  // Se começa com 0, remove
  if (cleaned.startsWith('0')) cleaned = cleaned.substring(1);
  // Se não começa com 55 (Brasil), adiciona
  if (!cleaned.startsWith('55')) cleaned = '55' + cleaned;
  return cleaned;
}

/**
 * Normaliza CPF para apenas dígitos (11 caracteres)
 * Ex: 123.456.789-00 → 12345678900
 */
function normalizeCpf(cpf) {
  if (!cpf) return null;
  const cleaned = String(cpf).replace(/\D/g, '');
  return cleaned.length === 11 ? cleaned : null;
}

/**
 * Normaliza gênero para o formato do Meta CAPI: 'm' ou 'f'
 * Aceita variantes PT/EN (masculino, feminino, male, female, m, f, 1, 2)
 */
function normalizeGender(gender) {
  if (!gender) return null;
  const g = String(gender).toLowerCase().trim();
  if (!g) return null;
  if (['m', 'masculino', 'male', 'homem', 'h', '1'].includes(g)) return 'm';
  if (['f', 'feminino', 'female', 'mulher', '2'].includes(g)) return 'f';
  return null;
}

/**
 * Normaliza data de nascimento para YYYYMMDD (formato do Meta CAPI `db`)
 * Aceita DD/MM/YYYY (padrão BR), YYYY-MM-DD e ISO 8601
 */
function normalizeBirthday(birthday) {
  if (!birthday) return null;
  const s = String(birthday).trim();
  if (!s) return null;

  // DD/MM/YYYY ou DD-MM-YYYY
  const br = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (br) return `${br[3]}${br[2]}${br[1]}`;

  // YYYY-MM-DD, YYYY/MM/DD ou ISO 8601 (2024-01-31T00:00:00Z)
  const iso = s.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;

  // Já em YYYYMMDD
  if (/^\d{8}$/.test(s)) return s;

  return null;
}

/**
 * Gera event_id único para deduplicação
 * Formato: {source}_{type}_{uuid}
 */
function generateEventId(source, type) {
  return `${source}_${type}_${uuidv4()}`;
}

/**
 * Gera event_id determinístico baseado em dados do evento
 * Usado para deduplicação - mesmo evento gera mesmo ID
 */
function generateDeterministicEventId(source, type, userId, timestamp) {
  const data = `${source}_${type}_${userId}_${timestamp}`;
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Extrai UTMs de uma URL ou objeto
 */
function extractUTMs(data) {
  if (!data) return {};
  if (typeof data === 'string') {
    try {
      const url = new URL(data);
      return {
        utm_source: url.searchParams.get('utm_source'),
        utm_medium: url.searchParams.get('utm_medium'),
        utm_campaign: url.searchParams.get('utm_campaign'),
        utm_content: url.searchParams.get('utm_content'),
        utm_term: url.searchParams.get('utm_term'),
      };
    } catch {
      return {};
    }
  }
  return {
    utm_source: data.utm_source || null,
    utm_medium: data.utm_medium || null,
    utm_campaign: data.utm_campaign || null,
    utm_content: data.utm_content || null,
    utm_term: data.utm_term || null,
  };
}

/**
 * Extrai fbclid de URL ou cookie fbc
 */
function extractFbclid(data) {
  if (!data) return null;
  // Se for uma URL
  if (typeof data === 'string' && data.includes('fbclid=')) {
    try {
      const url = new URL(data);
      return url.searchParams.get('fbclid');
    } catch {
      const match = data.match(/fbclid=([^&]+)/);
      return match ? match[1] : null;
    }
  }
  return data;
}

/**
 * Valida se o payload do webhook tem a estrutura esperada
 */
function validatePayload(payload, requiredFields) {
  const missing = [];
  for (const field of requiredFields) {
    const value = field.split('.').reduce((obj, key) => obj?.[key], payload);
    if (value === undefined || value === null || value === '') {
      missing.push(field);
    }
  }
  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Retorna timestamp Unix em segundos
 */
function unixTimestamp() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Sanitiza dados sensíveis para log
 */
function sanitizeForLog(data) {
  if (!data) return data;
  const sanitized = { ...data };
  const sensitiveFields = ['password', 'token', 'access_token', 'secret', 'authorization'];
  for (const key of Object.keys(sanitized)) {
    if (sensitiveFields.some(f => key.toLowerCase().includes(f))) {
      sanitized[key] = '***REDACTED***';
    }
  }
  return sanitized;
}

module.exports = {
  hashSHA256,
  normalizeEmail,
  normalizePhone,
  normalizeCpf,
  normalizeGender,
  normalizeBirthday,
  generateEventId,
  generateDeterministicEventId,
  extractUTMs,
  extractFbclid,
  validatePayload,
  unixTimestamp,
  sanitizeForLog,
};
