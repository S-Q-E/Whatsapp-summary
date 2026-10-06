import { sql } from 'drizzle-orm';
import type { Db } from '../database/db.js';
import { dayBounds, formatDayLabel, formatDeadlineDate, toIsoLocalDate } from './date.js';
import type { DailyDigest, DigestTaskItem } from './types.js';

type TaskLite = {
  id: number;
  chatJid: string;
  title: string;
  status: string;
  dueAt: number | null;
  dueText: string | null;
  confidence: number | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
};

function loadAllTasks(db: Db): TaskLite[] {
  // Алиасы сразу в camelCase: raw sql`` имён не маппит (см. taskService.toTaskRow).
  return db.all<TaskLite>(sql`
    SELECT id, chat_jid AS chatJid, title, status, due_at AS dueAt,
           due_text AS dueText, confidence,
           created_at AS createdAt, updated_at AS updatedAt,
           closed_at AS closedAt
    FROM tasks
  `);
}

function loadContactNames(db: Db): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of db.all<{ jid: string; push_name: string | null; name: string | null }>(
    sql`SELECT jid, push_name, name FROM contacts`,
  )) {
    map.set(c.jid, c.push_name ?? c.name ?? c.jid);
  }
  return map;
}

/** Текстовая фраза срока указывает на сегодня (а не «завтра утром»). */
function deadlineTextMeansToday(deadlineText: string | null): boolean {
  if (!deadlineText) return false;
  const t = deadlineText.toLowerCase();
  if (/завтра|послезавтра|след\.|понедельник|вторник|сред[ауы]|четверг|пятниц[ауы]|суббот[ауы]|воскресенье/i.test(t)) {
    return false;
  }
  return /сегодня|срочно|вечер|утр|дн[её]м|сейчас|к вечеру/i.test(t);
}

/**
 * 🔴 Требует внимания: открытая задача, которую нельзя откладывать —
 * срок прошёл или истекает в день отчёта, либо статус needs_review
 * (AI не уверен — нужно уточнение врача).
 */
function isAttention(
  t: TaskLite,
  dayStart: number,
  dayEnd: number,
): boolean {
  if (t.status === 'needs_review') return true;
  if (t.status !== 'open') return false;
  if (t.dueAt !== null) return t.dueAt <= dayEnd;
  const touchedToday = t.createdAt >= dayStart || t.updatedAt >= dayStart;
  return touchedToday && deadlineTextMeansToday(t.dueText);
}

/** Человекочитаемый срок для карточки задачи. */
function deadlineLabel(t: TaskLite, dayStart: number, dayEnd: number): string | null {
  if (t.dueText) return t.dueText;
  if (t.dueAt === null) return null;
  if (t.dueAt >= dayStart && t.dueAt < dayEnd) return 'сегодня';
  return formatDeadlineDate(t.dueAt);
}

/**
 * Строит данные дневного дайджеста. Только чтение БД, только метаданные
 * задач — текст переписок сюда не попадает и дальше не уходит.
 *
 * Состав секций:
 * - completed: выполненные именно в день отчёта (closed_at в дне);
 * - attention: открытые, срочные по правилу isAttention (включая старые просроченные);
 * - promised: остальные открытые (open, срок в будущем или без срока).
 */
export function buildDigest(db: Db, day: Date): DailyDigest {
  const { start, end } = dayBounds(day);
  const tasks = loadAllTasks(db);
  const names = loadContactNames(db);

  const toItem = (t: TaskLite): DigestTaskItem => ({
    id: t.id,
    chatJid: t.chatJid,
    contactName: names.get(t.chatJid) ?? t.chatJid,
    title: t.title,
    status: t.status as DigestTaskItem['status'],
    deadlineLabel: deadlineLabel(t, start, end),
    dueAt: t.dueAt ?? null,
    confidence: t.confidence,
  });

  const open = tasks.filter((t) => t.status === 'open' || t.status === 'needs_review');
  const attention = open.filter((t) => isAttention(t, start, end)).map(toItem);
  const attentionIds = new Set(attention.map((t) => t.id));
  const promised = open.filter((t) => !attentionIds.has(t.id)).map(toItem);
  const completed = tasks
    .filter((t) => t.status === 'done' && t.closedAt !== null && t.closedAt >= start && t.closedAt < end)
    .map(toItem);

  const byId = (a: DigestTaskItem, b: DigestTaskItem): number => a.id - b.id;
  attention.sort(byId);
  promised.sort(byId);
  completed.sort(byId);

  const incoming = db.get<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM messages
    WHERE direction = 'incoming' AND timestamp >= ${start} AND timestamp < ${end}
  `);

  const unheardVoice = db.get<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM messages
    WHERE message_type = 'voice' AND processed_at IS NULL AND deleted_at IS NULL
  `);

  const withoutDeadline = open.filter((t) => t.dueAt === null).length;
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const t of open) {
    const c = t.confidence ?? 0.6; // нет оценки = средний уровень
    if (c >= 0.8) high += 1;
    else if (c >= 0.5) medium += 1;
    else low += 1;
  }

  return {
    dateIso: toIsoLocalDate(day),
    dateLabel: formatDayLabel(day),
    sections: { attention, promised, completed },
    stats: {
      incomingMessages: incoming?.n ?? 0,
      activeTasks: open.length,
      completedTasks: completed.length,
      tasksWithoutDeadline: withoutDeadline,
      confidenceHigh: high,
      confidenceMedium: medium,
      confidenceLow: low,
      unheardVoice: unheardVoice?.n ?? 0,
    },
  };
}
