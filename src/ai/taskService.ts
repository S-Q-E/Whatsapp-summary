import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { env } from '../config/env.js';
import type { Db } from '../database/db.js';
import type { TaskRow, TaskStatus } from '../database/schema.js';
import { dayBounds } from '../digest/date.js';
import { buildPromptContext } from './context.js';
import type {
  AIProvider,
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
};

/**
 * Инкрементальная выборка (шаг 3): только чаты, где есть сообщения
 * с processed_at IS NULL. Контекст чата — последние N сообщений
 * за окно maxAgeDays (включая уже разобранные, для непрерывности);
 * помечаются только «новые». Чаты без текста пропускаются.
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

  const candidateChats = db.all<{ chat_jid: string }>(sql`
    SELECT DISTINCT chat_jid FROM messages
    WHERE processed_at IS NULL AND timestamp >= ${cutoff}
      AND timestamp >= ${dayStart} AND timestamp < ${dayEnd}
      AND deleted_at IS NULL
      AND message_type NOT IN ('reaction', 'protocol')
      AND chat_jid NOT IN (SELECT chat_jid FROM chat_settings WHERE ignored = 1)
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

/** Помечает сообщения разобранными — только после УСПЕШНОГО анализа. */
export function markProcessed(db: Db, messageIds: number[], now: number): void {
  for (const id of messageIds) {
    db.run(sql`UPDATE messages SET processed_at = ${now} WHERE id = ${id}`);
  }
}

export function loadOpenTasks(db: Db, chatId: number): ExistingTaskSummary[] {
  return db.all<ExistingTaskSummary>(sql`
    SELECT id, title, status FROM tasks
    WHERE chat_id = ${chatId} AND status IN ('open', 'needs_review')
    ORDER BY id ASC
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
 * - create: всегда новая строка. Антидубль — только по source_message_id
 *   (UNIQUE-индекс + ON CONFLICT DO NOTHING): повторный прогон того же
 *   сообщения ничего не создаёт. Закрытые задачи НЕ блокируют новые.
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

    // create — всегда новая строка; антидубль только по источнику
    const sourceId = checkMessage(db, bundle.chatJid, t.messageId);
    const dueMs = toDueMs(t.dueAt, log, t.title);
    const insert = db.run(sql`
      INSERT INTO tasks
        (chat_id, chat_jid, contact_id, title, description, source_message_id,
         status, due_at, due_text, confidence, model, prompt_version,
         created_at, updated_at, closed_at)
      VALUES (${bundle.chatId}, ${bundle.chatJid}, ${bundle.contactId}, ${t.title}, ${t.description},
        ${sourceId}, ${t.status}, ${dueMs}, ${t.dueText},
        ${t.confidence}, ${model}, ${provider.promptVersion}, ${now}, ${now}, NULL)
      ON CONFLICT(source_message_id) DO NOTHING
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
 * Полный цикл для одного чата: контекст -> AI (один retry при невалидном
 * JSON) -> сверка -> пометка сообщений разобранными. При ошибке провайдера
 * (включая провал retry) пробрасываем исключение — сообщения остаются
 * необработанными и попадут в следующий прогон.
 */
export async function analyzeChat(
  db: Db,
  log: Logger,
  provider: AIProvider,
  bundle: ChatBundle,
  analyzedAt: number,
): Promise<ReconcileResult> {
  const ctx = buildPromptContext(bundle, loadOpenTasks(db, bundle.chatId), analyzedAt, env.timezone);
  const input: ConversationInput = ctx.input;
  let output;
  try {
    output = await provider.analyzeConversation(input);
  } catch (err) {
    if (err instanceof AIValidationError) {
      log.warn({ chat: bundle.chatJid }, 'model output invalid, single retry');
      output = await provider.analyzeConversation(input);
    } else {
      throw err;
    }
  }
  if (output.dropped && output.dropped.length > 0) {
    // Только индексы и ключи — без текста переписки.
    log.warn({ chat: bundle.chatJid, dropped: output.dropped }, 'model actions dropped (unknown refs)');
  }
  const res = reconcileTasks(db, log, bundle, output.tasks, provider, Date.now());
  markProcessed(db, bundle.newMessageIds, Date.now());
  return res;
}
