import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { Logger } from 'pino';
import { env } from '../config/env.js';
import type { Db } from '../database/db.js';
import { startWhatsAppClient, type WhatsappClient } from './connection.js';
import { QrStore } from './qr-manager.js';
import { sendDigest } from './sendGuard.js';
import { StatusStore, type StatusSnapshot } from './status-store.js';

export type ManagerEvent = 'qr' | 'status';

export type QrEvent = { qr: string; updatedAt: number };

export type LogoutResult = { status: StatusSnapshot; serverRevoked: boolean };

/**
 * Отзыв сессии на стороне WhatsApp (шаг 6, п.2): sock.logout() разрывает
 * связь устройство-сервер. Никогда не бросает — при ошибке сети
 * возвращается false, и вызывающий стирает локальную сессию всё равно.
 */
export async function tryRevokeSession(sock: { logout(): Promise<unknown> }): Promise<boolean> {
  try {
    await sock.logout();
    return true;
  } catch {
    return false;
  }
}

/**
 * WhatsAppManager — владелец Baileys-соединения в серверном режиме.
 * Композиция над проверенным startWhatsAppClient: сам сокет, переподключения
 * и сохранение creds остаются внутри connection.ts, менеджер только
 * транслирует QR/статус наружу (SSE, REST) и управляет start/stop.
 *
 * Правила жизненного цикла:
 * - logout (401): auth уже мёртв на стороне сервера — стираем локальные
 *   файлы сессии, UI возвращается в "Scan QR";
 * - ручной disconnect: соединение закрывается, сессия сохраняется;
 * - всё остальное: автопереподключение внутри клиента, статус connecting.
 */
export class WhatsAppManager {
  private readonly events = new EventEmitter();
  private readonly qrStore = new QrStore();
  private readonly statusStore: StatusStore;
  private client: WhatsappClient | null = null;
  private manualStop = false;
  private starting = false;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly authDir: string = env.authDir,
  ) {
    this.statusStore = new StatusStore(() => this.hasSession());
    this.events.setMaxListeners(100);
  }

  /** Подписка для SSE. Возвращает unsubscribe. */
  on(event: ManagerEvent, cb: (data: QrEvent | StatusSnapshot) => void): () => void {
    this.events.on(event, cb);
    return () => {
      this.events.off(event, cb);
    };
  }

  snapshot(): StatusSnapshot {
    return this.statusStore.snapshot(this.qrStore.snapshot().qr !== null);
  }

  qrSnapshot(): { qr: string | null; updatedAt: number | null } {
    return this.qrStore.snapshot();
  }

  /** Сырая QR-строка для PNG-рендера (шаг 5). */
  qrString(): string | null {
    return this.qrStore.snapshot().qr;
  }

  hasSession(): boolean {
    try {
      const files = fs.readdirSync(this.authDir);
      return files.some((f) => f === 'creds.json');
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (this.client || this.starting) return;
    this.starting = true;
    this.manualStop = false;
    try {
      this.emitStatus('connecting');
      this.client = await startWhatsAppClient({
        db: this.db,
        log: this.log,
        qrToTerminal: false,
        hooks: {
          onQr: (qr) => {
            this.qrStore.set(qr);
            this.statusStore.onQr();
            const snap = this.qrStore.snapshot();
            this.events.emit('qr', { qr, updatedAt: snap.updatedAt });
            this.emitStatus();
          },
          onConnected: ({ phone }) => {
            this.qrStore.clear();
            this.statusStore.onConnected(phone);
            this.emitStatus();
          },
          onDisconnected: ({ loggedOut }) => {
            if (loggedOut) {
              this.wipeAuth();
              this.qrStore.clear();
              this.statusStore.onLoggedOut();
              this.emitStatus();
              return;
            }
            if (this.manualStop) {
              this.statusStore.onManualDisconnect();
            } else {
              // Внутренний автопереконнект клиента уже запланирован.
              this.statusStore.onConnecting();
            }
            this.emitStatus();
          },
        },
      });
    } finally {
      this.starting = false;
    }
  }

  /** Ручной disconnect: закрыть соединение, сессию сохранить. */
  disconnect(): StatusSnapshot {
    this.manualStop = true;
    this.qrStore.clear();
    try {
      this.client?.stop('manual disconnect via API');
    } catch {
      // ignore errors during manual disconnect
    }
    this.client = null;
    this.statusStore.onManualDisconnect();
    this.emitStatus();
    return this.snapshot();
  }

  /**
   * Полный logout (шаг 5, POST /api/whatsapp/logout): сначала отзываем сессию
   * на стороне WhatsApp через sock.logout(), затем закрываем соединение
   * и стираем локальную auth-сессию. При ошибке logout() локальная сессия
   * стирается всё равно, а в ответе serverRevoked=false. Следующий connect
   * покажет новый QR.
   */
  async logout(): Promise<LogoutResult> {
    this.manualStop = true;
    this.qrStore.clear();
    const serverRevoked = this.client ? await tryRevokeSession(this.client.sock) : false;
    try {
      this.client?.stop('manual logout via API');
    } catch {
      // ignore errors during manual logout
    }
    this.client = null;
    this.wipeAuth();
    this.statusStore.onLoggedOut();
    this.emitStatus();
    return { status: this.snapshot(), serverRevoked };
  }

  /** Переподключить после ручного disconnect или logged_out (после wipe — новый QR). */
  async connect(): Promise<StatusSnapshot> {
    this.client = null;
    await this.start();
    return this.snapshot();
  }

  stop(): void {
    this.manualStop = true;
    try {
      this.client?.stop('server shutdown');
    } catch {
      // ignore errors during shutdown
    }
    this.client = null;
  }

  /** Подключён ли сокет прямо сейчас (для дайджест-отправки). */
  isConnected(): boolean {
    return this.client !== null && this.statusStore.snapshot(false).status === 'connected';
  }

  /**
   * Отправка дайджеста владельцу (шаг 7): единственный путь исходящих
   * в WhatsApp, строго через sendGuard (только OWNER_JID).
   */
  async sendDigestText(text: string): Promise<void> {
    if (!this.client) throw new Error('WhatsApp не подключён — дайджест не отправлен');
    await sendDigest(this.client.sock, env.ownerJid, env.ownerJid, text);
  }

  private emitStatus(force?: 'connecting'): void {
    if (force) this.statusStore.onConnecting();
    this.events.emit('status', this.snapshot());
  }

  private wipeAuth(): void {
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true });
      this.log.warn({ authDir: this.authDir }, 'auth wiped after loggedOut — rescan QR to link again');
    } catch (err) {
      this.log.error({ err }, 'failed to wipe auth dir after loggedOut');
    }
  }
}
