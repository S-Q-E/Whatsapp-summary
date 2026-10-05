import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../database/db.js';
import type { TaskRow, TaskStatus } from '../database/schema.js';
import type {
  AIProvider,
  ConversationInput,
  ConversationMessage,
  ExistingTaskSummary,
  ExtractedTask,
} from './types.js';

export type ChatBundle = {
  chatJid: string;
  contactName: string | null;
  contactId: number | null;
  messages: ConversationMessage[];
};

export type ReconcileResult = {
  chatJid: string;
  created: TaskRow[];
  updated: TaskRow[];
  skipped: number;
};

/** Нормализация названия для сопоставления «та же задача». */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"„“'.,!?:;()[\]-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Начало локального дня в ms epoch. */
export function startOfLocalDay(d: Date): number {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

type MessageRowLite = {
  chat_jid: string;
  sender_name: string | null;
  direction: string;
  message_type: string;
  text: string | null;
  timestamp: number;
  whatsapp_message_id: string;
  is_from_me: number;
};

/** Сообщения за локальный день, сгруппированные по chat_jid (только чаты с текстом). */
export function loadDayBundles(db: Db, day: Date): ChatBundle[] {
  const start = startOfLocalDay(day);
  const end = start + 24 * 60 * 60 * 1000;
  const rows = db.all<MessageRowLite>(sql`
    SELECT chat_jid, sender_name, direction, message_type, text, timestamp,
           whatsapp_message_id, is_from_me
    FROM messages
    WHERE timestamp >= ${start} AND timestamp < ${end}
    ORDER BY chat_jid ASC, timestamp ASC
  `);

  const contacts = new Map<string, { id: number; name: string | null }>();
  for (const c of db.all<{ id: number; jid: string; push_name: string | null }>(
    sql`SELECT id, jid, push_name FROM contacts`,
  )) {
    contacts.set(c.jid, { id: c.id, name: c.push_name });
  }

  const byChat = new Map<string, MessageRowLite[]>();
  for (const r of rows) {
    const list = byChat.get(r.chat_jid) ?? [];
    list.push(r);
    byChat.set(r.chat_jid, list);
  }

  const bundles: ChatBundle[] = [];
  for (const [chatJid, list] of byChat) {
    if (!list.some((m) => m.text && m.text.trim() !== '')) continue; // только медиа — анализировать нечего
    const c = contacts.get(chatJid);
    bundles.push({
      chatJid,
      contactName: c?.name ?? null,
      contactId: c?.id ?? null,
      messages: list.map((m) => ({
        direction: (m.is_from_me ? 'outgoing' : 'incoming') as 'incoming' | 'outgoing',
        senderName: m.sender_name,
        text: m.text,
        messageType: m.message_type,
        timestamp: m.timestamp,
        whatsappMessageId: m.whatsapp_message_id,
      })),
    });
  }
  return bundles;
}

export function loadOpenTasks(db: Db, chatJid: string): ExistingTaskSummary[] {
  return db.all<ExistingTaskSummary>(sql`
    SELECT id, title, status FROM tasks
    WHERE chat_jid = ${chatJid} AND status IN ('pending', 'uncertain')
    ORDER BY id ASC
  `);
}

function toDeadlineMs(deadline: string | null, log: Logger, title: string): number | null {
  if (!deadline) return null;
  const ms = Date.parse(deadline);
  if (Number.isNaN(ms)) {
    log.warn({ title, deadline }, 'ignoring unparsable AI deadline');
    return null;
  }
  return ms;
}

/**
 * Raw sql`` возвращает колонки как есть (snake_case) — drizzle маппит
 * в camelCase только через query builder. Маппим вручную, чтобы наружу
 * всегда выходил честный TaskRow.
 */
type TaskRowSnake = {
  id: number;
  chat_jid: string;
  contact_id: number | null;
  title: string;
  description: string | null;
  source_message_id: string | null;
  deadline: number | null;
  deadline_text: string | null;
  status: string;
  confidence: number | null;
  model: string | null;
  prompt_version: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

function toTaskRow(r: TaskRowSnake): TaskRow {
  return {
    id: r.id,
    chatJid: r.chat_jid,
    contactId: r.contact_id,
    title: r.title,
    description: r.description,
    sourceMessageId: r.source_message_id,
    deadline: r.deadline,
    deadlineText: r.deadline_text,
    status: r.status as TaskStatus,
    confidence: r.confidence,
    model: r.model,
    promptVersion: r.prompt_version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

function getTaskById(db: Db, id: number): TaskRow | null {
  const row = db.get<TaskRowSnake>(sql`SELECT * FROM tasks WHERE id = ${id}`);
  return row ? toTaskRow(row) : null;
}

/** Совпадает ли AI-название с уже известной задачей чата. */
function findMatch(open: ExistingTaskSummary[], title: string): ExistingTaskSummary | null {
  const n = normalizeTitle(title);
  if (!n) return null;
  for (const t of open) {
    const e = normalizeTitle(t.title);
    if (e === n || e.includes(n) || n.includes(e)) return t;
  }
  return null;
}

/**
 * Сверка результата AI с БД: создать новые, обновить известные
 * (главное — pending -> completed), выполненные/отменённые не воскрешать.
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
    const open = loadOpenTasks(db, bundle.chatJid);
    const match = t.action === 'update' && t.matchTitle ? findMatch(open, t.matchTitle) : null;
    const dup = match ?? (t.action === 'create' ? findMatch(open, t.title) : null);

    if (dup) {
      const completedAt = t.status === 'completed' ? now : null;
      db.run(sql`
        UPDATE tasks SET status = ${t.status},
          description = COALESCE(${t.description}, description),
          deadline = COALESCE(${toDeadlineMs(t.deadline, log, t.title)}, deadline),
          deadline_text = COALESCE(${t.deadlineText}, deadline_text),
          confidence = ${t.confidence}, model = ${model},
          prompt_version = ${provider.promptVersion},
          updated_at = ${now}, completed_at = ${completedAt}
        WHERE id = ${dup.id}
      `);
      const row = getTaskById(db, dup.id);
      if (row) res.updated.push(row);
      continue;
    }

    if (t.action === 'update') {
      // AI ссылается на неизвестную задачу — создаём как новую, чтобы не потерять.
      log.warn({ chat: bundle.chatJid, matchTitle: t.matchTitle }, 'AI update without known task, creating');
    }

    // Не воскрешать закрытые: если такое название уже completed/cancelled — пропуск.
    // Сравнение в JS: SQLite LOWER() не работает с кириллицей.
    const closedTitles = db.all<{ title: string }>(sql`
      SELECT title FROM tasks
      WHERE chat_jid = ${bundle.chatJid} AND status IN ('completed', 'cancelled')
    `);
    const nt = normalizeTitle(t.title);
    const isClosed = closedTitles.some((c) => {
      const e = normalizeTitle(c.title);
      return e !== '' && nt !== '' && (e === nt || e.includes(nt) || nt.includes(e));
    });
    if (isClosed) {
      // Закрытая задача с таким названием уже есть (в т.ч. повторный отчёт
      // о том же выполнении при репрогоне анализа) — не дублировать.
      res.skipped += 1;
      continue;
    }

    const deadlineMs = toDeadlineMs(t.deadline, log, t.title);
    db.run(sql`
      INSERT INTO tasks
        (chat_jid, contact_id, title, description, source_message_id, deadline,
         deadline_text, status, confidence, model, prompt_version, created_at, updated_at, completed_at)
      VALUES (${bundle.chatJid}, ${bundle.contactId}, ${t.title}, ${t.description},
        ${t.sourceMessageId}, ${deadlineMs}, ${t.deadlineText}, ${t.status},
        ${t.confidence}, ${model}, ${provider.promptVersion}, ${now}, ${now},
        ${t.status === 'completed' ? now : null})
    `);
    const row = getTaskById(db, db.get<{ id: number }>(sql`SELECT last_insert_rowid() AS id`)!.id);
    if (row) res.created.push(row);
  }
  return res;
}

/** Полный цикл для одного чата: контекст -> AI -> сверка с БД. */
export async function analyzeChat(
  db: Db,
  log: Logger,
  provider: AIProvider,
  bundle: ChatBundle,
  analyzedAt: number,
): Promise<ReconcileResult> {
  const input: ConversationInput = {
    chatJid: bundle.chatJid,
    contactName: bundle.contactName,
    messages: bundle.messages,
    existingTasks: loadOpenTasks(db, bundle.chatJid),
    analyzedAt,
  };
  const output = await provider.analyzeConversation(input);
  return reconcileTasks(db, log, bundle, output.tasks, provider, Date.now());
}

/** Совместимость статусов со схемой (защита от будущих опечаток). */
export function assertStatus(s: string): asserts s is TaskStatus {
  if (!['pending', 'completed', 'cancelled', 'uncertain'].includes(s)) {
    throw new Error(`Unknown task status: ${s}`);
  }
}
