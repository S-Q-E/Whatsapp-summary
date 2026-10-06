import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../database/db.js';
import { startOfDay, toLocalDateString } from '../utils/time.js';
import { buildDigest } from './builder.js';
import { renderWhatsAppDigest } from './renderer.js';

export type DigestTransport = {
  isConnected(): boolean;
  sendDigestText(text: string): Promise<void>;
};

export type DigestServiceOpts = {
  ownerJid: string;
  timezone: string;
  /** HH:MM в TIMEZONE */
  digestTime: string;
};

export type SendResult = {
  sent: boolean;
  reason: 'sent' | 'already-sent' | 'too-early' | 'no-owner' | 'offline' | 'send-failed';
  dateIso: string;
};

function sendMomentMs(nowMs: number, timezone: string, digestTime: string): number {
  const [h, m] = digestTime.split(':').map(Number);
  return startOfDay(new Date(nowMs), timezone) + h! * 3_600_000 + m! * 60_000;
}

/**
 * Дневной дайджест с идемпотентностью (шаг 7): одна строка на дату
 * в таблице digests, sent=1 только после успешной отправки.
 * Рестарт и офлайн оставляют sent=0 — следующий тик повторяет.
 */
export class DigestService {
  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly transport: DigestTransport,
    private readonly opts: DigestServiceOpts,
  ) {}

  /** Текст без отправки и без записи в БД (preview в UI). */
  preview(day: Date = new Date()): { dateIso: string; content: string } {
    const digest = buildDigest(this.db, day);
    return { dateIso: digest.dateIso, content: renderWhatsAppDigest(digest, this.opts.timezone) };
  }

  async sendToday(reason: string, nowMs: number = Date.now()): Promise<SendResult> {
    const { timezone, digestTime, ownerJid } = this.opts;
    const dateIso = toLocalDateString(nowMs, timezone);
    const existing = this.db.get<{ sent: number }>(sql`SELECT sent FROM digests WHERE date = ${dateIso}`);
    if (existing?.sent === 1) return { sent: false, reason: 'already-sent', dateIso };
    if (nowMs < sendMomentMs(nowMs, timezone, digestTime)) {
      return { sent: false, reason: 'too-early', dateIso };
    }
    if (!ownerJid.trim()) {
      this.log.warn({ dateIso }, 'digest due but OWNER_JID empty, skipping');
      return { sent: false, reason: 'no-owner', dateIso };
    }
    const { content } = this.preview(new Date(nowMs));
    const now = Date.now();
    this.db.run(sql`
      INSERT INTO digests (date, content, sent, created_at)
      VALUES (${dateIso}, ${content}, 0, ${now})
      ON CONFLICT(date) DO UPDATE SET content = excluded.content
    `);
    if (!this.transport.isConnected()) {
      this.log.warn({ dateIso }, 'digest due but WhatsApp offline, will retry');
      return { sent: false, reason: 'offline', dateIso };
    }
    try {
      await this.transport.sendDigestText(content);
    } catch (err) {
      this.log.warn({ err, dateIso }, 'digest send failed, will retry');
      return { sent: false, reason: 'send-failed', dateIso };
    }
    this.db.run(sql`UPDATE digests SET sent = 1, sent_at = ${Date.now()} WHERE date = ${dateIso}`);
    this.log.info({ dateIso, reason }, 'digest sent to owner');
    return { sent: true, reason: 'sent', dateIso };
  }
}

/** Тикающий планировщик: проверка каждую минуту + сразу при старте. */
export class DigestScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly service: DigestService,
    private readonly log: Logger,
    private readonly intervalMs: number = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.service.sendToday('startup').catch((err: unknown) => {
      this.log.error({ err }, 'digest startup tick failed');
    });
    this.timer = setInterval(() => {
      void this.service.sendToday('schedule').catch((err: unknown) => {
        this.log.error({ err }, 'digest scheduled tick failed');
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
