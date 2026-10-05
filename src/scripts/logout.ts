import fs from 'node:fs';
import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Full logout: revokes the session on WhatsApp side AND wipes local creds.
 * After this the phone's "Linked devices" entry disappears and the next
 * start will show a fresh QR. Use only when you really want to unlink.
 * Normal restarts / Ctrl+C do NOT need this.
 */
async function main(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(env.authDir);
  const sock = makeWASocket({ auth: state });
  sock.ev.on('creds.update', saveCreds);
  try {
    await sock.logout();
    logger.info('logged out from WhatsApp');
  } catch (err) {
    logger.warn({ err }, 'logout call failed (session may already be invalid)');
  } finally {
    try {
      sock.end(undefined);
    } catch {
      // ignore
    }
  }
  fs.rmSync(env.authDir, { recursive: true, force: true });
  logger.info({ authDir: env.authDir }, 'local auth dir removed; restart app to link again');
}

main().catch((err) => {
  logger.error({ err }, 'logout failed');
  process.exit(1);
});
