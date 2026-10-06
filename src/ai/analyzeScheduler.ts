import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../database/db.js';
import { analyzeChat, loadPendingBundles } from './taskService.js';
import type { AIProvider } from './types.js';

export type AnalyzeMetrics = {
  lastRunAt: number | null;
  lastDurationMs: number;
  lastChats: number;
  lastCreated: number;
  lastUpdated: number;
  lastSkipped: number;
  lastError: string | null;
  runCount: number;
  providerErrorCount: number;
  /** только текст ошибки провайдера, без переписки */
  lastProviderError: string | null;
  running: boolean;
};

export type SchedulerOptions = {
  db: Db;
  log: Logger;
  getProvider: () => AIProvider;
  /** период прохода, мс */
  intervalMs: number;
  /** максимум чатов за один проход */
  maxChats: number;
  /** таймаут одного чата, мс (опоздавший анализ всё равно коммитит — идемпотентно) */
  chatTimeoutMs: number;
  now?: () => number;
};

export type TickResult = {
  started: boolean;
  chats: number;
  created: number;
  updated: number;
  skipped: number;
};

/**
 * Планировщик анализа (шаг 5): периодически разбирает чаты
 * с необработанными сообщениями. Один проход за раз (mutex):
 * параллельный tick пропускается. Ошибка одного чата (включая
 * таймаут и ошибку провайдера) не валит проход; сообщения остаются
 * необработанными и попадут в следующий.
 */
export class AnalyzeScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly metrics: AnalyzeMetrics = {
    lastRunAt: null,
    lastDurationMs: 0,
    lastChats: 0,
    lastCreated: 0,
    lastUpdated: 0,
    lastSkipped: 0,
    lastError: null,
    runCount: 0,
    providerErrorCount: 0,
    lastProviderError: null,
    running: false,
  };

  constructor(private readonly opts: SchedulerOptions) {}

  metricsSnapshot(): AnalyzeMetrics {
    return { ...this.metrics, running: this.running };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.opts.log.error({ err }, 'scheduled analyze tick failed');
      });
    }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<TickResult> {
    const empty: TickResult = { started: false, chats: 0, created: 0, updated: 0, skipped: 0 };
    if (this.running) return empty;
    this.running = true;
    const { db, log } = this.opts;
    const now = this.opts.now ?? Date.now;
    const t0 = now();
    const res: TickResult = { started: true, chats: 0, created: 0, updated: 0, skipped: 0 };
    try {
      const bundles = loadPendingBundles(db, {}).slice(0, this.opts.maxChats);
      const provider = this.opts.getProvider();
      const analyzedAt = now();
      for (const b of bundles) {
        res.chats += 1;
        try {
          const r = await this.withTimeout(
            analyzeChat(db, log, provider, b, analyzedAt),
            this.opts.chatTimeoutMs,
          );
          res.created += r.created.length;
          res.updated += r.updated.length;
          res.skipped += r.skipped;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.metrics.providerErrorCount += 1;
          this.metrics.lastProviderError = msg.slice(0, 300);
          log.warn({ err: msg, chat: b.chatJid }, 'scheduled chat analysis failed, will retry next pass');
        }
      }
      this.metrics.lastRunAt = now();
      this.metrics.lastDurationMs = now() - t0;
      this.metrics.lastChats = res.chats;
      this.metrics.lastCreated = res.created;
      this.metrics.lastUpdated = res.updated;
      this.metrics.lastSkipped = res.skipped;
      this.metrics.lastError = null;
      this.metrics.runCount += 1;
    } catch (err) {
      this.metrics.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      throw err;
    } finally {
      this.running = false;
    }
    return res;
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`chat analysis timed out after ${ms}ms`)), ms);
    });
    return Promise.race([p, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}

/** Число сообщений, ждущих анализа. */
export function countUnprocessed(db: Db): number {
  return db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM messages WHERE processed_at IS NULL`)?.n ?? 0;
}
