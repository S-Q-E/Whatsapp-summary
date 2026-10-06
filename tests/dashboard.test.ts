import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { openTestDb } from './db.js';
import { createApp } from '../src/app.js';
import { reconcileTasks } from '../src/ai/taskService.js';
import { MockProvider } from '../src/ai/providers/mock.js';
import { startOfDay } from '../src/utils/time.js';

const log = pino({ level: 'silent' });
const TZ = 'Asia/Almaty';
type TestDb = ReturnType<typeof openTestDb>['db'];

const waStub = {
  snapshot: () => ({
    status: 'connected' as const,
    phone: '7700@s.whatsapp.net',
    connectedAt: 1,
    lastSeen: 2,
    hasSession: true,
    qrAvailable: false,
  }),
  qrString: () => null,
  on: () => () => {},
  disconnect: () => ({} as never),
  connect: async () => ({} as never),
  logout: async () => ({} as never),
};
const schedStub = {
  metricsSnapshot: () => ({
    lastRunAt: null, lastDurationMs: 0, lastChats: 0, lastCreated: 0,
    lastUpdated: 0, lastSkipped: 0, lastError: null, runCount: 0,
    providerErrorCount: 0, lastProviderError: null, running: false,
  }),
  start: () => {},
  stop: () => {},
};
const qrPng = async (_s: string | null): Promise<string | null> => null;

function seedDay(db: TestDb, dayStart: number): { chatId: number } {
  const H = 3_600_000;
  db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES ('a@s.whatsapp.net', 'Айгуль', 0, 1)`);
  const chatId = db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = 'a@s.whatsapp.net'`)!.id;
  db.run(sql`INSERT INTO contacts (jid, phone, push_name, created_at, updated_at) VALUES ('a@s.whatsapp.net', '1', 'Айгуль', 1, 1)`);
  const msgs: Array<[string, string, number]> = [
    ['m1', 'incoming', dayStart + H],
    ['m2', 'outgoing', dayStart + 2 * H],
    ['m3', 'incoming', dayStart - H], // вчера — не в счётчике дня
  ];
  for (const [w, dir, ts] of msgs) {
    db.run(sql`INSERT INTO messages (whatsapp_message_id, chat_jid, chat_id, direction, message_type, text, timestamp, is_from_me, created_at)
      VALUES (${w}, 'a@s.whatsapp.net', ${chatId}, ${dir}, 'text', 't', ${ts}, ${dir === 'outgoing' ? 1 : 0}, ${ts})`);
  }
  const t: Array<[string, string, number | null, number]> = [
    // title, status, dueAt, createdAt
    ['Просрочка', 'open', dayStart - H, dayStart - 2 * H],
    ['Сегодня', 'open', dayStart + 5 * H, dayStart],
    ['Без срока', 'open', null, dayStart],
    ['Сомнительная', 'needs_review', null, dayStart],
    ['Готовая', 'done', null, dayStart - 2 * H],
  ];
  t.forEach(([title, status, due, created], i) => {
    const closed = status === 'done' ? dayStart + H : null;
    db.run(sql`INSERT INTO tasks (chat_id, chat_jid, title, status, due_at, confidence, model, created_at, updated_at, closed_at, manual)
      VALUES (${chatId}, 'a@s.whatsapp.net', ${title}, ${status}, ${due}, 0.9, 'm', ${created}, ${created}, ${closed}, 0)`);
  });
  return { chatId };
}

describe('шаг 6: dashboard API', () => {
  it('GET /api/dashboard — счётчики за локальный день', async () => {
    const { db, close } = openTestDb();
    try {
      const dayStart = startOfDay(new Date('2026-10-06T12:00:00+05:00'), TZ);
      seedDay(db, dayStart);
      const app = await createApp({ db, log, wa: waStub, scheduler: schedStub, qrPng });
      const res = await app.inject({ method: 'GET', url: '/api/dashboard' });
      assert.equal(res.statusCode, 200);
      const b = res.json();
      assert.equal(b.messagesToday, 2);
      assert.equal(b.openTasks, 3);
      assert.equal(b.overdueTasks, 1);
      assert.equal(b.doneToday, 1);
      assert.equal(b.needsReview, 1);
      await app.close();
    } finally {
      close();
    }
  });

  it('GET /api/tasks?status=open и ?chatId= — фильтры', async () => {
    const { db, close } = openTestDb();
    try {
      const dayStart = startOfDay(new Date('2026-10-06T12:00:00+05:00'), TZ);
      const { chatId } = seedDay(db, dayStart);
      const app = await createApp({ db, log, wa: waStub, scheduler: schedStub, qrPng });
      const open = await app.inject({ method: 'GET', url: '/api/tasks?status=open' });
      assert.equal(open.json().length, 3);
      assert.ok(open.json().every((t: { status: string }) => t.status === 'open'));
      assert.ok(open.json()[0].contactName === 'Айгуль');
      const byChat = await app.inject({ method: 'GET', url: `/api/tasks?chatId=${chatId}` });
      assert.equal(byChat.json().length, 5);
      const bad = await app.inject({ method: 'GET', url: '/api/tasks?status=bogus' });
      assert.equal(bad.statusCode, 400);
      await app.close();
    } finally {
      close();
    }
  });

  it('PATCH /tasks/:id ставит manual=true; POST создаёт ручную задачу', async () => {
    const { db, close } = openTestDb();
    try {
      const dayStart = startOfDay(new Date('2026-10-06T12:00:00+05:00'), TZ);
      const { chatId } = seedDay(db, dayStart);
      const app = await createApp({ db, log, wa: waStub, scheduler: schedStub, qrPng });
      const taskId = db.get<{ id: number }>(sql`SELECT id FROM tasks WHERE title = 'Сегодня'`)!.id;
      const patch = await app.inject({
        method: 'PATCH', url: `/api/tasks/${taskId}`,
        payload: { status: 'done', title: 'Сегодня (уточнила)' },
      });
      assert.equal(patch.statusCode, 200);
      assert.equal(patch.json().manual, 1);
      assert.equal(patch.json().status, 'done');
      assert.equal(patch.json().title, 'Сегодня (уточнила)');
      const notFound = await app.inject({ method: 'PATCH', url: '/api/tasks/9999', payload: { status: 'done' } });
      assert.equal(notFound.statusCode, 404);
      const created = await app.inject({
        method: 'POST', url: '/api/tasks',
        payload: { chatId, title: 'Позвонить самой' },
      });
      assert.equal(created.statusCode, 201);
      assert.equal(created.json().manual, 1);
      assert.equal(created.json().status, 'open');
      const noTitle = await app.inject({ method: 'POST', url: '/api/tasks', payload: { chatId } });
      assert.equal(noTitle.statusCode, 400);
      await app.close();
    } finally {
      close();
    }
  });

  it('GET /api/tasks/:id/context — ±5 вокруг источника с флагами', async () => {
    const { db, close } = openTestDb();
    try {
      const dayStart = startOfDay(new Date('2026-10-06T12:00:00+05:00'), TZ);
      const { chatId } = seedDay(db, dayStart);
      for (let i = 4; i <= 13; i++) {
        const ts = dayStart + i * 1000;
        db.run(sql`INSERT INTO messages (whatsapp_message_id, chat_jid, chat_id, direction, message_type, text, timestamp, is_from_me, created_at)
          VALUES (${`w${i}`}, 'a@s.whatsapp.net', ${chatId}, 'incoming', 'text', ${`текст ${i}`}, ${ts}, 0, ${ts})`);
      }
      const srcId = db.get<{ id: number }>(sql`SELECT id FROM messages WHERE whatsapp_message_id = 'w8'`)!.id;
      const closeId = db.get<{ id: number }>(sql`SELECT id FROM messages WHERE whatsapp_message_id = 'w10'`)!.id;
      db.run(sql`INSERT INTO tasks (chat_id, chat_jid, title, status, source_message_id, closed_by_message_id, created_at, updated_at)
        VALUES (${chatId}, 'a@s.whatsapp.net', 'С контекстом', 'done', ${srcId}, ${closeId}, 1, 1)`);
      const taskId = db.get<{ id: number }>(sql`SELECT last_insert_rowid() AS id`)!.id;
      const app = await createApp({ db, log, wa: waStub, scheduler: schedStub, qrPng });
      const res = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/context` });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.messages.length, 11);
      const src = body.messages.find((m: { isSource: boolean }) => m.isSource);
      const cls = body.messages.find((m: { isClosing: boolean }) => m.isClosing);
      assert.ok(src && cls);
      assert.equal(src.text, 'текст 8');
      assert.equal(cls.text, 'текст 10');
      // в списке задач текстов переписок нет
      const list = await app.inject({ method: 'GET', url: '/api/tasks' });
      assert.ok(!JSON.stringify(list.json()).includes('текст 8'));
      await app.close();
    } finally {
      close();
    }
  });
});

describe('шаг 6: manual-флаг защищает от перезаписи AI', () => {
  it('AI complete по manual-задаче меняет статус, но не трогает title/due', () => {
    const { db, close } = openTestDb();
    try {
      const dayStart = startOfDay(new Date('2026-10-06T12:00:00+05:00'), TZ);
      const { chatId } = seedDay(db, dayStart);
      const msgId = db.get<{ id: number }>(sql`SELECT id FROM messages WHERE whatsapp_message_id = 'm1'`)!.id;
      const repId = db.get<{ id: number }>(sql`SELECT id FROM messages WHERE whatsapp_message_id = 'm2'`)!.id;
      const provider = new MockProvider();
      const bundle = { chatJid: 'a@s.whatsapp.net', chatId, contactName: 'Айгуль', contactId: null, messages: [], newMessageIds: [] };
      const c = reconcileTasks(db, log, bundle, [
        { action: 'create', taskId: null, title: 'Исходное', description: 'd', status: 'open', dueAt: null, dueText: null, confidence: 0.9, messageId: msgId },
      ], provider, 1000);
      const id = c.created[0]!.id;
      db.run(sql`UPDATE tasks SET manual = 1, title = 'Моё название', due_at = 555 WHERE id = ${id}`);
      const r = reconcileTasks(db, log, bundle, [
        { action: 'complete', taskId: id, title: 'Исходное', description: 'AI-описание', status: 'done', dueAt: null, dueText: null, confidence: 0.99, messageId: repId },
      ], provider, 2000);
      assert.equal(r.updated.length, 1);
      const row = db.get<{ status: string; title: string; due_at: number; description: string | null; confidence: number | null }>(
        sql`SELECT status, title, due_at, description, confidence FROM tasks WHERE id = ${id}`,
      );
      assert.equal(row?.status, 'done');
      assert.equal(row?.title, 'Моё название');
      assert.equal(row?.due_at, 555);
      assert.equal(row?.description, 'd');
      assert.equal(row?.confidence, 0.9);
    } finally {
      close();
    }
  });
});
