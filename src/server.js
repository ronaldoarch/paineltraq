require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');
const logger = require('./config/logger');

// Importar rotas
const apiRoutes = require('./routes/api');
const webhookXgate = require('./routes/webhookXgate');
const webhookCassino = require('./routes/webhookCassino');
const webhookFluxlab = require('./routes/webhookFluxlab');

// Importar worker da fila
const { startWorker } = require('./jobs/eventWorker');

const app = express();
const PORT = process.env.PORT || 3001;

// Coolify / Traefik / Nginx — IP real e rate-limit corretos atrás do proxy
if (process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

// ============================================
// MIDDLEWARES GLOBAIS
// ============================================

// Segurança
app.use(helmet({
  contentSecurityPolicy: false, // Desabilitar para servir o dashboard
  crossOriginEmbedderPolicy: false,
}));

// CORS - permitir acesso do dashboard
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.BASE_URL, 'http://localhost:3000']
    : '*',
  credentials: true,
}));

// Parse JSON (guarda corpo bruto nos /webhook/* para HMAC ex.: Meta System → X-Webhook-Signature)
app.use(
  express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
      if (req.originalUrl && req.originalUrl.startsWith('/webhook/')) {
        req.rawBody = buf;
      }
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

// Logging HTTP
app.use(morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim()),
  },
  skip: (req) =>
    req.url === '/api/health' || req.url.startsWith('/api/health/live'), // Não logar health checks
}));

// Rate limiting para webhooks (proteção contra flood)
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 200, // máximo 200 requests por minuto por IP
  message: { error: 'Too many requests' },
  standardHeaders: true,
});

// Rate limiting para API do dashboard
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests' },
});

// Rate limiting para login (mais restritivo)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // máximo 10 tentativas
  message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
});

// ============================================
// ROTAS
// ============================================

// Webhooks (sem autenticação - validados por signature)
app.use('/webhook/xgate', webhookLimiter, webhookXgate);
app.use('/webhook/cassino', webhookLimiter, webhookCassino);
app.use('/webhook/fluxlab', webhookLimiter, webhookFluxlab);

// Aliases (compatibilidade)
app.use('/api/xgate/webhook', webhookLimiter, webhookXgate);

// API do Dashboard: rate-limit de login no mesmo mount /api (evita stack duplicado em /api/auth/login)
app.use(
  '/api',
  (req, res, next) => {
    if (req.method === 'POST' && req.path === '/auth/login') {
      return loginLimiter(req, res, next);
    }
    next();
  },
  apiLimiter,
  apiRoutes,
);

// Servir dashboard (frontend estático)
app.use(express.static(path.join(__dirname, '../public')));

// Sem ficheiro em public/ — evita servir o HTML inteiro como "favicon" (200 + 60k nos logs)
app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

// Qualquer rota não encontrada serve o index.html (SPA)
app.get('*', (req, res) => {
  // Se não é uma rota de API ou webhook, servir o dashboard
  if (!req.url.startsWith('/api') && !req.url.startsWith('/webhook')) {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  } else {
    res.status(404).json({ error: 'Rota não encontrada' });
  }
});

// ============================================
// ERROR HANDLER GLOBAL
// ============================================

app.use((err, req, res, next) => {
  logger.error('[Server] Erro não tratado', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
  });

  res.status(500).json({
    error: 'Erro interno do servidor',
    ...(process.env.DEBUG_MODE === 'true' && { details: err.message }),
  });
});

// ============================================
// INICIALIZAÇÃO
// ============================================

async function start() {
  try {
    if (!process.env.JWT_SECRET?.trim()) {
      logger.error(
        '[Server] JWT_SECRET não definido ou vazio. Defina nas variáveis de ambiente (Coolify / .env).',
      );
      process.exit(1);
    }

    // Testar conexão com banco
    const { pool } = require('./config/database');
    await pool.query('SELECT 1');
    logger.info('[Server] ✅ Banco de dados conectado');

    // Iniciar worker da fila
    await startWorker();
    logger.info('[Server] ✅ Worker da fila iniciado');

    // Iniciar servidor (timeouts compatíveis com Traefik/Nginx — default Node ~5s causa 502/504 intermitentes)
    const server = app.listen(PORT, '0.0.0.0', () => {
      logger.info(`[Server] ✅ Bearbet Tracker rodando na porta ${PORT}`);
      logger.info(`[Server] 📊 Dashboard: http://localhost:${PORT}`);
      logger.info(`[Server] 🔗 Webhook XGate: http://localhost:${PORT}/webhook/xgate`);
      logger.info(`[Server] 🔗 Webhook Cassino: http://localhost:${PORT}/webhook/cassino`);
      logger.info(`[Server] 🔗 Webhook FluxLab: http://localhost:${PORT}/webhook/fluxlab`);
      logger.info(`[Server] 💚 Health Check: http://localhost:${PORT}/api/health`);
    });
    // Acima do read_timeout típico do Traefik/Nginx (60–120s) para evitar 502/504 em /api/stats ou webhooks lentos
    const keepAliveMs = Number(process.env.HTTP_KEEPALIVE_TIMEOUT_MS || 190000);
    const headersMs = Number(process.env.HTTP_HEADERS_TIMEOUT_MS || 195000);
    server.keepAliveTimeout = keepAliveMs;
    server.headersTimeout = headersMs;
    const socketMs = Number(process.env.HTTP_SERVER_SOCKET_TIMEOUT_MS || 240000);
    if (Number.isFinite(socketMs) && socketMs > 0) {
      server.timeout = socketMs;
    }
    const reqTimeoutMs = Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 180000);
    if ('requestTimeout' in server && Number.isFinite(reqTimeoutMs) && reqTimeoutMs > 0) {
      server.requestTimeout = reqTimeoutMs;
    }
  } catch (error) {
    logger.error('[Server] ❌ Falha ao iniciar', { error: error.message });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('[Server] SIGTERM recebido, encerrando...');
  const { pool } = require('./config/database');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('[Server] SIGINT recebido, encerrando...');
  const { pool } = require('./config/database');
  await pool.end();
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('[Server] Unhandled Rejection', { reason: reason?.message || reason });
});

start();

module.exports = app;
