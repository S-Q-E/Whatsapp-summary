import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { openTestDb } from './db.js';
import { MockProvider } from '../src/ai/providers/mock.js';
import { analyzeChat } from '../src/ai/taskService.js';
import { buildUserPrompt, PROMPT_VERSION } from '../src/ai/prompts.js';
import { EVAL_CASES } from '../src/ai/evalFixtures.js';

const log = pino({ level: 'silent' });
const NOW = 1_800_000_000_000;
const CHAT = 'ctx@s.whatsapp.net';
type TestDb = ReturnType<typeof openTestDb>['db'];

function seedChat(db: TestDb): number {
  db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES (${CHAT}, 'N', 0, 1)`);
  return db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${CHAT}`)!.id;
}

function seedMsg(
  db: TestDb,
  chatId: number,
  wamid: string,
  text: string | null,
  ts: number,
  opts: {
    fromMe?: boolean;
    processedAt?: number | null;
    messageType?: string;
    transcript?: string | null;
    deletedAt?: number | null;
  } = {},
): number {
  const fromMe = opts.fromMe ?? false;
  db.run(sql`INSERT INTO messages
    (whatsapp_message_id, chat_jid, chat_id, sender_jid, direction, message_type, text, transcript, timestamp, is_from_me, created_at, processed_at, deleted_at)
    VALUES (${wamid}, ${CHAT}, ${chatId}, ${CHAT}, ${fromMe ? 'outgoing' : 'incoming'}, ${opts.messageType ?? 'text'}, ${text}, ${opts.transcript ?? null}, ${ts}, ${fromMe ? 1 : 0}, ${ts}, ${opts.processedAt ?? null}, ${opts.deletedAt ?? null})`);
  return db.get<{ id: number }>(sql`SELECT last_insert_rowid() AS id`)!.id;
}

function bundleFor(db: TestDb, chatId: number) {
  return { chatJid: CHAT, chatId, contactName: null, contactId: null, messages: [], newMessageIds: [] as number[] };
}

describe('контекст analyzeChat: окно = prior + новые', () => {
  it('a) 2 обработанных + 1 новое: модель видит все 3, контекст помечен isContext', async () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      seedMsg(db, chatId, 'w1', 'я отправила анализы', NOW - 3000, { processedAt: NOW - 2000 });
      seedMsg(db, chatId, 'w2', 'там гемоглобин низкий', NOW - 2000, { processedAt: NOW - 2000 });
      seedMsg(db, chatId, 'w3', 'Да, вечером посмотрю и напишу вам', NOW - 1000, { fromMe: true });
      const provider = new MockProvider({ [CHAT]: { tasks: [] } });
      await analyzeChat(db, log, provider, bundleFor(db, chatId), NOW);
      assert.equal(provider.calls.length, 1);
      const got = provider.calls[0]!.messages;
      assert.equal(got.length, 3);
      assert.deepEqual(got.map((m) => m.isContext), [true, true, false]);
    } finally {
      close();
    }
  });

  it('b) контекста не больше AI_CONTEXT_PRIOR, в пределах DAYS, без мусора', async () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      // 20 обработанных свежих + 1 новое
      for (let i = 0; i < 20; i++) {
        seedMsg(db, chatId, `wctx${i}`, `контекст ${i}`, NOW - 100_000 + i * 1000, { processedAt: NOW - 50_000 });
      }
      // мусорные обработанные: должны отфильтроваться из контекста
      seedMsg(db, chatId, 'w-del', 'удалённое', NOW - 90_000, { processedAt: NOW - 50_000, deletedAt: NOW - 40_000 });
      seedMsg(db, chatId, 'w-react', '👍', NOW - 89_000, { processedAt: NOW - 50_000, messageType: 'reaction' });
      seedMsg(db, chatId, 'w-proto', 'x', NOW - 88_000, { processedAt: NOW - 50_000, messageType: 'protocol' });
      seedMsg(db, chatId, 'w-digest', '📋 Итоги дня\nбла', NOW - 87_000, { processedAt: NOW - 50_000, fromMe: true });
      // старое за пределами AI_CONTEXT_DAYS (14 дней по умолчанию)
      seedMsg(db, chatId, 'w-old', 'очень старое', NOW - 20 * 86_400_000, { processedAt: NOW - 19 * 86_400_000 });
      seedMsg(db, chatId, 'w-new', 'Да, вечером посмотрю', NOW - 1000, { fromMe: true });
      const provider = new MockProvider({ [CHAT]: { tasks: [] } });
      await analyzeChat(db, log, provider, bundleFor(db, chatId), NOW);
      assert.equal(provider.calls.length, 1);
      const got = provider.calls[0]!.messages;
      const ctx = got.filter((m) => m.isContext);
      const fresh = got.filter((m) => !m.isContext);
      assert.equal(fresh.length, 1);
      assert.ok(ctx.length <= 15, `контекста ${ctx.length} > 15`);
      assert.equal(ctx.length, 15);
      const texts = got.map((m) => m.text ?? '');
      assert.ok(!texts.includes('удалённое'));
      assert.ok(!texts.includes('очень старое'));
      assert.ok(!texts.some((t) => t.includes('Итоги дня')));
    } finally {
      close();
    }
  });

  it('c) processed_at ставится только новым, контекстные не трогаются', async () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      const c1 = seedMsg(db, chatId, 'w1', 'я отправила анализы', NOW - 3000, { processedAt: 1000 });
      const c2 = seedMsg(db, chatId, 'w2', 'посмотрите пожалуйста', NOW - 2000, { processedAt: 2000 });
      const n1 = seedMsg(db, chatId, 'w3', 'Да, вечером посмотрю', NOW - 1000, { fromMe: true });
      const provider = new MockProvider({ [CHAT]: { tasks: [] } });
      await analyzeChat(db, log, provider, bundleFor(db, chatId), NOW);
      const p1 = db.get<{ processed_at: number }>(sql`SELECT processed_at FROM messages WHERE id = ${c1}`)!;
      const p2 = db.get<{ processed_at: number }>(sql`SELECT processed_at FROM messages WHERE id = ${c2}`)!;
      const p3 = db.get<{ processed_at: number | null }>(sql`SELECT processed_at FROM messages WHERE id = ${n1}`)!;
      assert.equal(p1.processed_at, 1000);
      assert.equal(p2.processed_at, 2000);
      assert.ok(p3.processed_at !== null);
    } finally {
      close();
    }
  });

  it('d) голосовое с пришедшим транскриптом анализируется вместе с контекстом', async () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      seedMsg(db, chatId, 'w1', 'я отправила анализы', NOW - 3000, { processedAt: NOW - 2000 });
      const v = seedMsg(db, chatId, 'wv', null, NOW - 1000, {
        messageType: 'voice',
        transcript: 'посмотрите мои анализы вечером',
      });
      const provider = new MockProvider({ [CHAT]: { tasks: [] } });
      await analyzeChat(db, log, provider, bundleFor(db, chatId), NOW);
      assert.equal(provider.calls.length, 1);
      const got = provider.calls[0]!.messages;
      assert.equal(got.length, 2);
      assert.deepEqual(got.map((m) => m.isContext), [true, false]);
      assert.equal(got[1]!.transcript, 'посмотрите мои анализы вечером');
      const p = db.get<{ processed_at: number | null }>(sql`SELECT processed_at FROM messages WHERE id = ${v}`)!;
      assert.ok(p.processed_at !== null);
    } finally {
      close();
    }
  });

  it('e) voiceGrace внутри окна: молодое голосовое без транскрипта пропускается и не помечается', async () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      seedMsg(db, chatId, 'w1', 'я отправила анализы', NOW - 600_000, { processedAt: NOW - 500_000 });
      const v = seedMsg(db, chatId, 'wv', null, NOW - 60_000, { messageType: 'voice' });
      seedMsg(db, chatId, 'w3', 'Да, вечером посмотрю', NOW - 1000, { fromMe: true });
      const provider = new MockProvider({ [CHAT]: { tasks: [] } });
      await analyzeChat(db, log, provider, bundleFor(db, chatId), NOW);
      assert.equal(provider.calls.length, 1);
      const got = provider.calls[0]!.messages;
      // голосового в окне нет, только контекст + новое текстовое
      assert.equal(got.length, 2);
      assert.ok(!got.some((m) => m.id === v));
      const pv = db.get<{ processed_at: number | null }>(sql`SELECT processed_at FROM messages WHERE id = ${v}`)!;
      assert.equal(pv.processed_at, null);
    } finally {
      close();
    }
  });

  it('промпт: контекстные помечены, системное правило и PROMPT_VERSION поднята', () => {
    assert.equal(PROMPT_VERSION, 'task-extract-v4');
    const user = buildUserPrompt(
      {
        chatJid: CHAT,
        contactName: null,
        messages: [
          { id: 1, direction: 'incoming', senderName: null, text: 'я отправила анализы', transcript: null, messageType: 'text', durationSec: null, timestamp: NOW - 2000, whatsappMessageId: 'w1', isContext: true },
          { id: 2, direction: 'outgoing', senderName: null, text: 'Да, вечером посмотрю', transcript: null, messageType: 'text', durationSec: null, timestamp: NOW - 1000, whatsappMessageId: 'w2', isContext: false },
        ],
        existingTasks: [],
        analyzedAt: NOW,
      },
      'Asia/Almaty',
    );
    assert.ok(user.includes('[контекст, уже разобрано]'));
  });

  it('eval-фикстуры: 3 кейса «обещание-ответ на более раннюю реплику»', () => {
    for (const id of ['promise-reply-analyses', 'promise-reply-call', 'promise-reply-results']) {
      assert.ok(EVAL_CASES.some((c) => c.id === id), `нет кейса ${id}`);
    }
  });
});
