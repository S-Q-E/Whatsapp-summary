import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, lt, type SQL } from 'drizzle-orm';
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

async function taskList(db: Db, where?: SQL | undefined): Promise<TaskRow[]> {
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
    .where(where)
    .orderBy(desc(tasks.updatedAt))
    .limit(200);
  return rows.map((r) => ({
    ...r,
    contactName: r.contactName ?? r.chatJid,
  }));
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
  messageType: z.string(),
  timestamp: z.number(),
  isSource: z.boolean(),
  isClosing: z.boolean(),
});

export async function dashboardRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // Счётчики за локальный день (TIMEZONE).
  app.get('/api/dashboard', async () => {
    const { start, end } = dayBounds(new Date());
    const msgRows = await db
      .select({ timestamp: messages.timestamp })
      .from(messages)
      .where(and(gte(messages.timestamp, start), lt(messages.timestamp, end)));
    const openRows = await db
      .select({ id: tasks.id, status: tasks.status, dueAt: tasks.dueAt, closedAt: tasks.closedAt })
      .from(tasks)
      .where(inArray(tasks.status, ['open', 'needs_review', 'done']));
    const open = openRows.filter((t) => t.status === 'open' || t.status === 'needs_review');
    return {
      messagesToday: msgRows.length,
      openTasks: openRows.filter((t) => t.status === 'open').length,
      overdueTasks: openRows.filter((t) => t.status === 'open' && t.dueAt !== null && t.dueAt < start).length,
      doneToday: openRows.filter(
        (t) => t.status === 'done' && t.closedAt !== null && t.closedAt >= start && t.closedAt < end,
      ).length,
      needsReview: openRows.filter((t) => t.status === 'needs_review').length,
      activeTasks: open.length,
    };
  });

  app.get('/api/tasks', async (req, reply) => {
    const q = req.query as { status?: string; chatId?: string };
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
    const list = await taskList(db, conds.length > 0 ? and(...conds) : undefined);
    const parsed = z.array(TaskShape).safeParse(list);
    if (!parsed.success) return reply.code(500).send({ error: 'internal contract violation' });
    return reply.send(parsed.data);
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
    return reply.code(201).send(created[0]);
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
    return reply.send(updated[0]);
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
    const all = await db
      .select({
        id: messages.id,
        direction: messages.direction,
        senderName: messages.senderName,
        text: messages.text,
        messageType: messages.messageType,
        timestamp: messages.timestamp,
      })
      .from(messages)
      .where(and(eq(messages.chatId, task.chatId)))
      .orderBy(asc(messages.id));
    let window: typeof all = all;
    if (task.sourceMessageId !== null) {
      const idx = all.findIndex((m) => m.id === task.sourceMessageId);
      if (idx !== -1) window = all.slice(Math.max(0, idx - 5), idx + 6);
    } else {
      window = all.slice(-11);
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
