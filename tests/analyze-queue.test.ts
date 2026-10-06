import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { openTestDb } from './db.js';
import { MockProvider } from '../src/ai/providers/mock.js';
import {
  analyzeChat,
  chatsNeedingAttention,
  loadPendingBundles,
  reconcileTasks,
  type ChatBundle,
} from '../src/ai/taskService.js';
import { AnalyzeScheduler } from '../src/ai/analyzeScheduler.js';
import { buildUserPrompt } from '../src/ai/prompts.js';
import { parseModelActions } from '../src/ai/validate.js';
import type { AIProvider, AnalyzeOutput, ConversationInput } from '../src/ai/types.js';

const log = pino({ level: 'silent' });
const NOW = 1_800_000_000_000;
type TestDb = ReturnType<typeof openTestDb>['db'];

function seedChat(db: TestDb, jid: string): number {
  db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES (${jid}, 'N', 0, 1)`);
  return db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${jid}`)!.id;
}

function seedMsgs(db: TestDb, chatJid: string, chatId: number, n: number, ts0: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const ts = ts0 + i * 1000;
    db.run(sql`INSERT INTO messages
      (whatsapp_message_id, chat_jid, chat_id, sender_jid, direction, message_type, text, timestamp, is_from_me, created_at)
      VALUES (${`w${i}`}, ${chatJid}, ${chatId}, ${chatJid}, 'outgoing', 'text', ${`обещаю ${i}`}, ${ts}, 1, ${ts})`);
    ids.push(db.get<{ id: number }>(sql`SELECT last_insert_rowid() AS id`)!.id);
  }
  return ids;
}

function unprocessed(db: TestDb): number {
  return db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM messages WHERE processed_at IS NULL`)?.n ?? 0;
}

/** Провайдер: одна задача-create из первого сообщения входа. */
function firstMsgProvider(counter: { calls: number }): AIProvider {
  return {
    name: 'stub',
    model: 'stub-1',
    promptVersion: 'v-test',
    async analyzeConversation(input: ConversationInput): Promise<AnalyzeOutput> {
      counter.calls += 1;
      const m = input.messages[0]!;
      return {
        tasks: [
          {
            action: 'create', taskId: null, title: `Задача из ${m.id}`, description: null,
            status: 'open', dueAt: null, dueText: null, confidence: 0.9, messageId: m.id,
          },
        ],
      };
    },
  };
}

const failingProvider: AIProvider = {
  name: 'fail',
  model: 'fail-1',
  promptVersion: 'v-test',
  async analyzeConversation(): Promise<AnalyzeOutput> {
    throw new Error('LLM down');
  },
};

describe('очередь анализа: окна и пометка (п.1)', () => {
  it('(a) 60 сообщений при лимите 40: после analyzeChat необработанных не остаётся', async () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db, 'a@s.whatsapp.net');
      seedMsgs(db, 'a@s.whatsapp.net', chatId, 60, NOW - 3_600_000);
      const bundles = loadPendingBundles(db, { limit: 40, now: NOW });
      assert.equal(bundles.length, 1);
      const counter = { calls: 0 };
      const res = await analyzeChat(db, log, firstMsgProvider(counter), bundles[0]!, NOW);
      assert.equal(counter.calls, 2);
      assert.equal(unprocessed(db), 0);
      assert.equal(res.created.length, 2);
    } finally {
      close();
    }
  });

  it('(b) повторный tick без новых сообщений не вызывает провайдера', async () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db, 'a@s.whatsapp.net');
      seedMsgs(db, 'a@s.whatsapp.net', chatId, 2, NOW - 1000);
      const counter = { calls: 0 };
      const sched = new AnalyzeScheduler({
        db, log, getProvider: () => firstMsgProvider(counter),
        intervalMs: 60_000, maxChats: 10, chatTimeoutMs: 5000, now: () => NOW,
      });
      await sched.tick();
      assert.equal(counter.calls, 1);
      await sched.tick();
      assert.equal(counter.calls, 1);
      sched.stop();
    } finally {
      close();
    }
  });
});

describe('validate: плохие действия не валят ответ (п.3)', () => {
  const INPUT: ConversationInput = {
    chatJid: 'a@s.whatsapp.net',
    contactName: null,
    messages: [
      { id: 11, direction: 'outgoing', senderName: null, text: 't', transcript: null, messageType: 'text', durationSec: null, timestamp: 1, whatsappMessageId: 'w1' },
    ],
    existingTasks: [],
    analyzedAt: 2,
  };

  it('(c) confidence=85 нормализуется, хорошее действие применяется', () => {
    const { actions, dropped } = parseModelActions(
      JSON.stringify({ actions: [
        { type: 'create', taskId: null, title: 'Хорошая', status: 'open', confidence: 85, evidenceMessageId: 'm11' },
      ] }),
      INPUT,
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.confidence, 0.85);
    assert.equal(dropped.length, 0);
  });

  it('confidence=150 отбрасывается, хорошее рядом применяется', () => {
    const { actions, dropped } = parseModelActions(
      JSON.stringify({ actions: [
        { type: 'create', taskId: null, title: 'Плохая', status: 'open', confidence: 150, evidenceMessageId: 'm11' },
        { type: 'create', taskId: null, title: 'Хорошая', status: 'open', confidence: 0.7, evidenceMessageId: 'm11' },
      ] }),
      INPUT,
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.title, 'Хорошая');
    assert.equal(dropped.length, 1);
    assert.match(dropped[0]!, /confidence/);
  });

  it('JSON-мусор и отсутствие actions по-прежнему бросают AIValidationError', () => {
    assert.throws(() => parseModelActions('конечно, посмотрю!', INPUT), /AI output validation failed/);
    assert.throws(() => parseModelActions(JSON.stringify({ tasks: [] }), INPUT), /AI output validation failed/);
  });
});

describe('бэкофф по чату (п.2)', () => {
  it('ошибки наращивают next_attempt_at 2/4/8 мин, успех сбрасывает', async () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db, 'a@s.whatsapp.net');
      seedMsgs(db, 'a@s.whatsapp.net', chatId, 1, NOW - 1000);
      let now = NOW;
      const sched = new AnalyzeScheduler({
        db, log, getProvider: () => failingProvider,
        intervalMs: 60_000, maxChats: 10, chatTimeoutMs: 5000, now: () => now,
      });
      const counter = { calls: 0 };
      const counting: AIProvider = {
        ...failingProvider,
        analyzeConversation: async () => {
          counter.calls += 1;
          throw new Error('LLM down');
        },
      };
      const sched2 = new AnalyzeScheduler({
        db, log, getProvider: () => counting,
        intervalMs: 60_000, maxChats: 10, chatTimeoutMs: 5000, now: () => now,
      });
      await sched2.tick();
      let st = db.get<{ fail_count: number; next_attempt_at: number }>(
        sql`SELECT fail_count, next_attempt_at FROM chat_analysis_state WHERE chat_id = ${chatId}`,
      );
      assert.equal(st?.fail_count, 1);
      assert.equal(st?.next_attempt_at, NOW + 2 * 60_000);
      // сразу повтор — чат в бэкоффе, провайдер не вызывается
      await sched2.tick();
      assert.equal(counter.calls, 1);
      // прошло 3 минуты — снова пробуем, снова ошибка → +4 мин
      now = NOW + 3 * 60_000;
      await sched2.tick();
      assert.equal(counter.calls, 2);
      st = db.get<{ fail_count: number; next_attempt_at: number }>(
        sql`SELECT fail_count, next_attempt_at FROM chat_analysis_state WHERE chat_id = ${chatId}`,
      );
      assert.equal(st?.fail_count, 2);
      assert.equal(st?.next_attempt_at, now + 4 * 60_000);
      sched.stop();
      sched2.stop();
    } finally {
      close();
    }
  });

  it('после 5 ошибок чат в needs_attention и не крутится вечно', async () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db, 'a@s.whatsapp.net');
      seedMsgs(db, 'a@s.whatsapp.net', chatId, 1, NOW - 1000);
      let now = NOW;
      const counter = { calls: 0 };
      const counting: AIProvider = {
        ...failingProvider,
        analyzeConversation: async () => {
          counter.calls += 1;
          throw new Error('LLM down');
        },
      };
      const sched = new AnalyzeScheduler({
        db, log, getProvider: () => counting,
        intervalMs: 60_000, maxChats: 10, chatTimeoutMs: 5000, now: () => now,
      });
      for (let i = 0; i < 5; i++) {
        now += 61 * 60_000; // каждый раз выходим из бэкоффа
        await sched.tick();
      }
      assert.equal(counter.calls, 5);
      assert.deepEqual(chatsNeedingAttention(db), ['a@s.whatsapp.net']);
      // шестой тик сразу же: бэкофф (60 мин cap) — провайдер молчит
      await sched.tick();
      assert.equal(counter.calls, 5);
      sched.stop();
    } finally {
      close();
    }
  });

  it('очередь — от старых к новым; зависший чат не вытесняет остальных', async () => {
    const { db, close } = openTestDb();
    try {
      const oldId = seedChat(db, 'old@s.whatsapp.net');
      seedMsgs(db, 'old@s.whatsapp.net', oldId, 1, NOW - 10_000);
      const newId = seedChat(db, 'new@s.whatsapp.net');
      seedMsgs(db, 'new@s.whatsapp.net', newId, 1, NOW - 1000);
      // old падает и уходит в бэкофф
      let now = NOW;
      const seen: string[] = [];
      const mixed: AIProvider = {
        name: 'mixed', model: 'm', promptVersion: 'v',
        analyzeConversation: async (input: ConversationInput) => {
          seen.push(input.chatJid);
          if (input.chatJid === 'old@s.whatsapp.net') throw new Error('boom');
          return { tasks: [] };
        },
      };
      const sched = new AnalyzeScheduler({
        db, log, getProvider: () => mixed,
        intervalMs: 60_000, maxChats: 10, chatTimeoutMs: 5000, now: () => now,
      });
      await sched.tick();
      assert.deepEqual(seen, ['old@s.whatsapp.net', 'new@s.whatsapp.net']);
      // второй тик: old в бэкоффе, new уже разобран → тишина
      seen.length = 0;
      await sched.tick();
      assert.deepEqual(seen, []);
      sched.stop();
    } finally {
      close();
    }
  });
});

describe('контекст: закрытые задачи, пометки, исключения (п.5, п.6)', () => {
  function seedCtx(db: TestDb): { chatId: number; msgIds: number[] } {
    const chatId = seedChat(db, 'a@s.whatsapp.net');
    const msgIds = seedMsgs(db, 'a@s.whatsapp.net', chatId, 3, NOW - 3000);
    // задача из m1 (закрыта вчера), задача из m2 (закрыта 30 дней назад)
    for (const [mid, closedAgo, title] of [[msgIds[0]!, 86_400_000, 'Вчерашняя'], [msgIds[1]!, 30 * 86_400_000, 'Давняя']] as const) {
      db.run(sql`INSERT INTO tasks (chat_id, chat_jid, title, status, source_message_id, created_at, updated_at, closed_at)
        VALUES (${chatId}, 'a@s.whatsapp.net', ${title}, 'done', ${mid}, ${NOW - closedAgo}, ${NOW - closedAgo}, ${NOW - closedAgo})`);
    }
    db.run(sql`INSERT INTO tasks (chat_id, chat_jid, title, status, source_message_id, created_at, updated_at)
      VALUES (${chatId}, 'a@s.whatsapp.net', 'Открытая', 'open', ${msgIds[2]}, ${NOW - 1000}, ${NOW - 1000})`);
    return { chatId, msgIds };
  }

  it('закрытые за AI_CONTEXT_DAYS — отдельным блоком, старые — нет', async () => {
    const { db, close } = openTestDb();
    try {
      seedCtx(db);
      const bundles = loadPendingBundles(db, { now: NOW, maxAgeDays: 14 });
      assert.equal(bundles.length, 1);
      const seen: ConversationInput[] = [];
      const capture: AIProvider = {
        name: 'cap', model: 'c', promptVersion: 'v',
        analyzeConversation: async (input: ConversationInput) => {
          seen.push(input);
          return { tasks: [] };
        },
      };
      await analyzeChat(db, log, capture, bundles[0]!, NOW);
      assert.equal(seen.length, 1);
      const prompt = buildUserPrompt(seen[0]!, 'Asia/Almaty');
      assert.ok(prompt.includes('Уже обработанные задачи'), 'нет блока закрытых');
      assert.ok(prompt.includes('Вчерашняя'), 'вчерашняя должна быть');
      assert.ok(!prompt.includes('Давняя'), 'давняя не должна быть');
      // сообщение-источник помечено
      assert.ok(prompt.includes('[уже есть задача #'), 'нет пометки has-task');
    } finally {
      close();
    }
  });

  it('чат владельца и сообщения-дайджесты в очередь не попадают', () => {
    const { db, close } = openTestDb();
    try {
      const ownerId = seedChat(db, 'owner@s.whatsapp.net');
      seedMsgs(db, 'owner@s.whatsapp.net', ownerId, 2, NOW - 1000);
      const otherId = seedChat(db, 'b@s.whatsapp.net');
      seedMsgs(db, 'b@s.whatsapp.net', otherId, 1, NOW - 1000);
      db.run(sql`INSERT INTO messages (whatsapp_message_id, chat_jid, chat_id, sender_jid, direction, message_type, text, timestamp, is_from_me, created_at)
        VALUES ('digest1', 'b@s.whatsapp.net', ${otherId}, 'b@s.whatsapp.net', 'outgoing', 'text', '📋 Итоги дня\nбла', ${NOW - 500}, 1, ${NOW - 500})`);
      const bundles = loadPendingBundles(db, { now: NOW, ownerJid: 'owner@s.whatsapp.net' });
      assert.deepEqual(bundles.map((b) => b.chatJid), ['b@s.whatsapp.net']);
      const digestMsg = bundles[0]!.messages.find((m) => m.whatsappMessageId === 'digest1');
      assert.equal(digestMsg, undefined);
    } finally {
      close();
    }
  });

  it('алиас владельца тоже исключается', () => {
    const { db, close } = openTestDb();
    try {
      const lidId = seedChat(db, '123@lid');
      seedMsgs(db, '123@lid', lidId, 1, NOW - 1000);
      db.run(sql`INSERT INTO jid_aliases (alias_jid, canonical_jid, created_at) VALUES ('123@lid', '7700@s.whatsapp.net', 1)`);
      const bundles = loadPendingBundles(db, { now: NOW, ownerJid: '7700@s.whatsapp.net' });
      assert.equal(bundles.length, 0);
    } finally {
      close();
    }
  });
});

describe('system/status: чаты needs_attention (п.2)', () => {
  it('чат с 5 ошибками виден в chatsNeedingAttention', async () => {
    const { openTestDb } = await import('./db.js');
    const { createApp } = await import('../src/app.js');
    const { db, close } = openTestDb();
    try {
      const { db: _omit, close: _c } = { db: null as never, close: () => {} };
      void _omit;
      void _c;
    } finally {
      close();
    }
  });
});
  it('два обещания из одного сообщения — две задачи; повтор — пропуск', () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db, 'a@s.whatsapp.net');
      const [m1] = seedMsgs(db, 'a@s.whatsapp.net', chatId, 1, NOW - 1000);
      const bundle: ChatBundle = {
        chatJid: 'a@s.whatsapp.net', chatId, contactName: null, contactId: null,
        messages: [], newMessageIds: [],
      };
      const provider = new MockProvider();
      const mk = (title: string) => ({
        action: 'create' as const, taskId: null, title, description: null,
        status: 'open' as const, dueAt: null, dueText: null, confidence: 0.9, messageId: m1!,
      });
      const r1 = reconcileTasks(db, log, bundle, [mk('Позвонить'), mk('Позвонить в лабораторию')], provider, NOW);
      assert.equal(r1.created.length, 2);
      const r2 = reconcileTasks(db, log, bundle, [mk('Позвонить'), mk('Позвонить в лабораторию')], provider, NOW + 1);
      assert.equal(r2.created.length, 0);
      assert.equal(r2.skipped, 2);
      assert.equal(db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tasks`)?.n, 2);
    } finally {
      close();
    }
  });

describe('system/status: чаты needs_attention (п.2)', () => {
  it('чат с 5 ошибками виден в chatsNeedingAttention', async () => {
    const { createApp } = await import('../src/app.js');
    const { db, close } = openTestDb();
    try {
      db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES ('a@s.whatsapp.net', 'N', 0, 1)`);
      const chatId = db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = 'a@s.whatsapp.net'`)!.id;
      db.run(sql`INSERT INTO chat_analysis_state (chat_id, fail_count, next_attempt_at, updated_at)
        VALUES (${chatId}, 5, ${NOW + 3_600_000}, ${NOW})`);
      const waStub = {
        snapshot: () => ({
          status: 'connected' as const, phone: null, connectedAt: null,
          lastSeen: null, hasSession: false, qrAvailable: false,
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
      const app = await createApp({
        db, log, wa: waStub, scheduler: schedStub, qrPng: async () => null,
        auth: { password: '', allowNoAuth: true },
      });
      const res = await app.inject({ method: 'GET', url: '/api/system/status' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().chatsNeedingAttention, ['a@s.whatsapp.net']);
      await app.close();
    } finally {
      close();
    }
  });
});
