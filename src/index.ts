import { logger } from './config/logger.js';
import { runApp } from './app.js';

/**
 * WhatsApp AI Secretary — один процесс (шаг 5):
 * БД + WhatsApp-клиент + планировщик анализа + Fastify API.
 * Вся сборка — в src/app.ts, здесь только запуск.
 */
runApp().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start app');
  process.exit(1);
});
