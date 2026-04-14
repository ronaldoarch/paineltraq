const { query, transaction } = require('../config/database');
const { hashSHA256, normalizeEmail, normalizePhone } = require('../utils/helpers');
const logger = require('../config/logger');

class UserService {
  /**
   * Encontra ou cria um usuário baseado nos dados disponíveis
   * 
   * Ordem de matching:
   * 1. click_id (mais confiável - vem do Meta)
   * 2. fbc (Facebook Click Cookie)
   * 3. external_id (ID do cassino)
   * 4. email (fallback principal)
   * 5. phone (último fallback)
   * 
   * Retorna: { user, matchedBy, isNew }
   */
  async findOrCreate(data) {
    const {
      email, phone, first_name, last_name, country,
      fbc, fbp, click_id, ip_address, user_agent,
      external_id, utm_source, utm_medium, utm_campaign,
      utm_content, utm_term, source
    } = data;

    let user = null;
    let matchedBy = null;

    // 1. Tentar match por click_id
    if (click_id) {
      user = await this.findByField('click_id', click_id);
      if (user) matchedBy = 'click_id';
    }

    // 2. Tentar match por fbc
    if (!user && fbc) {
      user = await this.findByField('fbc', fbc);
      if (user) matchedBy = 'fbc';
    }

    // 3. Tentar match por external_id
    if (!user && external_id) {
      user = await this.findByField('external_id', external_id);
      if (user) matchedBy = 'external_id';
    }

    // 4. Tentar match por email
    if (!user && email) {
      const normalizedEmail = normalizeEmail(email);
      user = await this.findByField('email', normalizedEmail);
      if (user) matchedBy = 'email';
    }

    // 5. Tentar match por telefone
    if (!user && phone) {
      const normalizedPhone = normalizePhone(phone);
      user = await this.findByField('phone', normalizedPhone);
      if (user) matchedBy = 'phone';
    }

    // Se encontrou, atualiza dados que faltam
    if (user) {
      user = await this.enrichUser(user.id, data);
      logger.info('[UserService] Usuário encontrado', {
        userId: user.id,
        matchedBy,
        email: email ? '***' : null,
      });
      return { user, matchedBy, isNew: false };
    }

    // Se não encontrou, cria novo
    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = normalizePhone(phone);

    const result = await query(
      `INSERT INTO users (
        external_id, email, email_hash, phone, phone_hash,
        first_name, last_name, country,
        fbc, fbp, click_id, ip_address, user_agent,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING *`,
      [
        external_id,
        normalizedEmail,
        normalizedEmail ? hashSHA256(normalizedEmail) : null,
        normalizedPhone,
        normalizedPhone ? hashSHA256(normalizedPhone) : null,
        first_name, last_name, country || 'BR',
        fbc, fbp, click_id, ip_address, user_agent,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        source || 'unknown'
      ]
    );

    user = result.rows[0];
    logger.info('[UserService] Novo usuário criado', {
      userId: user.id,
      source: source || 'unknown',
    });

    return { user, matchedBy: 'new', isNew: true };
  }

  /**
   * Busca usuário por campo específico
   */
  async findByField(field, value) {
    const allowedFields = ['email', 'phone', 'click_id', 'fbc', 'external_id', 'id'];
    if (!allowedFields.includes(field)) {
      throw new Error(`Campo não permitido para busca: ${field}`);
    }
    const result = await query(
      `SELECT * FROM users WHERE ${field} = $1 LIMIT 1`,
      [value]
    );
    return result.rows[0] || null;
  }

  /**
   * Enriquece dados do usuário com informações novas
   * Só atualiza campos que estavam vazios
   */
  async enrichUser(userId, data) {
    const updates = [];
    const values = [];
    let paramIndex = 1;

    const fieldsToEnrich = {
      fbc: data.fbc,
      fbp: data.fbp,
      click_id: data.click_id,
      ip_address: data.ip_address,
      user_agent: data.user_agent,
      external_id: data.external_id,
      first_name: data.first_name,
      last_name: data.last_name,
      phone: data.phone ? normalizePhone(data.phone) : null,
      email: data.email ? normalizeEmail(data.email) : null,
    };

    for (const [field, value] of Object.entries(fieldsToEnrich)) {
      if (value) {
        // Só atualiza se o campo atual estiver vazio
        updates.push(`${field} = COALESCE(NULLIF(${field}, ''), $${paramIndex})`);
        values.push(value);
        paramIndex++;
      }
    }

    // Atualiza hashes se email ou phone foram atualizados
    if (data.email) {
      const normalized = normalizeEmail(data.email);
      updates.push(`email_hash = COALESCE(NULLIF(email_hash, ''), $${paramIndex})`);
      values.push(hashSHA256(normalized));
      paramIndex++;
    }
    if (data.phone) {
      const normalized = normalizePhone(data.phone);
      updates.push(`phone_hash = COALESCE(NULLIF(phone_hash, ''), $${paramIndex})`);
      values.push(hashSHA256(normalized));
      paramIndex++;
    }

    if (updates.length === 0) {
      const result = await query('SELECT * FROM users WHERE id = $1', [userId]);
      return result.rows[0];
    }

    updates.push(`updated_at = NOW()`);
    values.push(userId);

    const result = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    return result.rows[0];
  }

  /**
   * Lista usuários com paginação
   */
  async list({ page = 1, limit = 50, search = null }) {
    const offset = (page - 1) * limit;
    let whereClause = '';
    const params = [limit, offset];

    if (search) {
      whereClause = `WHERE email ILIKE $3 OR phone ILIKE $3 OR external_id ILIKE $3 OR click_id ILIKE $3`;
      params.push(`%${search}%`);
    }

    const [usersResult, countResult] = await Promise.all([
      query(
        `SELECT id, external_id, email, phone, fbc, fbp, click_id,
                ip_address, utm_source, utm_campaign, source, created_at
         FROM users ${whereClause}
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        params
      ),
      query(`SELECT COUNT(*) as total FROM users ${whereClause}`, search ? [`%${search}%`] : []),
    ]);

    return {
      users: usersResult.rows,
      total: parseInt(countResult.rows[0].total),
      page,
      limit,
      totalPages: Math.ceil(parseInt(countResult.rows[0].total) / limit),
    };
  }

  /**
   * Busca usuário por ID com seus eventos
   */
  async getById(id) {
    const [userResult, eventsResult] = await Promise.all([
      query('SELECT * FROM users WHERE id = $1', [id]),
      query(
        `SELECT id, event_id, event_type, event_name, value, currency,
                source, status, meta_sent, created_at
         FROM events WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 50`,
        [id]
      ),
    ]);

    if (!userResult.rows[0]) return null;

    return {
      ...userResult.rows[0],
      events: eventsResult.rows,
    };
  }

  /**
   * Conta total de usuários
   */
  async count() {
    const result = await query('SELECT COUNT(*) as total FROM users');
    return parseInt(result.rows[0].total);
  }

  /**
   * Conta usuários criados hoje
   */
  async countToday() {
    const result = await query(
      `SELECT COUNT(*) as total FROM users
       WHERE created_at >= CURRENT_DATE`
    );
    return parseInt(result.rows[0].total);
  }
}

module.exports = new UserService();
