const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query } = require('../config/database');
const authMiddleware = require('../middleware/auth');
const eventService = require('../services/eventService');
const userService = require('../services/userService');
const settingsService = require('../services/settingsService');
const metaService = require('../services/metaService');
const logger = require('../config/logger');

// ============================================
// AUTH
// ============================================

/**
 * POST /api/auth/login
 */
router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username e password são obrigatórios' });
    }

    const result = await query(
      'SELECT * FROM admin_users WHERE username = $1',
      [username]
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    // Atualizar último login
    await query('UPDATE admin_users SET last_login = NOW() WHERE id = $1', [user.id]);

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
    });
  } catch (error) {
    logger.error('[Auth] Erro no login', { error: error.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

/**
 * POST /api/auth/change-password
 */
router.post('/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const result = await query('SELECT * FROM admin_users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];

    const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Senha atual incorreta' });
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);

    res.json({ success: true, message: 'Senha alterada com sucesso' });
  } catch (error) {
    logger.error('[Auth] Erro ao alterar senha', { error: error.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

/**
 * GET /api/auth/me
 */
router.get('/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ============================================
// DASHBOARD STATS
// ============================================

/**
 * GET /api/stats
 */
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const stats = await eventService.getStats({ startDate, endDate });
    const totalUsers = await userService.count();
    const todayUsers = await userService.countToday();

    res.json({
      ...stats,
      totalUsers,
      todayUsers,
    });
  } catch (error) {
    logger.error('[API] Erro ao buscar stats', { error: error.message });
    res.status(500).json({ error: 'Erro ao buscar estatísticas' });
  }
});

// ============================================
// EVENTS
// ============================================

/**
 * GET /api/events
 */
router.get('/events', authMiddleware, async (req, res) => {
  try {
    const { page, limit, eventType, status, source, startDate, endDate } = req.query;
    const result = await eventService.list({
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 50,
      eventType,
      status,
      source,
      startDate,
      endDate,
    });
    res.json(result);
  } catch (error) {
    logger.error('[API] Erro ao listar eventos', { error: error.message });
    res.status(500).json({ error: 'Erro ao listar eventos' });
  }
});

/**
 * GET /api/events/:eventId/logs
 */
router.get('/events/:eventId/logs', authMiddleware, async (req, res) => {
  try {
    const result = await eventService.getEventLogs(req.params.eventId);
    res.json(result);
  } catch (error) {
    logger.error('[API] Erro ao buscar logs', { error: error.message });
    res.status(500).json({ error: 'Erro ao buscar logs do evento' });
  }
});

/**
 * POST /api/events/:eventId/retry
 */
router.post('/events/:eventId/retry', authMiddleware, async (req, res) => {
  try {
    const result = await eventService.retryEvent(req.params.eventId);
    res.json(result);
  } catch (error) {
    logger.error('[API] Erro ao reprocessar evento', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// USERS
// ============================================

/**
 * GET /api/users
 */
router.get('/users', authMiddleware, async (req, res) => {
  try {
    const { page, limit, search } = req.query;
    const result = await userService.list({
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 50,
      search,
    });
    res.json(result);
  } catch (error) {
    logger.error('[API] Erro ao listar usuários', { error: error.message });
    res.status(500).json({ error: 'Erro ao listar usuários' });
  }
});

/**
 * GET /api/users/:id
 */
router.get('/users/:id', authMiddleware, async (req, res) => {
  try {
    const user = await userService.getById(parseInt(req.params.id));
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    res.json(user);
  } catch (error) {
    logger.error('[API] Erro ao buscar usuário', { error: error.message });
    res.status(500).json({ error: 'Erro ao buscar usuário' });
  }
});

// ============================================
// SETTINGS
// ============================================

/**
 * GET /api/settings
 */
router.get('/settings', authMiddleware, async (req, res) => {
  try {
    const settings = await settingsService.getSafe();
    res.json(settings);
  } catch (error) {
    logger.error('[API] Erro ao buscar settings', { error: error.message });
    res.status(500).json({ error: 'Erro ao buscar configurações' });
  }
});

/**
 * PUT /api/settings
 */
router.put('/settings', authMiddleware, async (req, res) => {
  try {
    const allowedKeys = [
      'meta_pixel_id', 'meta_access_token', 'meta_api_version',
      'meta_test_event_code', 'debug_mode', 'deduplication_window_minutes'
    ];

    const updates = {};
    for (const [key, value] of Object.entries(req.body)) {
      if (allowedKeys.includes(key)) {
        updates[key] = value;
      }
    }

    // Não apagar o access token no BD quando o campo vem vazio (UI não envia o valor mascarado)
    if (
      updates.meta_access_token !== undefined &&
      String(updates.meta_access_token).trim() === ''
    ) {
      delete updates.meta_access_token;
    }

    await settingsService.setMultiple(updates);
    logger.info('[API] Settings atualizadas', { keys: Object.keys(updates) });

    res.json({ success: true, message: 'Configurações atualizadas' });
  } catch (error) {
    logger.error('[API] Erro ao atualizar settings', { error: error.message });
    res.status(500).json({ error: 'Erro ao atualizar configurações' });
  }
});

/**
 * POST /api/settings/test-meta
 */
router.post('/settings/test-meta', authMiddleware, async (req, res) => {
  try {
    const result = await metaService.testConnection();
    res.json(result);
  } catch (error) {
    logger.error('[API] Erro ao testar Meta', { error: error.message });
    res.status(500).json({ error: 'Erro ao testar conexão' });
  }
});

/**
 * POST /api/settings/webhook-secrets/generate
 * Gera e grava secret para validar webhooks do cassino (X-Webhook-Secret ou Authorization Bearer).
 */
router.post('/settings/webhook-secrets/generate', authMiddleware, async (req, res) => {
  try {
    const { target } = req.body || {};
    if (target !== 'cassino') {
      return res.status(400).json({ error: 'target inválido (use: cassino)' });
    }

    const secret = crypto.randomBytes(32).toString('hex');
    await settingsService.set(
      'webhook_secret_cassino',
      secret,
      'Secret para validar webhooks do cassino (X-Webhook-Secret ou Authorization Bearer)',
    );
    try {
      const cassinoRouter = require('./webhookCassino');
      if (cassinoRouter.invalidateCassinoWebhookSecretCache) {
        cassinoRouter.invalidateCassinoWebhookSecretCache();
      }
    } catch (_) {
      /* ignore */
    }
    logger.info('[API] webhook_secret_cassino regenerado');

    res.json({
      success: true,
      secret,
      headerName: 'X-Webhook-Secret',
      message:
        'Copie o secret agora. Ele não volta a aparecer no painel; guarde no backoffice do cassino.',
    });
  } catch (error) {
    logger.error('[API] Erro ao gerar webhook secret', { error: error.message });
    res.status(500).json({ error: 'Erro ao gerar secret' });
  }
});

// ============================================
// WEBHOOK LOGS
// ============================================

/**
 * GET /api/webhook-logs
 */
router.get('/webhook-logs', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 50, source } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let whereClause = '';
    const params = [parseInt(limit), offset];

    if (source) {
      whereClause = 'WHERE source = $3';
      params.push(source);
    }

    const [logsResult, countResult] = await Promise.all([
      query(
        `SELECT id, source, endpoint, method, ip_address, processed, error_message, created_at
         FROM webhook_logs ${whereClause}
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        params
      ),
      query(`SELECT COUNT(*) as total FROM webhook_logs ${whereClause}`, source ? [source] : []),
    ]);

    res.json({
      logs: logsResult.rows,
      total: parseInt(countResult.rows[0].total),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (error) {
    logger.error('[API] Erro ao buscar webhook logs', { error: error.message });
    res.status(500).json({ error: 'Erro ao buscar logs' });
  }
});

/**
 * GET /api/webhook-logs/:id
 */
router.get('/webhook-logs/:id', authMiddleware, async (req, res) => {
  try {
    const result = await query('SELECT * FROM webhook_logs WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Log não encontrado' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    logger.error('[API] Erro ao buscar webhook log', { error: error.message });
    res.status(500).json({ error: 'Erro ao buscar log' });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

/**
 * GET /api/health/live
 * Liveness sem consultar BD — para Docker/Coolify/Traefik durante startup ou probes rápidos.
 */
router.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'live', timestamp: new Date().toISOString() });
});

/**
 * GET /api/health
 */
router.get('/health', async (req, res) => {
  try {
    // Testar conexão com banco
    await query('SELECT 1');

    const metaConfig = await metaService.getConfig();

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'connected',
      meta: {
        pixelConfigured: !!metaConfig.meta_pixel_id,
        tokenConfigured: !!metaConfig.meta_access_token,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
    });
  }
});

module.exports = router;
