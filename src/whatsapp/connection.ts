import fs from 'node:fs';
import NodeCache from '@cacheable/node-cache';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidNewsletter,
  isJidStatusBroadcast,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import type { Logger } from 'pino';
import { proto } from '@whiskeysockets/baileys';
import { env } from '../config/env.js';
import { baileysLogger } from '../config/logger.js';
import type { Db } from '../database/db.js';
import { normalizeJid } from '../utils/jid.js';
import { parseWAMessage, extractEditText, toMs, type ProtocolEvent } from './messageParser.js';
import {
  applyEdit,
  applyRevoke,
  ensureChat,
  mergeChats,
  recordAlias,
  resolveCanonical,
  storeMessage,
  upsertContact,
} from './store.js';

export type WhatsappClient = {
  sock: WASocket;
  stop: (reason?: string) => void;
};

/**
 * Hooks для внешних потребителей (WEB-сервер, SSE).
 * По умолчанию всё как раньше: QR в терминал, логи в pino.
 */
export type ClientHooks = {
  onQr?: (qr: string) => void;
  onConnected?: (info: { phone: string | null }) => void;
  onDisconnected?: (info: { code?: number; loggedOut: boolean }) => void;
};

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const defaultBackoff = (attempt: number): number =>
  Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);

/**
 * Супервизор переподключений (шаг 4.6): сериализует reconnect-цикл.
 * - флэппинг (несколько close подряд) даёт ровно один connect;
 * - stop() во время backoff отменяет pending connect (поколения);
 * - старый сокет явно закрывается перед заменой, протухшие сокеты
 *   состояние не двигают (проверка в вызывающем коде).
 */
export class ReconnectSupervisor {
  private connecting = false;
  private attempt = 0;
  private generation = 0;

  constructor(
    private readonly connect: () => Promise<void>,
    private readonly sleep: (ms: number) => Promise<void> = delay,
    private readonly backoff: (attempt: number) => number = defaultBackoff,
  ) {}

  async onClose(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    const gen = this.generation;
    try {
      await this.sleep(this.backoff(this.attempt));
      this.attempt += 1;
      if (gen !== this.generation) return; // stop() во время backoff
      await this.connect();
    } finally {
      this.connecting = false;
    }
  }

  onOpen(): void {
    this.attempt = 0;
  }

  stop(): void {
    this.generation += 1;
    this.connecting = false;
  }
}

/**
 * READ-ONLY client: connects, persists auth, stores messages.
 * Never calls sendMessage / any write API against WhatsApp.
 */
export async function startWhatsAppClient(opts: {
  db: Db;
  log: Logger;
  hooks?: ClientHooks;
  /** печатать QR в терминал (шаг 5: по умолчанию выкл, включается флагом QR_TERMINAL) */
  qrToTerminal?: boolean;
}): Promise<WhatsappClient> {
  const { db, log, hooks } = opts;
  const qrToTerminal = opts.qrToTerminal ?? false;

  fs.mkdirSync(env.authDir, { recursive: true });
  try {
    fs.chmodSync(env.authDir, 0o700);
  } catch {
    // chmod may fail on some filesystems — not fatal
  }

  // Survives socket restarts: retry counters + decrypt retry cache must not reset.
  const msgRetryCounterCache = new NodeCache() as never;
  // Minimal getMessage store for decrypt-retries / poll aggregation (in-memory, last ~500).
  const recentMessages = new Map<string, proto.IMessage>();
  const rememberMessage = (m: WAMessage): void => {
    if (m.key.id && m.key.remoteJid && m.message) {
      recentMessages.set(`${m.key.remoteJid}:${m.key.id}`, m.message);
      if (recentMessages.size > 500) {
        const first = recentMessages.keys().next().value;
        if (first) recentMessages.delete(first);
      }
    }
  };

  let stopped = false;
  let sock: WASocket | null = null;

  const supervisor = new ReconnectSupervisor(async () => {
    try {
      const prev = sock;
      try {
        prev?.end(undefined); // старый сокет точно мёртв перед заменой
      } catch {
        // ignore errors closing a dead socket
      }
      sock = await connectOnce();
    } catch (err) {
      log.error({ err }, 'reconnect failed (next close event will retry)');
    }
  });

  const connectOnce = async (): Promise<WASocket> => {
    const { state, saveCreds } = await useMultiFileAuthState(env.authDir);
    let version: ReturnType<typeof fetchLatestBaileysVersion> extends never
      ? never
      : [number, number, number];
    try {
      const v = await fetchLatestBaileysVersion();
      version = v.version as [number, number, number];
    } catch (err) {
      log.warn({ err }, 'fetchLatestBaileysVersion failed, using default version');
      version = [2, 3000, 1027934701];
    }

    const s = makeWASocket({
      version,
      logger: baileysLogger as never,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as never),
      },
      browser: Browsers.macOS(env.browserName),
      markOnlineOnConnect: env.markOnlineOnConnect,
      syncFullHistory: env.syncFullHistory,
      msgRetryCounterCache,
      shouldIgnoreJid: (jid) =>
        isJidBroadcast(jid) || isJidNewsletter(jid) || isJidStatusBroadcast(jid),
      getMessage: async (key) => {
        if (!key.remoteJid || !key.id) return undefined;
        return recentMessages.get(`${key.remoteJid}:${key.id}`);
      },
    });

    s.ev.on('creds.update', saveCreds);

    s.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        log.warn('QR received — scan with WhatsApp: Settings > Linked devices > Link a device');
        if (qrToTerminal) qrcode.generate(qr, { small: true });
        hooks?.onQr?.(qr);
      }

      if (connection === 'open') {
        supervisor.onOpen();
        log.info(
          { me: s.user?.id, lid: (s.user as { lid?: string } | undefined)?.lid },
          'whatsapp connected',
        );
        hooks?.onConnected?.({ phone: s.user?.id ?? null });
      }

      if (connection === 'close') {
        if (sock !== null && sock !== s) return; // протухший сокет: состояние не двигаем
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        hooks?.onDisconnected?.({ code, loggedOut });

        if (loggedOut) {
          // Session revoked on the phone side (device removed) or explicit logout.
          // Do NOT auto-reconnect: creds are invalid. Operator must delete AUTH_DIR and re-scan.
          log.error(
            'logged out (401). session invalid. delete AUTH_DIR and restart to re-scan QR. ' +
              `run: rm -rf ${env.authDir}`,
          );
          return;
        }

        if (stopped) {
          log.info({ code }, 'connection closed (client stopped, not reconnecting)');
          return;
        }

        // Всё остальное (restartRequired после QR, обрывы сети, 515/516, ...)
        // уходит в супервизор: один connect на флэппинг, backoff, отмена при stop.
        log.warn({ code }, 'connection closed, reconnecting via supervisor');
        void supervisor.onClose();
      }
    });

    /** PN<->LID пары из ключей сообщений (Baileys 7: remoteJidAlt/participantAlt). */
    const recordKeyAliases = (key: WAMessage['key']): void => {
      if (key.remoteJid && key.remoteJidAlt) {
        recordAlias(db, log, { aliasJid: key.remoteJid, canonicalJid: key.remoteJidAlt });
      }
      if (key.participant && key.participantAlt) {
        recordAlias(db, log, { aliasJid: key.participant, canonicalJid: key.participantAlt });
      }
    };

    const applyProtocolEvent = (ev: ProtocolEvent): void => {
      if (ev.kind === 'edit') {
        applyEdit(db, log, { chatJid: ev.chatJid, targetId: ev.targetId, text: ev.text, timestampMs: ev.timestampMs });
      } else {
        applyRevoke(db, log, { chatJid: ev.chatJid, targetId: ev.targetId, timestampMs: ev.timestampMs });
      }
    };

    const handleIncoming = (messages: WAMessage[], source: 'realtime' | 'history'): void => {
      for (const m of messages) {
        rememberMessage(m);
        recordKeyAliases(m.key);
        const parsed = parseWAMessage(m);
        if (!parsed) continue;
        if ('kind' in parsed) {
          // Правка/удаление в upsert-пути (дубль messages.update — идемпотентен).
          applyProtocolEvent(parsed);
          continue;
        }
        const chatJid = resolveCanonical(db, parsed.chatJid);
        // Keep an address book for the future AI secretary stage.
        upsertContact(db, log, {
          jid: chatJid,
          pushName: m.key.fromMe ? undefined : parsed.pushName,
        });
        if (!m.key.fromMe) {
          upsertContact(db, log, { jid: parsed.senderJid, pushName: parsed.pushName });
        }
        storeMessage(db, log, parsed);
      }
      if (messages.length > 0) {
        log.debug({ count: messages.length, source }, 'batch stored');
      }
    };

    // Realtime + backfill. We STORE both (idempotent); only 'notify' is realtime.
    s.ev.on('messages.upsert', ({ messages, type }) => {
      handleIncoming(messages, type === 'notify' ? 'realtime' : 'history');
    });

    // Full-history sync chunks (only when SYNC_FULL_HISTORY=true).
    s.ev.on('messaging-history.set', ({ messages, contacts, isLatest, progress }) => {
      log.info(
        { msgCount: messages.length, contactCount: contacts?.length ?? 0, progress, isLatest },
        'history sync chunk',
      );
      for (const c of contacts ?? []) {
        if (c.id) {
          upsertContact(db, log, { jid: c.id, name: c.name ?? null, pushName: null });
          recordContactAlias(c);
        }
      }
      handleIncoming(messages as WAMessage[], 'history');
    });

    s.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        if (c.id) {
          upsertContact(db, log, { jid: c.id, name: c.name ?? null, pushName: null });
          recordContactAlias(c);
        }
      }
    });

    // PN<->LID пары из адресной книги (Contact.id + phoneNumber/lid, Baileys 7).
    const recordContactAlias = (c: { id?: string; lid?: string; phoneNumber?: string }): void => {
      if (c.id && c.phoneNumber && c.id !== c.phoneNumber) {
        recordAlias(db, log, { aliasJid: c.id, canonicalJid: c.phoneNumber });
      }
      if (c.lid && c.phoneNumber && c.lid !== c.phoneNumber) {
        recordAlias(db, log, { aliasJid: c.lid, canonicalJid: c.phoneNumber });
      }
      if (c.id && c.lid && c.id !== c.lid) {
        recordAlias(db, log, { aliasJid: c.id, canonicalJid: c.lid });
      }
    };

    // Прямые PN<->LID пары от WhatsApp (шаг 4.3).
    s.ev.on('lid-mapping.update', (mapping) => {
      const pairs = Array.isArray(mapping) ? mapping : [mapping];
      for (const p of pairs) {
        if (p?.pn && p?.lid) recordAlias(db, log, { aliasJid: p.lid, canonicalJid: p.pn });
      }
    });

    // Правки и удаления приходят сюда (шаг 4.2): key.id = исходное сообщение.
    s.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        const chatRaw = key.remoteJid;
        const targetId = key.id;
        if (!chatRaw || !targetId) continue;
        const chatJid = resolveCanonical(db, normalizeJid(chatRaw));
        const edited = update.message?.editedMessage?.message;
        if (edited) {
          applyEdit(db, log, {
            chatJid,
            targetId,
            text: extractEditText(edited),
            timestampMs: toMs(update.messageTimestamp),
          });
          continue;
        }
        if (update.message === null || update.messageStubType !== undefined) {
          // REVOKE: message=null + stub; остальные stub-обновления игнорируем.
          if (update.message === null) {
            applyRevoke(db, log, { chatJid, targetId, timestampMs: Date.now() });
          }
        }
      }
    });

    // Имена групп для чатов (шаг 4.4).
    s.ev.on('groups.upsert', (groups) => {
      for (const g of groups) {
        if (g.id) ensureChat(db, log, { jid: g.id, displayName: g.subject ?? null });
      }
    });

    return s;
  };

  sock = await connectOnce();

  return {
    get sock(): WASocket {
      if (!sock) throw new Error('socket not initialized');
      return sock;
    },
    stop: (reason = 'shutdown') => {
      stopped = true;
      supervisor.stop();
      log.info({ reason }, 'closing whatsapp socket');
      try {
        sock?.end(undefined);
      } catch {
        // ignore errors during shutdown
      }
    },
  };
}
