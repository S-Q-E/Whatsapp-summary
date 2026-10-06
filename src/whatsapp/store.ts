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
 * Гарантирует строку в chats и возвращает её id.
 * displayName — лучшее известное имя (push_name контакта/чата).
 */
export function ensureChat(
  db: Db,
  log: Logger,
  input: { jid: string; displayName?: string | null },
): number | null {
  const jid = normalizeJid(input.jid);
  if (!jid) return null;
  const t = now();
  const isGroup = jid.endsWith('@g.us') ? 1 : 0;
  try {
    db.run(sql`
      INSERT INTO chats (jid, display_name, is_group, created_at)
      VALUES (${jid}, ${input.displayName ?? null}, ${isGroup}, ${t})
      ON CONFLICT(jid) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, chats.display_name)
    `);
    return db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${jid}`)?.id ?? null;
  } catch (err) {
    log.warn({ err, jid }, 'chat ensure failed');
    return null;
  }
}

/**
 * Insert a message exactly once.
 * Relies on UNIQUE(whatsapp_message_id, chat_jid): re-deliveries are ignored.
 * chat_jid — всегда канонический (LID схлопываются в PN через jid_aliases).
 */
export function storeMessage(db: Db, log: Logger, p: ParsedMessage): StoreResult {
  const chatJid = resolveCanonical(db, p.chatJid);
  const senderJid = resolveCanonical(db, p.senderJid);
  const chatId = ensureChat(db, log, { jid: chatJid, displayName: p.senderName ?? p.pushName });
  try {
    const res = db.run(sql`
      INSERT INTO messages
        (whatsapp_message_id, chat_jid, chat_id, sender_jid, sender_name, direction, message_type, text, duration_sec, timestamp, is_from_me, created_at)
      VALUES
        (${p.whatsappMessageId}, ${chatJid}, ${chatId}, ${senderJid}, ${p.senderName}, ${p.direction},
         ${p.messageType}, ${p.text}, ${p.durationSec}, ${p.timestampMs}, ${p.isFromMe ? 1 : 0}, ${now()})
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

function isPnJid(normalizedJid: string): boolean {
  return normalizedJid.endsWith('@s.whatsapp.net');
}

/**
 * Канонический JID чата: если для JID известен алиас (обычно LID -> PN),
 * возвращаем канонику. Иначе сам JID. Всегда нормализован.
 */
export function resolveCanonical(db: Db, jid: string): string {
  const n = normalizeJid(jid);
  if (!n) return n;
  try {
    const row = db.get<{ canonical_jid: string }>(
      sql`SELECT canonical_jid FROM jid_aliases WHERE alias_jid = ${n}`,
    );
    return row?.canonical_jid ?? n;
  } catch {
    return n;
  }
}

/**
 * Записывает алиас aliasJid -> canonicalJid. Каноника: PN побеждает LID
 * (номер стабилен и совпадает с адресной книгой); иначе первый увиденный.
 * Идемпотентно: повтор и сам-на-себя — no-op.
 */
export function recordAlias(
  db: Db,
  log: Logger,
  input: { aliasJid: string; canonicalJid: string },
): void {
  const a = normalizeJid(input.aliasJid);
  const c = normalizeJid(input.canonicalJid);
  if (!a || !c || a === c) return;
  // PN всегда каноника: если алиас — PN, а каноника — LID, меняем направление
  if (isPnJid(a) && !isPnJid(c)) {
    recordAlias(db, log, { aliasJid: c, canonicalJid: a });
    return;
  }
  try {
    db.run(sql`
      INSERT INTO jid_aliases (alias_jid, canonical_jid, created_at)
      VALUES (${a}, ${c}, ${now()})
      ON CONFLICT(alias_jid) DO NOTHING
    `);
  } catch (err) {
    log.warn({ err, alias: a }, 'alias record failed');
  }
}

export type MergeResult = { messagesMoved: number; tasksMoved: number };

/**
 * Сливает чат fromJid в intoJid (поздний алиас): сообщения и задачи
 * перепривязываются, пустой чат удаляется. Всё в одной транзакции:
 * либо переехало всё, либо ничего.
 */
export function mergeChats(
  db: Db,
  log: Logger,
  input: { fromJid: string; intoJid: string },
): MergeResult {
  const from = normalizeJid(input.fromJid);
  const into = normalizeJid(input.intoJid);
  const empty: MergeResult = { messagesMoved: 0, tasksMoved: 0 };
  if (!from || !into || from === into) return empty;
  const fromRow = db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${from}`);
  if (!fromRow) {
    log.warn({ from, into }, 'merge skipped: source chat row missing');
    return empty;
  }
  // Целевого чата может ещё не быть (алиас узнали раньше сообщений) — создаём.
  let intoId = db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${into}`)?.id;
  if (intoId === undefined) {
    db.run(sql`
      INSERT INTO chats (jid, display_name, is_group, created_at)
      VALUES (${into}, NULL, ${into.endsWith('@g.us') ? 1 : 0}, ${now()})
    `);
    intoId = db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${into}`)?.id;
    if (intoId === undefined) {
      log.warn({ from, into }, 'merge skipped: cannot create target chat');
      return empty;
    }
  }
  const intoRow = { id: intoId };
  const res: MergeResult = { messagesMoved: 0, tasksMoved: 0 };
  db.run(sql`BEGIN`);
  try {
    // id сообщений уникальны в пределах аккаунта — конфликта
    // UNIQUE(whatsapp_message_id, chat_jid) при смене chat_jid быть не может.
    const m = db.run(sql`
      UPDATE messages SET chat_jid = ${into}, chat_id = ${intoRow.id}
      WHERE chat_id = ${fromRow.id}
    `);
    res.messagesMoved = Number(m.changes ?? 0);
    const t = db.run(sql`
      UPDATE tasks SET chat_jid = ${into}, chat_id = ${intoRow.id}
      WHERE chat_id = ${fromRow.id}
    `);
    res.tasksMoved = Number(t.changes ?? 0);
    db.run(sql`DELETE FROM chats WHERE id = ${fromRow.id}`);
    db.run(sql`COMMIT`);
  } catch (err) {
    try {
      db.run(sql`ROLLBACK`);
    } catch {
      // ignore rollback errors, исходная ошибка важнее
    }
    log.warn({ err, from, into }, 'chat merge failed, rolled back');
    return empty;
  }
  log.info({ from, into, ...res }, 'chats merged');
  return res;
}

/**
 * Применяет правку к исходному сообщению: новый текст + edited_at.
 * processed_at сбрасывается — смысл мог измениться, нужен переанализ.
 * Неизвестный target — пропуск (false), не падение.
 */
export function applyEdit(
  db: Db,
  log: Logger,
  input: { chatJid: string; targetId: string; text: string | null; timestampMs: number },
): boolean {
  const chatJid = resolveCanonical(db, input.chatJid);
  try {
    const res = db.run(sql`
      UPDATE messages SET text = ${input.text}, edited_at = ${input.timestampMs}, processed_at = NULL
      WHERE chat_jid = ${chatJid} AND whatsapp_message_id = ${input.targetId}
    `);
    if (Number(res.changes ?? 0) === 0) {
      log.warn({ chat: chatJid, target: input.targetId }, 'edit target not found, skipping');
      return false;
    }
    return true;
  } catch (err) {
    log.warn({ err, target: input.targetId }, 'edit apply failed');
    return false;
  }
}

/**
 * Применяет удаление: только deleted_at. Текст остаётся в локальной БД
 * (аудит), но в AI-контекст сообщение больше не попадает (фильтр по
 * deleted_at в loadPendingBundles). Неизвестный target — пропуск.
 */
export function applyRevoke(
  db: Db,
  log: Logger,
  input: { chatJid: string; targetId: string; timestampMs: number },
): boolean {
  const chatJid = resolveCanonical(db, input.chatJid);
  try {
    const res = db.run(sql`
      UPDATE messages SET deleted_at = ${input.timestampMs}
      WHERE chat_jid = ${chatJid} AND whatsapp_message_id = ${input.targetId}
    `);
    if (Number(res.changes ?? 0) === 0) {
      log.warn({ chat: chatJid, target: input.targetId }, 'revoke target not found, skipping');
      return false;
    }
    return true;
  } catch (err) {
    log.warn({ err, target: input.targetId }, 'revoke apply failed');
    return false;
  }
}
