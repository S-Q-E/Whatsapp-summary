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

/** Upsert a contact row by normalized JID. Cheap, idempotent.
 * push_name пишется только для личных jid: у групповых jid (@g.us)
 * pushName чужой реплики не должен становиться именем чата/контакта.
 */
export function upsertContact(
  db: Db,
  log: Logger,
  input: { jid: string; name?: string | null; pushName?: string | null },
): void {
  const jid = normalizeJid(input.jid);
  if (!jid) return;
  const pushName = jid.endsWith('@g.us') ? null : (input.pushName ?? null);
  const t = now();
  const phone = phoneFromJid(jid);
  try {
    db.run(sql`
      INSERT INTO contacts (jid, phone, name, push_name, created_at, updated_at)
      VALUES (${jid}, ${phone}, ${input.name ?? null}, ${pushName}, ${t}, ${t})
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

/** Источник имени чата: пишут только group-meta (группы) и incoming-message (лички). */
export type ChatNameSource = 'group-meta' | 'incoming-message' | 'chat-message' | 'own-message';

/**
 * Гарантирует строку в chats и возвращает её id.
 * - группы (@g.us): display_name пишется ТОЛЬКО из group-meta
 *   (groups.upsert / groupMetadata subject), реплики его не трогают;
 * - лички: display_name пишется только pushName'ом ВХОДЯЩИХ сообщений,
 *   собственные сообщения имя не меняют.
 */
export function ensureChat(
  db: Db,
  log: Logger,
  input: { jid: string; displayName?: string | null; source: ChatNameSource },
): number | null {
  const jid = normalizeJid(input.jid);
  if (!jid) return null;
  const t = now();
  const isGroup = jid.endsWith('@g.us') ? 1 : 0;
  const writable =
    (isGroup === 1 && input.source === 'group-meta') ||
    (isGroup === 0 && input.source === 'incoming-message');
  try {
    db.run(sql`
      INSERT INTO chats (jid, display_name, is_group, created_at)
      VALUES (${jid}, ${writable ? (input.displayName ?? null) : null}, ${isGroup}, ${t})
      ON CONFLICT(jid) DO UPDATE SET
        display_name = CASE
          WHEN ${writable ? 1 : 0} = 1 THEN COALESCE(excluded.display_name, chats.display_name)
          ELSE chats.display_name
        END
    `);
    return db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${jid}`)?.id ?? null;
  } catch (err) {
    log.warn({ err, jid }, 'chat ensure failed');
    return null;
  }
}

/** Ручная установка флага игнорирования чата (UI, тесты). */
export function setChatIgnored(db: Db, chatId: number, ignored: 0 | 1): void {
  db.run(sql`
    INSERT INTO chat_settings (chat_id, ignored, updated_at)
    VALUES (${chatId}, ${ignored}, ${now()})
    ON CONFLICT(chat_id) DO UPDATE SET ignored = excluded.ignored, updated_at = excluded.updated_at
  `);
}

/** Читает флаг игнорирования чата (false, если строки нет). */
export function isChatIgnored(db: Db, chatId: number): boolean {
  try {
    const row = db.get<{ ignored: number }>(
      sql`SELECT ignored FROM chat_settings WHERE chat_id = ${chatId}`,
    );
    return (row?.ignored ?? 0) === 1;
  } catch {
    return false;
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
  // Имя чата — только из входящих личных сообщений; своё и групповые реплики не пишут.
  const chatId = ensureChat(db, log, {
    jid: chatJid,
    displayName: p.isFromMe ? undefined : (p.senderName ?? p.pushName),
    source: chatJid.endsWith('@g.us') ? 'chat-message' : p.isFromMe ? 'own-message' : 'incoming-message',
  });
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

export type AliasRecord = { isNew: boolean; aliasJid: string; canonicalJid: string };

/**
 * Записывает алиас aliasJid -> canonicalJid. Каноника: PN побеждает LID
 * (номер стабилен и совпадает с адресной книгой); иначе первый увиденный.
 * Возвращает флаг «новая пара» и итоговое направление — по нему вызывающий
 * запускает слияние чатов. Повтор и сам-на-себя — no-op (isNew false).
 */
export function recordAlias(
  db: Db,
  log: Logger,
  input: { aliasJid: string; canonicalJid: string },
): AliasRecord {
  const noop = { isNew: false, aliasJid: normalizeJid(input.aliasJid), canonicalJid: normalizeJid(input.canonicalJid) };
  const a = noop.aliasJid;
  const c = noop.canonicalJid;
  if (!a || !c || a === c) return noop;
  // PN всегда каноника: если алиас — PN, а каноника — LID, меняем направление
  if (isPnJid(a) && !isPnJid(c)) {
    return recordAlias(db, log, { aliasJid: c, canonicalJid: a });
  }
  try {
    const res = db.run(sql`
      INSERT INTO jid_aliases (alias_jid, canonical_jid, created_at)
      VALUES (${a}, ${c}, ${now()})
      ON CONFLICT(alias_jid) DO NOTHING
    `);
    const isNew = Number(res.changes ?? 0) > 0;
    return { isNew, aliasJid: a, canonicalJid: c };
  } catch (err) {
    log.warn({ err, alias: a }, 'alias record failed');
    return noop;
  }
}

/**
 * Связка «алиас → слияние» для connection.ts: при новой паре сливает
 * чаты (алиасный в канонический), иначе no-op (null). Вызывать только
 * для свежих пар — внутри всё равно идемпотентно.
 */
export function recordAliasAndMerge(
  db: Db,
  log: Logger,
  input: { aliasJid: string; canonicalJid: string },
): MergeResult | null {
  const rec = recordAlias(db, log, input);
  if (!rec.isNew) return null;
  const fromRow = db.get<{ id: number }>(
    sql`SELECT id FROM chats WHERE jid = ${rec.aliasJid}`,
  );
  if (!fromRow) return null; // сливать нечего — чата-источника нет
  return mergeChats(db, log, { fromJid: rec.aliasJid, intoJid: rec.canonicalJid });
}

export type MergeResult = { messagesMoved: number; tasksMoved: number };
export type MergeStep = 'dedupe' | 'move' | 'settings' | 'contacts' | 'cleanup';
export type MergeOptions = {
  /** тестовый хук: бросить ошибку после указанного шага (проверка отката) */
  failAfter?: MergeStep;
};

/**
 * Сливает чат fromJid в intoJid (поздний алиас). Всё в одной транзакции:
 * либо переехало всё, либо ничего.
 * - сообщения-дубли (тот же wamid уже есть в into) удаляются, а ссылки
 *   задач source/closed_by перепривязываются на выжившее сообщение;
 * - остальные сообщения и задачи переезжают (chat_id + chat_jid);
 * - флаг ignored = OR из обоих чатов;
 * - контакты: push_name/name/phone алиасного jid подтягиваются в
 *   канонический при пустотах, затем алиасная строка удаляется;
 * - пустой чат удаляется.
 */
export function mergeChats(
  db: Db,
  log: Logger,
  input: { fromJid: string; intoJid: string },
  opts: MergeOptions = {},
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
  const failAfter = opts.failAfter;
  const maybeFail = (step: MergeStep): void => {
    if (failAfter === step) throw new Error(`inject: failAfter ${step}`);
  };
  db.run(sql`BEGIN`);
  try {
    // 1. Дедупликация: тот же wamid в обоих чатах — дубль удаляем,
    // ссылки задач перепривязываем на выжившее сообщение.
    const dups = db.all<{ dup_id: number; keep_id: number }>(sql`
      SELECT m1.id AS dup_id, m2.id AS keep_id
      FROM messages m1 JOIN messages m2 ON m2.whatsapp_message_id = m1.whatsapp_message_id
      WHERE m1.chat_id = ${fromRow.id} AND m2.chat_id = ${intoRow.id}
    `);
    for (const d of dups) {
      db.run(sql`UPDATE tasks SET source_message_id = ${d.keep_id} WHERE source_message_id = ${d.dup_id}`);
      db.run(sql`UPDATE tasks SET closed_by_message_id = ${d.keep_id} WHERE closed_by_message_id = ${d.dup_id}`);
      db.run(sql`DELETE FROM messages WHERE id = ${d.dup_id}`);
    }
    maybeFail('dedupe');
    // 2. Переезд оставшихся сообщений и задач.
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
    maybeFail('move');
    // 3. Настройки: ignored = OR.
    const fromIgn = db.get<{ ignored: number }>(
      sql`SELECT ignored FROM chat_settings WHERE chat_id = ${fromRow.id}`,
    )?.ignored ?? 0;
    const intoIgn = db.get<{ ignored: number }>(
      sql`SELECT ignored FROM chat_settings WHERE chat_id = ${intoRow.id}`,
    )?.ignored ?? 0;
    if (fromIgn === 1 || intoIgn === 1) {
      db.run(sql`
        INSERT INTO chat_settings (chat_id, ignored, updated_at)
        VALUES (${intoRow.id}, 1, ${now()})
        ON CONFLICT(chat_id) DO UPDATE SET ignored = 1, updated_at = excluded.updated_at
      `);
    }
    db.run(sql`DELETE FROM chat_settings WHERE chat_id = ${fromRow.id}`);
    maybeFail('settings');
    // 4. Контакты: подтягиваем пустые поля канонического из алиасного,
    // затем алиасную строку удаляем (маппинг живёт в jid_aliases).
    const fromC = db.get<{ name: string | null; push_name: string | null; phone: string | null }>(
      sql`SELECT name, push_name, phone FROM contacts WHERE jid = ${from}`,
    );
    if (fromC) {
      db.run(sql`
        INSERT INTO contacts (jid, phone, name, push_name, created_at, updated_at)
        VALUES (${into}, ${fromC.phone}, ${fromC.name}, ${fromC.push_name}, ${now()}, ${now()})
        ON CONFLICT(jid) DO UPDATE SET
          phone = COALESCE(contacts.phone, excluded.phone),
          name = COALESCE(contacts.name, excluded.name),
          push_name = COALESCE(contacts.push_name, excluded.push_name),
          updated_at = excluded.updated_at
      `);
      db.run(sql`DELETE FROM contacts WHERE jid = ${from}`);
    }
    maybeFail('contacts');
    // 5. Пустой чат удаляем.
    db.run(sql`DELETE FROM chats WHERE id = ${fromRow.id}`);
    maybeFail('cleanup');
    db.run(sql`COMMIT`);
  } catch (err) {
    try {
      db.run(sql`ROLLBACK`);
    } catch {
      // ignore rollback errors, исходная ошибка важнее
    }
    if (failAfter) throw err;
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
 * Применяет удаление: ставит deleted_at И сразу зачищает
 * text/transcript/sender_name (независимо от RETENTION_DAYS — удалённое
 * не должно лежать в БД открытым текстом). Строка остаётся (аудит связей
 * source/closed_by), но в AI-контекст сообщение больше не попадает
 * (фильтр по deleted_at в loadPendingBundles). Неизвестный target — пропуск.
 */
export function applyRevoke(
  db: Db,
  log: Logger,
  input: { chatJid: string; targetId: string; timestampMs: number },
): boolean {
  const chatJid = resolveCanonical(db, input.chatJid);
  try {
    const res = db.run(sql`
      UPDATE messages SET deleted_at = ${input.timestampMs},
        text = NULL, transcript = NULL, sender_name = NULL
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
