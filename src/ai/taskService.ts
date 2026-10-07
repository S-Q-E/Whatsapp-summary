import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { env } from '../config/env.js';
import type { Db } from '../database/db.js';
import type { TaskRow, TaskStatus } from '../database/schema.js';
import { dayBounds } from '../digest/date.js';
import { normalizeJid } from '../utils/jid.js';
import { buildPromptContext } from './context.js';
import type {
  AIProvider,
  ClosedTaskSummary,
  ConversationInput,
  ConversationMessage,
  ExistingTaskSummary,
  ExtractedTask,
} from './types.js';
import { AIValidationError } from './validate.js';

export type ChatBundle = {
  chatJid: string;
  chatId: number;
  contactName: string | null;
  contactId: number | null;
  messages: ConversationMessage[];
  /** внутренние messages.id из контекста, ещё не обработанные */
  newMessageIds: number[];
};

export type ReconcileResult = {
  chatJid: string;
  created: TaskRow[];
  updated: TaskRow[];
  skipped: number;
  /** сколько волн анализа выполнено (ставит analyzeChat; у reconcileTasks нет) */
  waves?: number;
  /** остались ли необработанные после лимита волн (ставит analyzeChat) */
  hasMore?: boolean;
};

type MessageRowLite = {
  id: number;
  chat_jid: string;
  sender_name: string | null;
  direction: string;
  message_type: string;
  text: string | null;
  transcript: string | null;
  duration_sec: number | null;
  timestamp: number;
  whatsapp_message_id: string;
  is_from_me: number;
  processed_at: number | null;
};

export type PendingOptions = {
  /** scope по дню (CLI --date); без него — все необработанные */
  day?: Date;
  chatFilter?: string;
  /** последние N сообщений чата (default AI_CONTEXT_LIMIT) */
  limit?: number;
  /** окно контекста в днях назад (default AI_CONTEXT_DAYS) */
  maxAgeDays?: number;
  now?: number;
  /** JID владельца (default env.ownerJid): его чат в очередь не попадает */
  ownerJid?: string;
  /** true = анализировать даже чаты в бэкоффе (ручной CLI-прогон) */
  ignoreBackoff?: boolean;
  /** политика новых чатов (default env.analyzeNewChats) */
  newChats?: 'none' | 'direct' | 'all';
};

/** Маркер исходящих дайджестов — такие сообщения не анализируются. */
export const DIGEST_MARKER = '📋 Итоги дня';

/**
 * Нормализованный хеш названия — ТОЛЬКО для антидубля повторного прогона
 * в UNIQUE(source_message_id, title_hash). Никогда не используется для
 * поиска/сопоставления задач (идентификация — строго по id).
 */
export function titleHash(title: string): number {
  const norm = title.toLowerCase().replace(/\s+/g, ' ').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Все JID чата владельца: сам, каноника и известные алиасы. */
function ownerChatJids(db: Db, ownerJid: string | undefined): string[] {
  const raw = (ownerJid ?? env.ownerJid).trim();
  if (!raw) return [];
  const norm = raw.includes('@') ? normalizeJid(raw) : `${raw.replace(/\D/g, '')}@s.whatsapp.net`;
  if (!norm || norm === '@s.whatsapp.net') return [];
  const out = new Set<string>([norm]);
  try {
    // Владелец может быть как алиасом, так и каноникой — собираем обе стороны.
    const asAlias = db.get<{ canonical_jid: string }>(
      sql`SELECT canonical_jid FROM jid_aliases WHERE alias_jid = ${norm}`,
    )?.canonical_jid;
    if (asAlias) out.add(asAlias);
    for (const target of [norm, ...(asAlias ? [asAlias] : [])]) {
      for (const r of db.all<{ alias_jid: string }>(
        sql`SELECT alias_jid FROM jid_aliases WHERE canonical_jid = ${target}`,
      )) {
        out.add(r.alias_jid);
      }
    }
  } catch {
    // таблица может отсутствовать в очень старых БД — тогда только norm
  }
  return [...out];
}

/**
 * Инкрементальная выборка: только чаты с необработанными сообщениями,
 * от старых к новым (по самому старому необработанному). Исключаются:
 * удалённые/системные типы, игнор-чаты, бэкофф (кроме ручного прогона),
 * чат владельца и сообщения-дайджесты. Чаты без текста пропускаются.
 */
export function loadPendingBundles(db: Db, opts: PendingOptions = {}): ChatBundle[] {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? env.aiContextLimit;
  const cutoff = now - (opts.maxAgeDays ?? env.aiContextDays) * 86_400_000;
  let dayStart = -Infinity;
  let dayEnd = Infinity;
  if (opts.day) {
    const b = dayBounds(opts.day);
    dayStart = b.start;
    dayEnd = b.end;
  }
  const ownerJids = ownerChatJids(db, opts.ownerJid);
  const ownerList = ownerJids.length > 0 ? ownerJids : [''];
  // Молодые голосовые без транскрипта не трогаем: даём ASR время
  // (VOICE_GRACE_MIN); они не попадут ни в контекст, ни в пометку.
  const graceCutoff = now - env.voiceGraceMin * 60_000;
  const voiceGrace = sql`AND NOT (message_type = 'voice' AND transcript IS NULL AND timestamp > ${graceCutoff})`;
  // Бэкофф: чаты с next_attempt_at в будущем пропускаются (кроме ручного прогона).
  const backoffFilter = opts.ignoreBackoff
    ? sql``
    : sql`AND chat_jid NOT IN (
        SELECT ch.jid FROM chats ch
        INNER JOIN chat_analysis_state st ON st.chat_id = ch.id
        WHERE st.next_attempt_at IS NOT NULL AND st.next_attempt_at > ${now}
      )`;
  // Приватность новых чатов (ANALYZE_NEW_CHATS): явная строка ignored=0
  // всегда включает; ignored=1 всегда исключает (см. выше); без строки
  // решает политика: none — ничего нового, direct — только лички, all — всё.
  // Группа определяется по chats.is_group, при отсутствии строки — по суффиксу.
  const policy = opts.newChats ?? env.analyzeNewChats;
  let policyFilter = sql``;
  if (policy === 'none' || policy === 'direct') {
    const directBranch =
      policy === 'direct'
        ? sql`OR COALESCE(
            (SELECT c.is_group FROM chats c WHERE c.jid = messages.chat_jid),
            CASE WHEN messages.chat_jid LIKE '%@g.us' THEN 1 ELSE 0 END
          ) = 0`
        : sql``;
    policyFilter = sql`AND (
      EXISTS (SELECT 1 FROM chat_settings s JOIN chats c ON c.id = s.chat_id WHERE c.jid = messages.chat_jid AND s.ignored = 0)
      ${directBranch}
    )`;
  }

  const candidateChats = db.all<{ chat_jid: string }>(sql`
    SELECT chat_jid FROM messages
    WHERE processed_at IS NULL AND timestamp >= ${cutoff}
      AND timestamp >= ${dayStart} AND timestamp < ${dayEnd}
      AND deleted_at IS NULL
      AND message_type NOT IN ('reaction', 'protocol')
      AND NOT EXISTS (
        SELECT 1 FROM chat_settings s JOIN chats c ON c.id = s.chat_id
        WHERE c.jid = messages.chat_jid AND s.ignored = 1
      )
      AND chat_jid NOT IN (${sql.join(ownerList.map((j) => sql`${j}`), sql`, `)})
      AND NOT (is_from_me = 1 AND text LIKE ${'%' + DIGEST_MARKER + '%'})
      ${voiceGrace}
      ${policyFilter}
      ${backoffFilter}
    GROUP BY chat_jid
    ORDER BY MIN(timestamp) ASC
  `);

  const contacts = new Map<string, { id: number; name: string | null }>();
  for (const c of db.all<{ id: number; jid: string; push_name: string | null }>(
    sql`SELECT id, jid, push_name FROM contacts`,
  )) {
    contacts.set(c.jid, { id: c.id, name: c.push_name });
  }
  const chatIds = new Map<string, number>();
  for (const c of db.all<{ id: number; jid: string }>(sql`SELECT id, jid FROM chats`)) {
    chatIds.set(c.jid, c.id);
  }

  const bundles: ChatBundle[] = [];
  for (const { chat_jid: chatJid } of candidateChats) {
    if (opts.chatFilter && !chatJid.includes(opts.chatFilter)) continue;
    const chatId = chatIds.get(chatJid);
    if (chatId === undefined) continue;
    const rows = db.all<MessageRowLite>(sql`
      SELECT id, chat_jid, sender_name, direction, message_type, text, transcript, duration_sec, timestamp,
             whatsapp_message_id, is_from_me, processed_at
      FROM messages
      WHERE chat_jid = ${chatJid} AND timestamp >= ${cutoff}
        AND timestamp >= ${dayStart} AND timestamp < ${dayEnd}
        AND deleted_at IS NULL
        AND message_type NOT IN ('reaction', 'protocol')
        AND NOT (is_from_me = 1 AND text LIKE ${'%' + DIGEST_MARKER + '%'})
        AND NOT (message_type = 'voice' AND transcript IS NULL AND timestamp > ${graceCutoff})
      ORDER BY timestamp DESC LIMIT ${limit}
    `);
    rows.reverse(); // старые -> новые
    // Чат без какого-либо текстового содержимого (включая транскрипты) — анализировать нечего
    if (!rows.some((m) => (m.text && m.text.trim() !== '') || (m.transcript && m.transcript.trim() !== ''))) continue;
    const c = contacts.get(chatJid);
    bundles.push({
      chatJid,
      chatId,
      contactName: c?.name ?? null,
      contactId: c?.id ?? null,
      messages: rows.map((m) => ({
        id: m.id,
        direction: (m.is_from_me ? 'outgoing' : 'incoming') as 'incoming' | 'outgoing',
        senderName: m.sender_name,
        text: m.text,
        transcript: m.transcript,
        messageType: m.message_type,
        durationSec: m.duration_sec,
        timestamp: m.timestamp,
        whatsappMessageId: m.whatsapp_message_id,
      })),
      newMessageIds: rows.filter((m) => m.processed_at === null).map((m) => m.id),
    });
  }
  return bundles;
}

export function loadOpenTasks(db: Db, chatId: number): ExistingTaskSummary[] {
  return db.all<ExistingTaskSummary>(sql`
    SELECT id, title, status FROM tasks
    WHERE chat_id = ${chatId} AND status IN ('open', 'needs_review')
    ORDER BY id ASC
  `);
}

/** Закрытые за окно контекста — отдельным блоком «не создавай заново». */
export function loadRecentlyClosedTasks(db: Db, chatId: number, sinceMs: number): ClosedTaskSummary[] {
  return db.all<ClosedTaskSummary>(sql`
    SELECT id, title, status, source_message_id AS sourceMessageId FROM tasks
    WHERE chat_id = ${chatId} AND status IN ('done', 'cancelled')
      AND closed_at IS NOT NULL AND closed_at >= ${sinceMs}
    ORDER BY closed_at DESC
  `);
}

/**
 * Чаты с 5+ подряд ошибками анализа — показываются в /api/system/status
 * как needs_attention, но из очереди не убираются навсегда (бэкофф с cap).
 */
export function chatsNeedingAttention(db: Db): string[] {
  try {
    return db
      .all<{ jid: string }>(sql`
        SELECT ch.jid FROM chats ch
        INNER JOIN chat_analysis_state st ON st.chat_id = ch.id
        WHERE st.fail_count >= 5
      `)
      .map((r) => r.jid);
  } catch {
    return [];
  }
}

/** Фиксирует ошибку разбора чата: счётчик +1, следующая попытка позже. */
export function recordChatFailure(db: Db, chatId: number, nowMs: number): { failCount: number; nextAttemptAt: number } {
  const prev = db.get<{ fail_count: number }>(
    sql`SELECT fail_count FROM chat_analysis_state WHERE chat_id = ${chatId}`,
  );
  const failCount = (prev?.fail_count ?? 0) + 1;
  // 2, 4, 8, ... минут, максимум 1 час.
  const delayMs = Math.min(2 ** failCount, 60) * 60_000;
  const nextAttemptAt = nowMs + delayMs;
  db.run(sql`
    INSERT INTO chat_analysis_state (chat_id, fail_count, next_attempt_at, updated_at)
    VALUES (${chatId}, ${failCount}, ${nextAttemptAt}, ${nowMs})
    ON CONFLICT(chat_id) DO UPDATE SET
      fail_count = excluded.fail_count,
      next_attempt_at = excluded.next_attempt_at,
      updated_at = excluded.updated_at
  `);
  return { failCount, nextAttemptAt };
}

/** Успешный разбор сбрасывает бэкофф чата. */
export function resetChatState(db: Db, chatId: number, nowMs: number): void {
  db.run(sql`
    INSERT INTO chat_analysis_state (chat_id, fail_count, next_attempt_at, updated_at)
    VALUES (${chatId}, 0, NULL, ${nowMs})
    ON CONFLICT(chat_id) DO UPDATE SET fail_count = 0, next_attempt_at = NULL, updated_at = excluded.updated_at
  `);
}

function toDueMs(dueAt: string | null, log: Logger, title: string): number | null {
  if (!dueAt) return null;
  const ms = Date.parse(dueAt);
  if (Number.isNaN(ms)) {
    log.warn({ title, dueAt }, 'ignoring unparsable AI dueAt');
    return null;
  }
  return ms;
}

/** Проверяет, что сообщение-доказательство существует в этом чате. */
function checkMessage(db: Db, chatJid: string, messageId: number | null): number | null {
  if (messageId === null) return null;
  const row = db.get<{ id: number }>(sql`
    SELECT id FROM messages WHERE id = ${messageId} AND chat_jid = ${chatJid}
  `);
  return row?.id ?? null;
}

/**
 * Raw sql`` возвращает колонки как есть (snake_case) — drizzle маппит
 * в camelCase только через query builder. Маппим вручную, чтобы наружу
 * всегда выходил честный TaskRow.
 */
type TaskRowSnake = {
  id: number;
  chat_id: number;
  title: string;
  description: string | null;
  contact_id: number | null;
  chat_jid: string;
  source_message_id: number | null;
  title_hash: number | null;
  closed_by_message_id: number | null;
  status: string;
  due_at: number | null;
  due_text: string | null;
  confidence: number | null;
  model: string | null;
  prompt_version: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  manual: number;
};

function toTaskRow(r: TaskRowSnake): TaskRow {
  return {
    id: r.id,
    chatId: r.chat_id,
    title: r.title,
    description: r.description,
    contactId: r.contact_id,
    chatJid: r.chat_jid,
    sourceMessageId: r.source_message_id,
    titleHash: r.title_hash,
    closedByMessageId: r.closed_by_message_id,
    status: r.status as TaskStatus,
    dueAt: r.due_at,
    dueText: r.due_text,
    confidence: r.confidence,
    model: r.model,
    promptVersion: r.prompt_version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at,
    manual: r.manual,
  };
}

function getTaskById(db: Db, id: number): TaskRow | null {
  const row = db.get<TaskRowSnake>(sql`SELECT * FROM tasks WHERE id = ${id}`);
  return row ? toTaskRow(row) : null;
}

/**
 * Сверка результата AI с БД — идентификация ТОЛЬКО по id.
 * - create: новая строка, кроме двух случаев без вставки:
 *   а) точный повтор (тот же источник + тот же хеш названия) — молча skipped
 *      (идемпотентный ретрай, UNIQUE-индекс);
 *   б) источник уже разбирался раньше (у него есть задачи — например,
 *      сообщение правили и processed_at сброшен), а формулировка новая:
 *      новая строка НЕ создаётся, открытые задачи этого источника переводятся
 *      в needs_review (человек проверит). Сопоставления по тексту нет —
 *      только source_message_id. Закрытые задачи не трогаем (не воскрешаем).
 * - complete/cancel: переход задачи с tasks.id = taskId (строго в этом чате).
 *   Неизвестный id, чужой чат или уже закрытая задача → пропуск с warn.
 * Названия для идентификации не используются никогда.
 */
export function reconcileTasks(
  db: Db,
  log: Logger,
  bundle: ChatBundle,
  extracted: ExtractedTask[],
  provider: AIProvider,
  now: number,
): ReconcileResult {
  const res: ReconcileResult = { chatJid: bundle.chatJid, created: [], updated: [], skipped: 0 };
  const model = `${provider.name}:${provider.model}`;
  // Источники, разобранные ДО этого вызова (снимок — чтобы два обещания
  // из одного нового сообщения по-прежнему создавали две задачи).
  const knownSources = new Set(
    db
      .all<{ source_message_id: number }>(
        sql`SELECT source_message_id FROM tasks WHERE chat_id = ${bundle.chatId} AND source_message_id IS NOT NULL`,
      )
      .map((r) => r.source_message_id),
  );

  for (const t of extracted) {
    if (t.action === 'complete' || t.action === 'cancel') {
      const target =
        t.taskId === null
          ? null
          : db.get<{ id: number; status: string; manual: number }>(sql`
              SELECT id, status, manual FROM tasks WHERE id = ${t.taskId} AND chat_id = ${bundle.chatId}
            `);
      if (!target) {
        log.warn(
          { chat: bundle.chatJid, action: t.action, taskId: t.taskId },
          'AI references unknown task, skipping (never invent, never match by title)',
        );
        res.skipped += 1;
        continue;
      }
      if (target.status === 'done' || target.status === 'cancelled') {
        res.skipped += 1; // идемпотентность репрогона
        continue;
      }
      const closedBy = checkMessage(db, bundle.chatJid, t.messageId);
      const next = t.action === 'complete' ? 'done' : 'cancelled';
      if (target.manual === 1) {
        // Ручную задачу AI не перезаписывает: меняем только статус перехода
        // и closure-метаданные, title/description/due/confidence/model — нет.
        db.run(sql`
          UPDATE tasks SET status = ${next},
            closed_by_message_id = COALESCE(${closedBy}, closed_by_message_id),
            updated_at = ${now}, closed_at = ${now}
          WHERE id = ${target.id}
        `);
      } else {
        db.run(sql`
          UPDATE tasks SET status = ${next},
            description = COALESCE(${t.description}, description),
            confidence = ${t.confidence}, model = ${model},
            prompt_version = ${provider.promptVersion},
            closed_by_message_id = COALESCE(${closedBy}, closed_by_message_id),
            updated_at = ${now}, closed_at = ${now}
          WHERE id = ${target.id}
        `);
      }
      const row = getTaskById(db, target.id);
      if (row) res.updated.push(row);
      continue;
    }

    // create — новая строка, кроме повтора уже разобранного источника (см. шапку).
    // Хеш — НЕ идентификация: повтор того же сообщения с тем же текстом молча
    // пропускается; то же обещание новым сообщением или второе обещание
    // из того же НОВОГО сообщения — создаются.
    const sourceId = checkMessage(db, bundle.chatJid, t.messageId);
    const dueMs = toDueMs(t.dueAt, log, t.title);
    const hash = titleHash(t.title);
    if (sourceId !== null && knownSources.has(sourceId)) {
      const same = db.get<{ id: number }>(
        sql`SELECT id FROM tasks WHERE source_message_id = ${sourceId} AND title_hash = ${hash}`,
      );
      if (same) {
        // Точный повтор (ретрай без правок) — молча пропускаем.
        res.skipped += 1;
        continue;
      }
      // Источник уже разбирался, формулировка новая (правка/ретрай):
      // дубль не создаём, открытые задачи источника — на проверку человеку.
      const openIds = db
        .all<{ id: number }>(
          sql`SELECT id FROM tasks WHERE source_message_id = ${sourceId} AND chat_id = ${bundle.chatId} AND status = 'open'`,
        )
        .map((r) => r.id);
      for (const id of openIds) {
        db.run(sql`UPDATE tasks SET status = 'needs_review', updated_at = ${now} WHERE id = ${id}`);
        const row = getTaskById(db, id);
        if (row) res.updated.push(row);
      }
      log.warn(
        { chat: bundle.chatJid, source: sourceId, reviewed: openIds.length },
        'source already analyzed, create redirected to needs_review (no new task, never match by title)',
      );
      res.skipped += 1;
      continue;
    }
    const insert = db.run(sql`
      INSERT INTO tasks
        (chat_id, chat_jid, contact_id, title, description, source_message_id, title_hash,
         status, due_at, due_text, confidence, model, prompt_version,
         created_at, updated_at, closed_at)
      VALUES (${bundle.chatId}, ${bundle.chatJid}, ${bundle.contactId}, ${t.title}, ${t.description},
        ${sourceId}, ${hash}, ${t.status}, ${dueMs}, ${t.dueText},
        ${t.confidence}, ${model}, ${provider.promptVersion}, ${now}, ${now}, NULL)
      ON CONFLICT(source_message_id, title_hash) DO NOTHING
    `);
    if (Number(insert.changes ?? 0) === 0 && sourceId !== null) {
      // Тот же источник уже дал задачу (повторный прогон) — молча пропускаем.
      res.skipped += 1;
      continue;
    }
    const row = getTaskById(db, db.get<{ id: number }>(sql`SELECT last_insert_rowid() AS id`)!.id);
    if (row) res.created.push(row);
  }
  return res;
}

/**
 * Одно окно анализа: до priorLimit последних уже разобранных сообщений
 * ПЕРЕД первым необработанным (контекст, isContext=true) + до limit самых
 * старых необработанных (новые, isContext=false).
 * Фильтры те же, что в loadPendingBundles: без удалённых, reaction/protocol,
 * дайджестов и молодых голосовых без транскрипта (voiceGrace).
 * Контекст — только в пределах cutoff (AI_CONTEXT_DAYS).
 */
function loadChatWindow(
  db: Db,
  chatJid: string,
  limit: number,
  priorLimit: number,
  cutoff: number,
  nowMs: number,
): { window: ConversationMessage[]; newIds: number[] } {
  const graceCutoff = nowMs - env.voiceGraceMin * 60_000;
  const fresh = db.all<MessageRowLite>(sql`
    SELECT id, chat_jid, sender_name, direction, message_type, text, transcript, duration_sec, timestamp,
           whatsapp_message_id, is_from_me, processed_at
    FROM messages
    WHERE chat_jid = ${chatJid} AND processed_at IS NULL AND timestamp >= ${cutoff}
      AND deleted_at IS NULL
      AND message_type NOT IN ('reaction', 'protocol')
      AND NOT (is_from_me = 1 AND text LIKE ${'%' + DIGEST_MARKER + '%'})
      AND NOT (message_type = 'voice' AND transcript IS NULL AND timestamp > ${graceCutoff})
    ORDER BY timestamp ASC, id ASC LIMIT ${limit}
  `);
  if (fresh.length === 0) return { window: [], newIds: [] };
  const first = fresh[0]!;
  let prior: MessageRowLite[] = [];
  if (priorLimit > 0) {
    prior = db.all<MessageRowLite>(sql`
      SELECT id, chat_jid, sender_name, direction, message_type, text, transcript, duration_sec, timestamp,
             whatsapp_message_id, is_from_me, processed_at
      FROM messages
      WHERE chat_jid = ${chatJid} AND processed_at IS NOT NULL AND timestamp >= ${cutoff}
        AND (timestamp < ${first.timestamp} OR (timestamp = ${first.timestamp} AND id < ${first.id}))
        AND deleted_at IS NULL
        AND message_type NOT IN ('reaction', 'protocol')
        AND NOT (is_from_me = 1 AND text LIKE ${'%' + DIGEST_MARKER + '%'})
        AND NOT (message_type = 'voice' AND transcript IS NULL AND timestamp > ${graceCutoff})
      ORDER BY timestamp DESC, id DESC LIMIT ${priorLimit}
    `);
    prior.reverse(); // старые -> новые
  }
  const taskByMsg = new Map<number, number>();
  for (const r of db.all<{ source_message_id: number; id: number }>(
    sql`SELECT source_message_id, id FROM tasks WHERE chat_jid = ${chatJid} AND source_message_id IS NOT NULL`,
  )) {
    if (!taskByMsg.has(r.source_message_id)) taskByMsg.set(r.source_message_id, r.id);
  }
  const toMsg = (m: MessageRowLite, isContext: boolean): ConversationMessage => ({
    id: m.id,
    direction: (m.is_from_me ? 'outgoing' : 'incoming') as 'incoming' | 'outgoing',
    senderName: m.sender_name,
    text: m.text,
    transcript: m.transcript,
    messageType: m.message_type,
    durationSec: m.duration_sec,
    timestamp: m.timestamp,
    whatsappMessageId: m.whatsapp_message_id,
    existingTaskId: taskByMsg.get(m.id) ?? null,
    isContext,
  });
  return {
    window: [...prior.map((m) => toMsg(m, true)), ...fresh.map((m) => toMsg(m, false))],
    newIds: fresh.map((m) => m.id),
  };
}

/**
 * Полный цикл для одного чата: окна по порядку (старые -> новые),
 * но не больше maxWaves волн за вызов (бэклог разбирается за несколько
 * тиков; прогресс — не ошибка). Каждое окно = prior-контекст
 * (уже разобранные, isContext=true) + новые (isContext=false).
 * После УСПЕШНОГО окна помечаются ТОЛЬКО новые сообщения окна (по id);
 * контекстные не трогаются, молодые голосовые без транскрипта (voiceGrace)
 * в окно не попадают и не помечаются. Следующая волна берёт контекстом
 * хвост предыдущей (уже помечена обработанной). При ошибке провайдера
 * (включая провал retry) или отмене по signal пробрасываем исключение —
 * сообщения остаются необработанными и попадут в следующий прогон.
 * signal проверяется между волнами; провайдер получает его же и обязан
 * быстро завершиться.
 */
export type AnalyzeChatOptions = {
  /** волн за вызов (default MAX_WAVES_PER_TICK) */
  maxWaves?: number;
  /** отмена по таймауту чата в планировщике */
  signal?: AbortSignal;
};

export async function analyzeChat(
  db: Db,
  log: Logger,
  provider: AIProvider,
  bundle: ChatBundle,
  analyzedAt: number,
  opts: AnalyzeChatOptions = {},
): Promise<ReconcileResult> {
  const limit = env.aiContextLimit;
  const priorLimit = env.aiContextPrior;
  const maxWaves = Math.max(1, Math.floor(opts.maxWaves ?? env.maxWavesPerTick));
  const cutoff = analyzedAt - env.aiContextDays * 86_400_000;
  const sinceClosed = analyzedAt - env.aiContextDays * 86_400_000;
  const res: ReconcileResult = { chatJid: bundle.chatJid, created: [], updated: [], skipped: 0, waves: 0, hasMore: false };
  // Защита от зацикливания при гонках пометок.
  for (let wave = 0; wave < maxWaves; wave++) {
    opts.signal?.throwIfAborted();
    const { window, newIds } = loadChatWindow(db, bundle.chatJid, limit, priorLimit, cutoff, analyzedAt);
    if (window.length === 0 || newIds.length === 0) break;
    const ctx = buildPromptContext(
      { ...bundle, messages: window },
      loadOpenTasks(db, bundle.chatId),
      analyzedAt,
      env.timezone,
      loadRecentlyClosedTasks(db, bundle.chatId, sinceClosed),
    );
    const input: ConversationInput = ctx.input;
    let output;
    try {
      output = await provider.analyzeConversation(input, opts.signal ? { signal: opts.signal } : undefined);
    } catch (err) {
      if (err instanceof AIValidationError) {
        log.warn({ chat: bundle.chatJid }, 'model output invalid, single retry');
        output = await provider.analyzeConversation(input, opts.signal ? { signal: opts.signal } : undefined);
      } else {
        throw err;
      }
    }
    if (output.dropped && output.dropped.length > 0) {
      // Только индексы и ключи — без текста переписки.
      log.warn({ chat: bundle.chatJid, dropped: output.dropped }, 'model actions dropped (unknown refs)');
    }
    const r = reconcileTasks(db, log, bundle, output.tasks, provider, Date.now());
    res.created.push(...r.created);
    res.updated.push(...r.updated);
    res.skipped += r.skipped;
    res.waves = (res.waves ?? 0) + 1;
    // Помечаем только новые сообщения этого окна — контекстные не трогаем,
    // grace-голосовые сюда не входят и остаются необработанными.
    const marked = db.run(sql`
      UPDATE messages SET processed_at = ${Date.now()}
      WHERE chat_jid = ${bundle.chatJid} AND processed_at IS NULL
        AND id IN (${sql.join(newIds.map((id) => sql`${id}`), sql`, `)})
    `);
    if (Number(marked.changes ?? 0) === 0) break;
  }
  // Лимит волн исчерпан, а разбирать ещё есть — это прогресс, не ошибка:
  // вызывающий (планировщик) не растит fail_count и не включает бэкофф.
  if ((res.waves ?? 0) >= maxWaves) {
    res.hasMore = hasFreshUnprocessed(db, bundle.chatJid, cutoff, analyzedAt);
  }
  return res;
}

/** Остались ли разбираемые необработанные (те же фильтры, что у окна). */
function hasFreshUnprocessed(db: Db, chatJid: string, cutoff: number, nowMs: number): boolean {
  const graceCutoff = nowMs - env.voiceGraceMin * 60_000;
  const row = db.get<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM messages
    WHERE chat_jid = ${chatJid} AND processed_at IS NULL AND timestamp >= ${cutoff}
      AND deleted_at IS NULL
      AND message_type NOT IN ('reaction', 'protocol')
      AND NOT (is_from_me = 1 AND text LIKE ${'%' + DIGEST_MARKER + '%'})
      AND NOT (message_type = 'voice' AND transcript IS NULL AND timestamp > ${graceCutoff})
  `);
  return (row?.n ?? 0) > 0;
}
