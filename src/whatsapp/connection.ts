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
import { parseWAMessage } from './messageParser.js';
import { storeMessage, upsertContact } from './store.js';

export type WhatsappClient = {
  sock: WASocket;
  stop: (reason?: string) => void;
};

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * READ-ONLY client: connects, persists auth, stores messages.
 * Never calls sendMessage / any write API against WhatsApp.
 */
export async function startWhatsAppClient(opts: { db: Db; log: Logger }): Promise<WhatsappClient> {
  const { db, log } = opts;

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
  let attempt = 0;

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
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        attempt = 0;
        log.info(
          { me: s.user?.id, lid: (s.user as { lid?: string } | undefined)?.lid },
          'whatsapp connected',
        );
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;

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

        // Everything else (restartRequired after QR scan, network loss, 515/516 stream
        // errors, app-state sync conflicts, etc.) -> reconnect with backoff.
        attempt += 1;
        const waitMs = Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);
        log.warn({ code, attempt, waitMs }, 'connection closed, reconnecting');
        await delay(waitMs);
        if (stopped) return;
        try {
          sock = await connectOnce();
        } catch (err) {
          log.error({ err }, 'reconnect failed');
        }
      }
    });

    const handleIncoming = (messages: WAMessage[], source: 'realtime' | 'history'): void => {
      for (const m of messages) {
        rememberMessage(m);
        const parsed = parseWAMessage(m);
        if (!parsed) continue;
        // Keep an address book for the future AI secretary stage.
        upsertContact(db, log, {
          jid: parsed.chatJid,
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
        if (c.id) upsertContact(db, log, { jid: c.id, name: c.name ?? null, pushName: null });
      }
      handleIncoming(messages as WAMessage[], 'history');
    });

    s.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        if (c.id) upsertContact(db, log, { jid: c.id, name: c.name ?? null, pushName: null });
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
      log.info({ reason }, 'closing whatsapp socket');
      try {
        sock?.end(undefined);
      } catch {
        // ignore errors during shutdown
      }
    },
  };
}
