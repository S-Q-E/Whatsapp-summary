import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { logStoredMessage } from '../config/logger.js';
import type { Db } from '../database/db.js';
import { normalizeJid, phoneFromJid } from '../utils/jid.js';
import type { ParsedMessage } from './messageParser.js';

export type StoreResult = { stored: boolean; isNew: boolean };

function now(): number {
  return Date.now();
}

/** Upsert a contact row by normalized JID. Cheap, idempotent. */
export function upsertContact(
  db: Db,
  log: Logger,
  input: { jid: string; name?: string | null; pushName?: string | null },
): void {
  const jid = normalizeJid(input.jid);
  if (!jid) return;
  const t = now();
  const phone = phoneFromJid(jid);
  try {
    db.run(sql`
      INSERT INTO contacts (jid, phone, name, push_name, created_at, updated_at)
      VALUES (${jid}, ${phone}, ${input.name ?? null}, ${input.pushName ?? null}, ${t}, ${t})
      ON CONFLICT(jid) DO UPDATE SET
        phone = COALESCE(excluded.phone, contacts.phone),
        name = COALESCE(excluded.name, contacts.name),
        push_name = COALESCE(excluded.push_name, contacts.push_name),
        updated_at = excluded.updated_at
    `);
  } catch (err) {
    log.warn({ err, jid }, 'contact upsert failed');
  }
}

/**
 * Insert a message exactly once.
 * Relies on UNIQUE(whatsapp_message_id, chat_jid): re-deliveries are ignored.
 */
export function storeMessage(db: Db, log: Logger, p: ParsedMessage): StoreResult {
  try {
    const res = db.run(sql`
      INSERT INTO messages
        (whatsapp_message_id, chat_jid, sender_jid, sender_name, direction, message_type, text, timestamp, is_from_me, created_at)
      VALUES
        (${p.whatsappMessageId}, ${p.chatJid}, ${p.senderJid}, ${p.senderName}, ${p.direction},
         ${p.messageType}, ${p.text}, ${p.timestampMs}, ${p.isFromMe ? 1 : 0}, ${now()})
      ON CONFLICT(whatsapp_message_id, chat_jid) DO NOTHING
    `);
    const isNew = Number(res.changes ?? 0) > 0;
    logStoredMessage(log, {
      chatJid: p.chatJid,
      senderJid: p.senderJid,
      direction: p.direction,
      messageType: p.messageType,
      whatsappMessageId: p.whatsappMessageId,
      isNew,
      textLength: p.text?.length ?? 0,
      textPreview: p.text,
    });
    return { stored: true, isNew };
  } catch (err) {
    log.warn(
      { err, chat: p.chatJid, msgId: p.whatsappMessageId },
      'message insert failed',
    );
    return { stored: false, isNew: false };
  }
}
