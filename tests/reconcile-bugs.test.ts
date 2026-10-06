import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { openTestDb } from './db.js';
import { MockProvider } from '../src/ai/providers/mock.js';
import { reconcileTasks, type ChatBundle } from '../src/ai/taskService.js';
import type { ExtractedTask } from '../src/ai/types.js';

const log = pino({ level: 'silent' });
const provider = new MockProvider();
const CHAT = 'demo@s.whatsapp.net';

type TestDb = ReturnType<typeof openTestDb>['db'];

function seedChat(db: TestDb): number {
  db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES (${CHAT}, 'Пациент', 0, 1)`);
  return db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${CHAT}`)!.id;
}

function seedMessage(db: TestDb, wamid: string, ts: number): number {
  db.run(sql`
    INSERT INTO messages
      (whatsapp_message_id, chat_jid, sender_jid, direction, message_type, text, timestamp, is_from_me, created_at)
    VALUES (${wamid}, ${CHAT}, ${CHAT}, 'outgoing', 'text', 't', ${ts}, 1, ${ts})
    ON CONFLICT(whatsapp_message_id, chat_jid) DO NOTHING
  `);
  return db.get<{ id: number }>(
    sql`SELECT id FROM messages WHERE whatsapp_message_id = ${wamid} AND chat_jid = ${CHAT}`,
  )!.id;
}

function taskCount(db: TestDb): number {
  return db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tasks`)?.n ?? 0;
}

const create = (title: string, msgId: number | null): ExtractedTask[] => [
  {
    action: 'create',
    taskId: null,
    title,
    description: 'd',
    status: 'open',
    dueAt: null,
    dueText: null,
    confidence: 0.9,
    messageId: msgId,
  },
];

describe('шаг 2: повтор и похожие названия — всегда новые строки', () => {
  it('(a) выполненная задача + то же обещание через неделю = НОВАЯ задача', () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      const bundle: ChatBundle = { chatJid: CHAT, chatId, contactName: 'Пациент', contactId: null, messages: [], newMessageIds: [] };
      const m1 = seedMessage(db, 'm1', 1000);
      const m2 = seedMessage(db, 'm2', 700_000);
      const mReport = seedMessage(db, 'm-report', 2000);
      const c = reconcileTasks(db, log, bundle, create('Посмотреть анализы', m1), provider, 1000);
      reconcileTasks(db, log, bundle, [
        { action: 'complete', taskId: c.created[0]!.id, title: 'Посмотреть анализы', description: null, status: 'done', dueAt: null, dueText: null, confidence: 0.95, messageId: mReport },
      ], provider, 2000);
      const r = reconcileTasks(db, log, bundle, create('Посмотреть анализы', m2), provider, 700_000);
      assert.equal(r.created.length, 1);
      assert.equal(taskCount(db), 2);
      const statuses = db.all<{ status: string }>(sql`SELECT status FROM tasks ORDER BY id`).map((t) => t.status);
      assert.deepEqual(statuses, ['done', 'open']);
    } finally {
      close();
    }
  });

  it('(b) «Позвонить» и «Позвонить в лабораторию…» — две разные задачи', () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      const bundle: ChatBundle = { chatJid: CHAT, chatId, contactName: 'Пациент', contactId: null, messages: [], newMessageIds: [] };
      const m1 = seedMessage(db, 'm1', 1000);
      const m2 = seedMessage(db, 'm2', 1000);
      reconcileTasks(db, log, bundle, create('Позвонить', m1), provider, 1000);
      const r = reconcileTasks(db, log, bundle, create('Позвонить в лабораторию и уточнить результат', m2), provider, 2000);
      assert.equal(r.created.length, 1);
      assert.equal(taskCount(db), 2);
    } finally {
      close();
    }
  });
});
