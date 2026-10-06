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

function seedChat(db: TestDb, jid = CHAT): number {
  db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES (${jid}, 'Пациент', 0, 1)`);
  return db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${jid}`)!.id;
}

function seedMsg(db: TestDb, wamid: string, ts: number, chatJid = CHAT): number {
  db.run(sql`
    INSERT INTO messages
      (whatsapp_message_id, chat_jid, sender_jid, direction, message_type, text, timestamp, is_from_me, created_at)
    VALUES (${wamid}, ${chatJid}, ${chatJid}, 'outgoing', 'text', 't', ${ts}, 1, ${ts})
  `);
  return db.get<{ id: number }>(sql`SELECT last_insert_rowid() AS id`)!.id;
}

function bundle(chatId: number): ChatBundle {
  return { chatJid: CHAT, chatId, contactName: 'Пациент', contactId: null, messages: [], newMessageIds: [] };
}

function task(db: TestDb, id: number) {
  return db.get<{
    status: string;
    closed_at: number | null;
    closed_by_message_id: number | null;
    source_message_id: number | null;
    confidence: number | null;
    model: string | null;
    prompt_version: string | null;
  }>(
    sql`SELECT status, closed_at, closed_by_message_id, source_message_id, confidence, model, prompt_version FROM tasks WHERE id = ${id}`,
  );
}

const created = (title: string, msgId: number | null): ExtractedTask[] => [
  { action: 'create', taskId: null, title, description: 'd', status: 'open', dueAt: null, dueText: 'сегодня вечером', confidence: 0.9, messageId: msgId },
];

describe('reconcileTasks — идентификация только по id (шаг 2)', () => {
  it('create: новая строка с provenance, messageId как есть', () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      const msgId = seedMsg(db, 'M1', 1000);
      const r = reconcileTasks(db, log, bundle(chatId), created('Посмотреть анализы', msgId), provider, 1000);
      assert.equal(r.created.length, 1);
      const t = task(db, r.created[0]!.id);
      assert.equal(t?.status, 'open');
      assert.equal(t?.source_message_id, msgId);
      assert.equal(t?.model, 'mock:mock-test-v1');
      assert.equal(t?.prompt_version, provider.promptVersion);
      assert.equal(t?.confidence, 0.9);
      assert.equal(t?.closed_at, null);
    } finally {
      close();
    }
  });

  it('повтор того же источника — пропуск (UNIQUE), без обновления', () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      const msgId = seedMsg(db, 'M1', 1000);
      reconcileTasks(db, log, bundle(chatId), created('Посмотреть анализы', msgId), provider, 1000);
      const r2 = reconcileTasks(db, log, bundle(chatId), created('Посмотреть анализы', msgId), provider, 2000);
      assert.equal(r2.created.length, 0);
      assert.equal(r2.updated.length, 0);
      assert.equal(r2.skipped, 1);
      assert.equal(db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tasks`)?.n, 1);
    } finally {
      close();
    }
  });

  it('complete по taskId: done + closed_at + closed_by_message_id', () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      const msgId = seedMsg(db, 'M1', 1000);
      const reportId = seedMsg(db, 'M9', 2000);
      const c = reconcileTasks(db, log, bundle(chatId), created('Посмотреть анализы', msgId), provider, 1000);
      const id = c.created[0]!.id;
      const r = reconcileTasks(db, log, bundle(chatId), [
        { action: 'complete', taskId: id, title: 'Посмотреть анализы', description: 'врач отчиталась', status: 'done', dueAt: null, dueText: null, confidence: 0.95, messageId: reportId },
      ], provider, 5000);
      assert.equal(r.updated.length, 1);
      assert.equal(r.created.length, 0);
      const t = task(db, id);
      assert.equal(t?.status, 'done');
      assert.equal(t?.closed_at, 5000);
      assert.equal(t?.closed_by_message_id, reportId);
    } finally {
      close();
    }
  });

  it('complete неизвестного id — пропуск без создания', () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      const reportId = seedMsg(db, 'M9', 2000);
      const r = reconcileTasks(db, log, bundle(chatId), [
        { action: 'complete', taskId: 999, title: 'Что-то', description: null, status: 'done', dueAt: null, dueText: null, confidence: 0.9, messageId: reportId },
      ], provider, 2000);
      assert.equal(r.created.length, 0);
      assert.equal(r.updated.length, 0);
      assert.equal(db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tasks`)?.n, 0);
    } finally {
      close();
    }
  });

  it('complete чужого чата — пропуск (scope по chat_id)', () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db, 'a@s.whatsapp.net');
      seedChat(db, 'b@s.whatsapp.net');
      const msgId = seedMsg(db, 'M1', 1000, 'a@s.whatsapp.net');
      const c = reconcileTasks(
        db,
        log,
        { chatJid: 'a@s.whatsapp.net', chatId, contactName: null, contactId: null, messages: [], newMessageIds: [] },
        created('X', msgId),
        provider,
        1000,
      );
      const otherId = db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = 'b@s.whatsapp.net'`)!.id;
      const reportId = seedMsg(db, 'M9', 2000, 'b@s.whatsapp.net');
      const r = reconcileTasks(
        db,
        log,
        { chatJid: 'b@s.whatsapp.net', chatId: otherId, contactName: null, contactId: null, messages: [], newMessageIds: [] },
        [{ action: 'complete', taskId: c.created[0]!.id, title: 'X', description: null, status: 'done', dueAt: null, dueText: null, confidence: 1, messageId: reportId }],
        provider,
        2000,
      );
      assert.equal(r.updated.length, 0);
      assert.equal(task(db, c.created[0]!.id)?.status, 'open');
    } finally {
      close();
    }
  });

  it('cancel по taskId переводит в cancelled', () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      const msgId = seedMsg(db, 'M1', 1000);
      const c = reconcileTasks(db, log, bundle(chatId), created('Посмотреть анализы', msgId), provider, 1000);
      const r = reconcileTasks(db, log, bundle(chatId), [
        { action: 'cancel', taskId: c.created[0]!.id, title: 'Посмотреть анализы', description: null, status: 'cancelled', dueAt: null, dueText: null, confidence: 0.8, messageId: null },
      ], provider, 3000);
      assert.equal(r.updated.length, 1);
      assert.equal(task(db, c.created[0]!.id)?.status, 'cancelled');
    } finally {
      close();
    }
  });

  it('needs_review создаётся для ручной проверки', () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      const msgId = seedMsg(db, 'M3', 1000);
      const r = reconcileTasks(db, log, bundle(chatId), [
        { action: 'create', taskId: null, title: 'Возможно уточнить у кардиолога', description: null, status: 'needs_review', dueAt: null, dueText: null, confidence: 0.35, messageId: msgId },
      ], provider, 1000);
      assert.equal(r.created.length, 1);
      assert.equal(r.created[0]?.status, 'needs_review');
    } finally {
      close();
    }
  });

  it('доказательство из чужого чата — NULL (не теряем задачу)', () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      seedChat(db, 'other@s.whatsapp.net');
      const foreignMsg = seedMsg(db, 'FX', 1000, 'other@s.whatsapp.net');
      const r = reconcileTasks(db, log, bundle(chatId), created('X', foreignMsg), provider, 1000);
      assert.equal(r.created.length, 1);
      assert.equal(task(db, r.created[0]!.id)?.source_message_id, null);
    } finally {
      close();
    }
  });
});
