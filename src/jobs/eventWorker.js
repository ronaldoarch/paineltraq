const { eventQueue } = require('../config/queue');
const eventService = require('../services/eventService');
const logger = require('../config/logger');

/**
 * Worker que processa jobs da fila de eventos
 * 
 * Responsável por:
 * - Pegar eventos da fila
 * - Enviar ao Meta CAPI
 * - Gerenciar retries automáticos
 */
async function startWorker() {
  // Processar jobs do tipo 'send-to-meta'
  eventQueue.process('send-to-meta', 5, async (job) => {
    logger.info('[Worker] Processando job', {
      jobId: job.id,
      eventId: job.data.eventId,
      eventType: job.data.metaEventName,
      attempt: job.attemptsMade + 1,
    });

    try {
      const result = await eventService.processQueueJob(job);
      return result;
    } catch (error) {
      logger.error('[Worker] Erro no job', {
        jobId: job.id,
        eventId: job.data.eventId,
        error: error.message,
        attempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts,
      });
      throw error; // Bull vai fazer retry automaticamente
    }
  });

  // Monitoramento da fila
  setInterval(async () => {
    try {
      const counts = await eventQueue.getJobCounts();
      if (counts.waiting > 0 || counts.active > 0 || counts.failed > 0) {
        logger.info('[Worker] Status da fila', {
          waiting: counts.waiting,
          active: counts.active,
          completed: counts.completed,
          failed: counts.failed,
          delayed: counts.delayed,
        });
      }
    } catch (error) {
      // Silenciar erros de monitoramento
    }
  }, 60000); // A cada 1 minuto

  logger.info('[Worker] Worker de eventos iniciado (concurrency: 5)');
}

module.exports = { startWorker };
