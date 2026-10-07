import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../database/db.js';
import { chats, messages, tasks } from '../../database/schema.js';
import { env } from '../../config/env.js';
import { dayBounds } from '../../digest/date.js';

const OPEN_STATUSES = ['open', 'needs_review'] as const;

const StatusFilter = z.enum(['open', 'done', 'cancelled', 'needs_review']);

const TaskShape = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  dueAt: z.number().nullable(),
  dueText: z.string().nullable(),
  confidence: z.number().nullable(),
  manual: z.number(),
  model: z.string().nullable(),
  contactName: z.string().nullable(),
  chatJid: z.string(),
  chatId: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  closedAt: z.number().nullable(),
});

type TaskRow = z.infer<typeof TaskShape>;

/** Ранг статуса для сортировки «открытые сначала». */
function statusRank() {
  return sql<number>`CASE ${tasks.status} WHEN 'open' THEN 0 WHEN 'needs_review' THEN 1 WHEN 'done' THEN 2 ELSE 3 END`;
}

const CursorSchema = z
  .string()
  .regex(/^[0-3]:\d+$/, { error: 'cursor: формат "rank:id"' });

async function taskList(
  db: Db,
  where?: SQL | undefined,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{ items: TaskRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rank = statusRank();
  const conds: SQL[] = [];
  if (where) conds.push(where);
  if (opts.cursor !== undefined) {
    const parsed = CursorSchema.safeParse(opts.cursor);
    if (!parsed.success) throw new Error('cursor: формат "rank:id"');
    const [r, lastId] = parsed.data.split(':').map(Number);
    conds.push(sql`(${rank} > ${r} OR (${rank} = ${r} AND ${tasks.id} < ${lastId}))`);
  }
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      dueAt: tasks.dueAt,
      dueText: tasks.dueText,
      confidence: tasks.confidence,
      manual: tasks.manual,
      model: tasks.model,
      contactName: chats.displayName,
      chatJid: tasks.chatJid,
      chatId: tasks.chatId,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
      closedAt: tasks.closedAt,
    })
    .from(tasks)
    .leftJoin(chats, eq(tasks.chatId, chats.id))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(rank, desc(tasks.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const items = page.map((r) => ({
    ...r,
    contactName: r.contactName ?? r.chatJid,
  }));
  const nextCursor =
    rows.length > limit
      ? `${statusRankOf(items[items.length - 1]!.status)}:${items[items.length - 1]!.id}`
      : null;
  return { items, nextCursor };
}

function statusRankOf(status: string): number {
  switch (status) {
    case 'open':
      return 0;
    case 'needs_review':
      return 1;
    case 'done':
      return 2;
    default:
      return 3;
  }
}

const PatchSchema = z.object({
  status: z.enum(['open', 'done', 'cancelled', 'needs_review']).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  dueAt: z.string().nullable().optional().refine(
    (v) => v === undefined || v === null || !Number.isNaN(Date.parse(v)),
    { message: 'dueAt: ISO 8601 или null' },
  ),
});

const CreateSchema = z.object({
  chatId: z.number().int().positive().optional(),
  chatJid: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  dueAt: z.string().nullable().optional().refine(
    (v) => v === undefined || v === null || !Number.isNaN(Date.parse(v)),
    { message: 'dueAt: ISO 8601 или null' },
  ),
  dueText: z.string().trim().max(200).nullable().optional(),
});

const MsgShape = z.object({
  id: z.number(),
  direction: z.string(),
  senderName: z.string().nullable(),
  text: z.string().nullable(),
  transcript: z.string().nullable(),
  messageType: z.string(),
  timestamp: z.number(),
  isSource: z.boolean(),
  isClosing: z.boolean(),
});

export async function dashboardRoutes(app: FastifyInstance, db: Db, now: () => number = Date.now): Promise<void> {
  // Счётчики за локальный день (TIMEZONE) — через COUNT, без загрузки строк.
  app.get('/api/dashboard', async () => {
    const { start, end } = dayBounds(new Date(now()));
    const count = async (where: SQL | undefined): Promise<number> => {
      const q = db.select({ n: sql<number>`count(*)` }).from(tasks);
      const rows = where === undefined ? await q : await q.where(where);
      return rows[0]?.n ?? 0;
    };
    const [msgRows, openTasks, overdueTasks, doneToday, needsReview, activeTasks] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)` })
        .from(messages)
        .where(and(gte(messages.timestamp, start), lt(messages.timestamp, end))),
      count(eq(tasks.status, 'open')),
      count(and(eq(tasks.status, 'open'), lt(tasks.dueAt, start), isNotNull(tasks.dueAt))),
      count(and(eq(tasks.status, 'done'), gte(tasks.closedAt, start), lt(tasks.closedAt, end))),
      count(eq(tasks.status, 'needs_review')),
      count(inArray(tasks.status, ['open', 'needs_review'])),
    ]);
    return {
      messagesToday: msgRows[0]?.n ?? 0,
      openTasks,
      overdueTasks,
      doneToday,
      needsReview,
      activeTasks,
    };
  });

  // «Нужно внимание» считается на бэкенде общей функцией с дайджестом:
  // 🔴 просроченные (open, срок прошёл), 🟡 предстоящие открытые,
  // ✅ выполненные сегодня, ❓ на проверке. done сюда не попадает никогда.
  app.get('/api/dashboard/attention', async (_req, reply) => {
    const { start, end } = dayBounds(new Date(now()));
    const listed = async (where: SQL | undefined) =>
      (await taskList(db, where, { limit: 50 })).items;
    const [overdue, upcoming, doneToday, needsReview] = await Promise.all([
      listed(and(eq(tasks.status, 'open'), isNotNull(tasks.dueAt), lt(tasks.dueAt, start))),
      listed(
        and(
          eq(tasks.status, 'open'),
          or(isNull(tasks.dueAt), gte(tasks.dueAt, start)),
        ),
      ),
      listed(and(eq(tasks.status, 'done'), gte(tasks.closedAt, start), lt(tasks.closedAt, end))),
      listed(eq(tasks.status, 'needs_review')),
    ]);
    const parsed = z
      .object({
        overdue: z.array(TaskShape),
        upcoming: z.array(TaskShape),
        doneToday: z.array(TaskShape),
        needsReview: z.array(TaskShape),
      })
      .safeParse({ overdue, upcoming, doneToday, needsReview });
    if (!parsed.success) return reply.code(500).send({ error: 'internal contract violation' });
    return reply.send(parsed.data);
  });

  app.get('/api/tasks', async (req, reply) => {
    const q = req.query as { status?: string; chatId?: string; limit?: string; cursor?: string };
    const conds: SQL[] = [];
    if (q.status !== undefined) {
      const parsed = StatusFilter.safeParse(q.status);
      if (!parsed.success) return reply.code(400).send({ error: 'status: open|done|cancelled|needs_review' });
      conds.push(eq(tasks.status, parsed.data));
    }
    if (q.chatId !== undefined) {
      const id = Number(q.chatId);
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'chatId: положительное целое' });
      conds.push(eq(tasks.chatId, id));
    }
    let limit: number | undefined;
    if (q.limit !== undefined) {
      limit = Number(q.limit);
      if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
        return reply.code(400).send({ error: 'limit: целое 1..200' });
      }
    }
    try {
      const page = await taskList(db, conds.length > 0 ? and(...conds) : undefined, {
        limit,
        cursor: q.cursor,
      });
      const parsed = z
        .object({ items: z.array(TaskShape), nextCursor: z.string().nullable() })
        .safeParse(page);
      if (!parsed.success) return reply.code(500).send({ error: 'internal contract violation' });
      return reply.send(parsed.data);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('cursor:')) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post('/api/tasks', async (req, reply) => {
    const body = CreateSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'нужны chatId/chatJid и непустой title' });
    const { chatId, chatJid, title, description, dueAt, dueText } = body.data;
    let chat: { id: number; jid: string } | undefined;
    if (chatId !== undefined) {
      const rows = await db.select({ id: chats.id, jid: chats.jid }).from(chats).where(eq(chats.id, chatId));
      chat = rows[0];
    } else if (chatJid !== undefined) {
      const rows = await db.select({ id: chats.id, jid: chats.jid }).from(chats).where(eq(chats.jid, chatJid));
      chat = rows[0];
    }
    if (!chat) return reply.code(400).send({ error: 'чат не найден: нужен существующий chatId/chatJid' });
    const now = Date.now();
    const inserted = await db
      .insert(tasks)
      .values({
        chatId: chat.id,
        chatJid: chat.jid,
        title,
        description: description ?? null,
        status: 'open',
        dueAt: dueAt ? Date.parse(dueAt) : null,
        dueText: dueText ?? null,
        manual: 1,
        model: 'manual',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });
    const created = await taskList(db, eq(tasks.id, inserted[0]!.id));
    return reply.code(201).send(created.items[0]);
  });

  app.patch('/api/tasks/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'id: положительное целое' });
    const body = PatchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'тело: {status?, title?, description?, dueAt?}' });
    const existing = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id));
    if (existing.length === 0) return reply.code(404).send({ error: 'задача не найдена' });
    const now = Date.now();
    const patch: Partial<{ status: string; title: string; description: string | null; dueAt: number | null; closedAt: number | null; closedByMessageId: number | null; manual: number; updatedAt: number }> = {
      manual: 1,
      updatedAt: now,
    };
    if (body.data.title !== undefined) patch.title = body.data.title;
    if (body.data.description !== undefined) patch.description = body.data.description;
    if (body.data.dueAt !== undefined) patch.dueAt = body.data.dueAt ? Date.parse(body.data.dueAt) : null;
    if (body.data.status !== undefined) {
      patch.status = body.data.status;
      if (body.data.status === 'done' || body.data.status === 'cancelled') {
        patch.closedAt = now;
      } else {
        patch.closedAt = null;
        patch.closedByMessageId = null;
      }
    }
    await db.update(tasks).set(patch).where(eq(tasks.id, id));
    const updated = await taskList(db, eq(tasks.id, id));
    return reply.send(updated.items[0]);
  });

  app.get('/api/tasks/:id/context', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'id: положительное целое' });
    const found = await db
      .select({
        id: tasks.id,
        chatId: tasks.chatId,
        title: tasks.title,
        sourceMessageId: tasks.sourceMessageId,
        closedByMessageId: tasks.closedByMessageId,
      })
      .from(tasks)
      .where(eq(tasks.id, id));
    const task = found[0];
    if (!task) return reply.code(404).send({ error: 'задача не найдена' });
    // Окно ±5 считается в БД: 5 до (включая источник) + 5 после.
    // Удалённые не показываем.
    const selectBase = {
      id: messages.id,
      direction: messages.direction,
      senderName: messages.senderName,
      text: messages.text,
      transcript: messages.transcript,
      messageType: messages.messageType,
      timestamp: messages.timestamp,
    };
    type CtxRow = {
      id: number;
      direction: string;
      senderName: string | null;
      text: string | null;
      transcript: string | null;
      messageType: string;
      timestamp: number;
    };
    const notDeleted = isNull(messages.deletedAt);
    let window: CtxRow[];
    if (task.sourceMessageId !== null) {
      const before: CtxRow[] = await db
        .select(selectBase)
        .from(messages)
        .where(and(eq(messages.chatId, task.chatId), lte(messages.id, task.sourceMessageId), notDeleted))
        .orderBy(desc(messages.id))
        .limit(6);
      const after: CtxRow[] = await db
        .select(selectBase)
        .from(messages)
        .where(and(eq(messages.chatId, task.chatId), gt(messages.id, task.sourceMessageId), notDeleted))
        .orderBy(asc(messages.id))
        .limit(5);
      window = [...before.reverse(), ...after];
    } else {
      const last: CtxRow[] = await db
        .select(selectBase)
        .from(messages)
        .where(and(eq(messages.chatId, task.chatId), notDeleted))
        .orderBy(desc(messages.id))
        .limit(11);
      window = last.reverse();
    }
    const list = window.map((m) => ({
      ...m,
      isSource: task.sourceMessageId !== null && m.id === task.sourceMessageId,
      isClosing: task.closedByMessageId !== null && m.id === task.closedByMessageId,
    }));
    const parsed = z.array(MsgShape).safeParse(list);
    if (!parsed.success) return reply.code(500).send({ error: 'internal contract violation' });
    return reply.send({
      task: { id: task.id, title: task.title },
      messages: parsed.data,
    });
  });
}

export { OPEN_STATUSES };
