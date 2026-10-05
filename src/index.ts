import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closeDatabase, openDatabase } from './database/db.js';
import { startWhatsAppClient } from './whatsapp/connection.js';

/**
 * WhatsApp AI Secretary — ingestion MVP (READ-ONLY).
 * Connects via Baileys 7.x, stores messages/messages metadata in local SQLite.
 * Never sends messages.
 */
async function main(): Promise<void> {
  logger.info(
    {
      authDir: env.authDir,
      sqlitePath: env.sqlitePath,
      syncFullHistory: env.syncFullHistory,
      markOnlineOnConnect: env.markOnlineOnConnect,
    },
    'starting whatsapp ingestion (read-only)',
  );

  const db = openDatabase(logger);
  const client = await startWhatsAppClient({ db, log: logger });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutdown signal received (session is kept, just disconnecting)');
    client.stop(signal);
    closeDatabase();
    // give the socket a moment to close cleanly
    setTimeout(() => process.exit(0), 500).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'unhandled rejection (process stays up)');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
