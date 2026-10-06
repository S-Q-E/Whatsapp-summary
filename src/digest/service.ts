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
  reason: 'sent' | 'already-sent' | 'too-early' | 'no-owner' | 'offline' | 'send-failed' | 'sending';
  dateIso: string;
};

export type SendOptions = {
  nowMs?: number;
  /** обойти проверку времени (кнопка «Отправить сейчас»), но НЕ already-sent */
  force?: boolean;
  /** отправить повторно, даже если сегодня уже отправлялось */
  resend?: boolean;
};

/** TTL метки активной отправки: зависший sender не блокирует навсегда. */
const SENDING_TTL_MS = 5 * 60_000;

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
  /** очередь отправок: параллельные вызовы идут строго друг за другом */
  private sendQueue: Promise<void> = Promise.resolve();

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

  async sendToday(reason: string, opts?: SendOptions | number): Promise<SendResult> {
    const prev = this.sendQueue;
    let release!: () => void;
    this.sendQueue = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await this.doSend(reason, opts);
    } finally {
      release();
    }
  }

  private async doSend(reason: string, opts?: SendOptions | number): Promise<SendResult> {
    const o: SendOptions = typeof opts === 'number' ? { nowMs: opts } : (opts ?? {});
    const nowMs = o.nowMs ?? Date.now();
    const { timezone, digestTime, ownerJid } = this.opts;
    const dateIso = toLocalDateString(nowMs, timezone);
    const existing = this.db.get<{ sent: number }>(sql`SELECT sent FROM digests WHERE date = ${dateIso}`);
    if (existing?.sent === 1 && !o.resend) return { sent: false, reason: 'already-sent', dateIso };
    if (!o.force && nowMs < sendMomentMs(nowMs, timezone, digestTime)) {
      return { sent: false, reason: 'too-early', dateIso };
    }
    if (!ownerJid.trim()) {
      this.log.warn({ dateIso }, 'digest due but OWNER_JID empty, skipping');
      return { sent: false, reason: 'no-owner', dateIso };
    }
    // DB-статус отправки: чужой свежий маркер (другой процесс) — не дублируем.
    const marking = this.db.get<{ sending_at: number | null }>(
      sql`SELECT sending_at FROM digests WHERE date = ${dateIso}`,
    );
    if (marking?.sending_at !== null && marking?.sending_at !== undefined && nowMs - marking.sending_at < SENDING_TTL_MS) {
      return { sent: false, reason: 'sending', dateIso };
    }
    const { content } = this.preview(new Date(nowMs));
    const now = Date.now();
    this.db.run(sql`
      INSERT INTO digests (date, content, sent, created_at, sending_at)
      VALUES (${dateIso}, ${content}, 0, ${now}, ${now})
      ON CONFLICT(date) DO UPDATE SET content = excluded.content, sending_at = excluded.sending_at
    `);
    if (!this.transport.isConnected()) {
      this.clearSending(dateIso);
      this.log.warn({ dateIso }, 'digest due but WhatsApp offline, will retry');
      return { sent: false, reason: 'offline', dateIso };
    }
    try {
      await this.transport.sendDigestText(content);
    } catch (err) {
      this.clearSending(dateIso);
      this.log.warn({ err, dateIso }, 'digest send failed, will retry');
      return { sent: false, reason: 'send-failed', dateIso };
    }
    this.db.run(sql`UPDATE digests SET sent = 1, sent_at = ${Date.now()}, sending_at = NULL WHERE date = ${dateIso}`);
    this.log.info({ dateIso, reason }, 'digest sent to owner');
    return { sent: true, reason: 'sent', dateIso };
  }

  private clearSending(dateIso: string): void {
    this.db.run(sql`UPDATE digests SET sending_at = NULL WHERE date = ${dateIso}`);
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
