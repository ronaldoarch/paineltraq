const Bull = require('bull');
const logger = require('./logger');

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
};

/**
 * Fila de eventos para envio ao Meta CAPI
 * - Retry automático com backoff exponencial
 * - Máximo 5 tentativas
 * - Delay entre tentativas: 30s, 1min, 2min, 5min, 10min
 */
const eventQueue = new Bull('meta-events', {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 30000, // 30 segundos inicial
    },
    removeOnComplete: {
      age: 86400 * 7, // mantém 7 dias
      count: 10000,
    },
    removeOnFail: {
      age: 86400 * 30, // mantém 30 dias os que falharam
    },
  },
});

eventQueue.on('error', (error) => {
  logger.error('[Queue] Erro na fila', { error: error.message });
});

eventQueue.on('failed', (job, err) => {
  logger.error('[Queue] Job falhou', {
    jobId: job.id,
    eventType: job.data?.eventType,
    attempt: job.attemptsMade,
    error: err.message,
  });
});

eventQueue.on('completed', (job) => {
  logger.info('[Queue] Job concluído', {
    jobId: job.id,
    eventType: job.data?.eventType,
  });
});

module.exports = { eventQueue };
