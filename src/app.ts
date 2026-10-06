import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AnalyzeScheduler, countUnprocessed } from './ai/analyzeScheduler.js';
import { createProvider } from './ai/providerFactory.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closeDatabase, openDatabase, type Db } from './database/db.js';
import { Auth, authGuard } from './server/auth.js';
import { QrPng } from './server/qr.js';
import { whatsappRoutes, type WhatsAppController } from './server/routes/whatsapp.js';
import { dashboardRoutes } from './server/routes/tasks.js';
import { chatsRoutes } from './server/routes/chats.js';
import { digestRoutes } from './server/routes/digest.js';
import { DigestScheduler, DigestService } from './digest/service.js';
import { WhatsAppManager } from './whatsapp/manager.js';
import type { Logger } from 'pino';

/** WA-клиент, нужный приложению. WhatsAppManager покрывает полностью. */
export type AppWaClient = WhatsAppController;

export type AppScheduler = {
  metricsSnapshot(): ReturnType<AnalyzeScheduler['metricsSnapshot']>;
  start(): void;
  stop(): void;
};

export type AppOptions = {
  db: Db;
  log: Logger;
  wa: AppWaClient;
  scheduler: AppScheduler;
  qrPng: (qr: string | null) => Promise<string | null>;
  /** опущен = авторизация выключена (тесты, локальный 127.0.0.1) */
  auth?: { password: string; loginMaxAttempts?: number; loginWindowMs?: number };
  /** опущен = routes дайджеста не регистрируются (старые тесты) */
  digest?: DigestService;
};

/**
 * Собирает Fastify-приложение (шаг 5): auth-guard, login с rate limit,
 * WhatsApp API, system/status. Без listen и без side-эффектов —
 * поэтому покрывается inject-тестами с моками.
 */
export async function createApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: opts.log as unknown as FastifyBaseLogger });
  const auth = new Auth({
    password: opts.auth?.password ?? '',
    loginMaxAttempts: opts.auth?.loginMaxAttempts,
    loginWindowMs: opts.auth?.loginWindowMs,
  });

  app.addHook('preHandler', authGuard(auth));

  app.get('/health', async () => ({ ok: true }));
  app.get('/api/health', async () => ({ ok: true }));

  const LoginSchema = z.object({ password: z.string() });
  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    if (auth.isRateLimited(ip)) {
      return reply.code(429).send({ error: 'слишком много попыток, попробуйте позже' });
    }
    const body = LoginSchema.safeParse(req.body);
    if (!body.success || !auth.verifyPassword(body.data.password)) {
      return reply.code(401).send({ error: 'неверный пароль' });
    }
    const token = auth.createSession();
    return reply
      .header('Set-Cookie', auth.sessionCookieHeader(token))
      .send({ ok: true });
  });

  await whatsappRoutes(app, opts.wa, opts.qrPng);
  await dashboardRoutes(app, opts.db);
  await chatsRoutes(app, opts.db);
  if (opts.digest) {
    await digestRoutes(app, opts.digest);
  }

  // Фронтенд (шаг 6): собранный web/dist раздаётся как статика + SPA-fallback.
  // Без собранного фронта API работает как раньше.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'нет такого API' });
      }
      return reply.sendFile('index.html');
    });
    opts.log.info({ webDist }, 'serving frontend static');
  } else {
    opts.log.warn({ webDist }, 'web/dist missing — run npm run build:web for the dashboard UI');
  }

  app.get('/api/system/status', async () => ({
    analyze: opts.scheduler.metricsSnapshot(),
    unprocessedMessages: countUnprocessed(opts.db),
  }));

  return app;
}

/**
 * Composition root (шаг 5): БД, WhatsApp-клиент, планировщик анализа, Fastify.
 * src/index.ts только вызывает runApp().
 */
export async function runApp(): Promise<{ app: FastifyInstance; stop: () => Promise<void> }> {
  if (env.webPassword === '' && env.webHost !== '127.0.0.1') {
    logger.fatal(
      { webHost: env.webHost },
      'WEB_PASSWORD пуст, а WEB_HOST не 127.0.0.1 — без пароля сервер наружу не стартует. Задайте WEB_PASSWORD в .env',
    );
    process.exit(1);
  }

  const db = openDatabase(logger);
  const wa = new WhatsAppManager(db, logger);
  const scheduler = new AnalyzeScheduler({
    db,
    log: logger,
    getProvider: () => createProvider(),
    intervalMs: env.analyzeIntervalMin * 60_000,
    maxChats: env.analyzeMaxChats,
    chatTimeoutMs: env.aiTimeoutMs,
    maintenance: {
      sqliteFile: path.resolve(env.sqlitePath),
      backupDir: path.resolve(env.backupDir),
      backupKeepN: env.backupKeepN,
      retentionDays: env.retentionDays,
    },
  });
  const qrPng = new QrPng();
  const digestService = new DigestService(db, logger, wa, {
    ownerJid: env.ownerJid,
    timezone: env.timezone,
    digestTime: env.digestTime,
  });
  const digestScheduler = new DigestScheduler(digestService, logger);

  const app = await createApp({
    db,
    log: logger,
    wa,
    scheduler,
    qrPng: (qr) => qrPng.toDataUrl(qr),
    auth: { password: env.webPassword },
    digest: digestService,
  });

  // WhatsApp и планировщики стартуют в фоне: API отвечает даже без сети/WA.
  wa.start().catch((err: unknown) => {
    logger.error({ err }, 'whatsapp autostart failed (UI still serves, use connect API)');
  });
  scheduler.start();
  digestScheduler.start();

  const stop = async (): Promise<void> => {
    logger.info('shutting down (crons stopped, session kept)');
    scheduler.stop();
    digestScheduler.stop();
    wa.stop();
    try {
      await app.close();
    } catch {
      // ignore close errors during shutdown
    }
    closeDatabase();
  };

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutdown signal received');
    void stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err: unknown) => {
    logger.error({ err }, 'unhandled rejection (server stays up)');
  });

  await app.listen({ host: env.webHost, port: env.webPort });
  logger.info({ host: env.webHost, port: env.webPort }, 'server listening');
  return { app, stop };
}
