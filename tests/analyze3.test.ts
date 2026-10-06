import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { openTestDb } from './db.js';
import { MockProvider } from '../src/ai/providers/mock.js';
import { buildPrompt } from '../src/ai/prompts.js';
import { analyzeChat, loadPendingBundles, type ChatBundle } from '../src/ai/taskService.js';
import type { AnalyzeOutput } from '../src/ai/types.js';

const log = pino({ level: 'silent' });
const CHAT = 'a@s.whatsapp.net';
const NOW = 1_791_000_000_000;

type TestDb = ReturnType<typeof openTestDb>['db'];

function seedChat(db: TestDb): { chatId: number } {
  db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES (${CHAT}, 'Айгуль', 0, 1)`);
  db.run(sql`INSERT INTO contacts (jid, phone, push_name, created_at, updated_at) VALUES (${CHAT}, '1', 'Айгуль', 1, 1)`);
  return { chatId: db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${CHAT}`)!.id };
}

function seedMsg(db: TestDb, wamid: string, text: string, ts: number, fromMe: boolean): number {
  db.run(sql`
    INSERT INTO messages
      (whatsapp_message_id, chat_jid, sender_jid, direction, message_type, text, timestamp, is_from_me, created_at)
    VALUES (${wamid}, ${CHAT}, ${CHAT}, ${fromMe ? 'outgoing' : 'incoming'}, 'text', ${text}, ${ts}, ${fromMe ? 1 : 0}, ${ts})
  `);
  return db.get<{ id: number }>(sql`SELECT last_insert_rowid() AS id`)!.id;
}

function unprocessedCount(db: TestDb): number {
  return db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM messages WHERE processed_at IS NULL`)?.n ?? 0;
}

describe('шаг 3: контекст, ссылки, инкрементальность (mock-LLM)', () => {
  it('промпт: ключи m<id>/t<id> и время в TIMEZONE со смещением', () => {
    const { user } = buildPrompt(
      {
        chatJid: CHAT,
        contactName: 'Айгуль',
        messages: [
          { id: 34, direction: 'outgoing', senderName: null, text: 'Посмотрю вечером', messageType: 'text', durationSec: null, transcript: null, timestamp: Date.UTC(2026, 9, 5, 14, 30), whatsappMessageId: 'w' },
        ],
        existingTasks: [{ id: 12, title: 'Посмотреть анализы', status: 'open' }],
        analyzedAt: Date.UTC(2026, 9, 5, 15, 0),
      },
      'Asia/Almaty',
    );
    assert.ok(user.includes('[m34]'), 'нет ключа сообщения');
    assert.ok(user.includes('[t12]'), 'нет ключа задачи');
    assert.ok(user.includes('2026-10-05T19:30:00+05:00'), 'время сообщения без +05:00');
    assert.ok(user.includes('2026-10-05T20:00:00+05:00'), 'текущее время без +05:00');
  });

  it('create + complete по taskId end-to-end, повтор не создаёт дубль', async () => {
    const { db, close } = openTestDb();
    try {
      seedChat(db);
      seedMsg(db, 'w1', 'Посмотрите анализы?', NOW - 3000, false);
      const m2 = seedMsg(db, 'w2', 'Посмотрю вечером и напишу', NOW - 2000, true);
      const out1: AnalyzeOutput = {
        tasks: [{ action: 'create', taskId: null, title: 'Посмотреть анализы', description: null, status: 'open', dueAt: null, dueText: 'сегодня вечером', confidence: 0.9, messageId: m2 }],
      };
      const bundles = loadPendingBundles(db, { now: NOW });
      assert.equal(bundles.length, 1);
      const b: ChatBundle = bundles[0]!;
      assert.equal(b.newMessageIds.length, 2);
      const r1 = await analyzeChat(db, log, new MockProvider({ [CHAT]: out1 }), b, NOW);
      assert.equal(r1.created.length, 1);
      assert.equal(unprocessedCount(db), 0);
      const taskId = r1.created[0]!.id;

      // второй прогон: необработанных нет — анализировать нечего
      assert.equal(loadPendingBundles(db, { now: NOW + 1000 }).length, 0);

      // отчёт о выполнении новым сообщением
      const m3 = seedMsg(db, 'w3', 'Посмотрела, всё в норме', NOW, true);
      const b2 = loadPendingBundles(db, { now: NOW + 1000 });
      assert.equal(b2.length, 1);
      const out2: AnalyzeOutput = {
        tasks: [{ action: 'complete', taskId, title: 'Посмотреть анализы', description: null, status: 'done', dueAt: null, dueText: null, confidence: 0.95, messageId: m3 }],
      };
      const r2 = await analyzeChat(db, log, new MockProvider({ [CHAT]: out2 }), b2[0]!, NOW + 1000);
      assert.equal(r2.updated.length, 1);
      assert.equal(db.get<{ status: string }>(sql`SELECT status FROM tasks WHERE id = ${taskId}`)?.status, 'done');
      assert.equal(unprocessedCount(db), 0);
    } finally {
      close();
    }
  });

  it('ошибка провайдера: сообщения остаются необработанными', async () => {
    const { db, close } = openTestDb();
    try {
      seedChat(db);
      seedMsg(db, 'w1', 'Привет', NOW, false);
      const bundles = loadPendingBundles(db, { now: NOW });
      assert.equal(bundles.length, 1);
      const failing = {
        name: 'boom',
        model: 'boom-1',
        promptVersion: 'v',
        analyzeConversation: async () => {
          throw new Error('LLM down');
        },
      };
      await assert.rejects(() => analyzeChat(db, log, failing, bundles[0]!, NOW), /LLM down/);
      assert.equal(unprocessedCount(db), 1);
      assert.equal(db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tasks`)?.n, 0);
    } finally {
      close();
    }
  });

  it('контекст ограничен окном и лимитом', () => {
    const { db, close } = openTestDb();
    try {
      seedChat(db);
      const old = NOW - 20 * 86_400_000; // 20 дней назад — вне окна 14 дней
      seedMsg(db, 'w-old', 'старое', old, false);
      seedMsg(db, 'w-new', 'свежее', NOW, false);
      const bundles = loadPendingBundles(db, { now: NOW, limit: 1 });
      assert.equal(bundles.length, 1);
      assert.deepEqual(bundles[0]!.messages.map((m) => m.whatsappMessageId), ['w-new']);
      assert.deepEqual(bundles[0]!.newMessageIds.length, 1);
    } finally {
      close();
    }
  });
});
