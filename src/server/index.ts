import Fastify, { type FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { closeDatabase, openDatabase } from '../database/db.js';
import { WhatsAppManager } from '../whatsapp/manager.js';
import { whatsappRoutes } from './routes/whatsapp.js';

/**
 * PHASE 1: HTTP-сервер + SQLite + Baileys + QR/SSE API.
 * Сервер владеет Baileys-соединением (старт при boot, ingestion продолжается
 * внутри connection.ts). Фронтенд — в Phase 2.
 */
async function main(): Promise<void> {
  const portCheck = z.number().int().min(1).max(65535).safeParse(env.serverPort);
  if (!portCheck.success) {
    logger.fatal({ serverPort: env.serverPort }, 'invalid SERVER_PORT');
    process.exit(1);
  }

  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });
  const db = openDatabase(logger);
  const wa = new WhatsAppManager(db, logger);

  await whatsappRoutes(app, wa);
  app.get('/api/health', async () => ({ ok: true }));

  // WhatsApp стартует в фоне: сервер отвечает UI даже если сеть/WA недоступны.
  wa.start().catch((err: unknown) => {
    logger.error({ err }, 'whatsapp autostart failed (UI still serves, use connect API)');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down server (session is kept)');
    wa.stop();
    try {
      await app.close();
    } catch {
      // ignore close errors during shutdown
    }
    closeDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err: unknown) => {
    logger.error({ err }, 'unhandled rejection (server stays up)');
  });

  await app.listen({ host: env.serverHost, port: env.serverPort });
  logger.info({ host: env.serverHost, port: env.serverPort }, 'server listening');
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start server');
  process.exit(1);
});
