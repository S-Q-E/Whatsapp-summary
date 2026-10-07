import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { openTestDb } from './db.js';
import { applyEdit, applyRevoke } from '../src/whatsapp/store.js';
import { MockProvider } from '../src/ai/providers/mock.js';
import { analyzeChat } from '../src/ai/taskService.js';
import { AnalyzeScheduler } from '../src/ai/analyzeScheduler.js';
import type { AIProvider, AnalyzeOutput, ConversationInput } from '../src/ai/types.js';

const log = pino({ level: 'silent' });
const NOW = 1_800_000_000_000;
const CHAT = 'fix@s.whatsapp.net';
type TestDb = ReturnType<typeof openTestDb>['db'];

function seedChat(db: TestDb): number {
  db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES (${CHAT}, 'N', 0, 1)`);
  return db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${CHAT}`)!.id;
}

function seedMsgs(db: TestDb, chatId: number, n: number, ts0: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const ts = ts0 + i * 1000;
    db.run(sql`INSERT INTO messages
      (whatsapp_message_id, chat_jid, chat_id, sender_jid, direction, message_type, text, timestamp, is_from_me, created_at)
      VALUES (${`w${i}`}, ${CHAT}, ${chatId}, ${CHAT}, 'outgoing', 'text', ${`обещаю ${i}`}, ${ts}, 1, ${ts})`);
    ids.push(db.get<{ id: number }>(sql`SELECT last_insert_rowid() AS id`)!.id);
  }
  return ids;
}

describe('1. revoke сразу зачищает текст (независимо от RETENTION_DAYS)', () => {
  it('после revoke text/transcript/sender_name IS NULL, deleted_at стоит', () => {
    const { db, close } = openTestDb();
    try {
      seedChat(db);
      db.run(sql`INSERT INTO messages
        (whatsapp_message_id, chat_jid, direction, message_type, text, transcript, sender_name, timestamp, is_from_me, created_at)
        VALUES ('orig9', ${CHAT}, 'incoming', 'voice', 'секрет', 'расшифровка', 'Пациент', 1000, 0, 1000)`);
      assert.equal(applyRevoke(db, log, { chatJid: CHAT, targetId: 'orig9', timestampMs: 4000 }), true);
      const row = db.get<{ text: string | null; transcript: string | null; sender_name: string | null; deleted_at: number | null }>(
        sql`SELECT text, transcript, sender_name, deleted_at FROM messages WHERE whatsapp_message_id = 'orig9'`,
      );
      assert.equal(row?.text, null);
      assert.equal(row?.transcript, null);
      assert.equal(row?.sender_name, null);
      assert.equal(row?.deleted_at, 4000);
    } finally {
      close();
    }
  });
});

describe('2. параллельный анализ: inFlight до settle, abort по таймауту', () => {
  it('медленный провайдер + малый chatTimeoutMs, два тика подряд -> maxConcurrent === 1', async () => {
    const { db, close } = openTestDb();
    try {
      seedChat(db);
      seedMsgs(db, db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${CHAT}`)!.id, 2, NOW - 10_000);
      let now = NOW;
      let active = 0;
      let maxActive = 0;
      const slow: AIProvider = {
        name: 'slow',
        model: 'slow-1',
        promptVersion: 'v',
        analyzeConversation: async (_input: ConversationInput, opts?: { signal?: AbortSignal }): Promise<AnalyzeOutput> => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            await new Promise<void>((resolve, reject) => {
              if (opts?.signal?.aborted) {
                reject(new Error('aborted'));
                return;
              }
              const t = setTimeout(resolve, 300);
              opts?.signal?.addEventListener('abort', () => {
                clearTimeout(t);
                reject(new Error('aborted'));
              }, { once: true });
            });
            return { tasks: [] };
          } finally {
            active -= 1;
          }
        },
      };
      const sched = new AnalyzeScheduler({
        db, log, getProvider: () => slow,
        intervalMs: 60_000, maxChats: 10, chatTimeoutMs: 30, now: () => now,
      });
      await sched.tick();
      now += 3 * 60_000; // выйти из бэкоффа первого тика
      await sched.tick();
      sched.stop();
      assert.equal(maxActive, 1);
    } finally {
      close();
    }
  });
});

describe('3. бэклог: не больше MAX_WAVES_PER_TICK волн за тик, прогресс без бэкоффа', () => {
  it('300 сообщений: первый тик <= 3 волн, fail_count 0, следующие тики добирают', async () => {
    const { env } = await import('../src/config/env.js');
    assert.equal(env.maxWavesPerTick, 3);
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      seedMsgs(db, chatId, 300, NOW - 300_000);
      let calls = 0;
      const counting: AIProvider = {
        name: 'c', model: 'c', promptVersion: 'v',
        analyzeConversation: async () => {
          calls += 1;
          return { tasks: [] };
        },
      };
      let now = NOW;
      const sched = new AnalyzeScheduler({
        db, log, getProvider: () => counting,
        intervalMs: 60_000, maxChats: 10, chatTimeoutMs: 5000, maxWavesPerTick: 3, now: () => now,
      });
      await sched.tick();
      assert.ok(calls <= 3, `волн за тик: ${calls} > 3`);
      const left = db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM messages WHERE processed_at IS NULL`)!.n;
      assert.ok(left > 0, 'бэклог должен остаться после первого тика');
      const st = db.get<{ fail_count: number; next_attempt_at: number | null }>(
        sql`SELECT fail_count, next_attempt_at FROM chat_analysis_state WHERE chat_id = ${chatId}`,
      );
      assert.ok(!st || st.fail_count === 0, 'прогресс не должен растить fail_count');
      assert.ok(!st || st.next_attempt_at === null || st.next_attempt_at <= now, 'бэкофф не включается при прогрессе');
      for (let i = 0; i < 10 && db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM messages WHERE processed_at IS NULL`)!.n > 0; i++) {
        await sched.tick();
      }
      assert.equal(db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM messages WHERE processed_at IS NULL`)!.n, 0);
      sched.stop();
    } finally {
      close();
    }
  });
});

describe('4. повторный разбор источника (правка): create -> needs_review, без дубля', () => {
  it('правка + create с другой формулировкой: новых задач нет, старая в needs_review', async () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db);
      db.run(sql`INSERT INTO messages
        (whatsapp_message_id, chat_jid, chat_id, sender_jid, direction, message_type, text, timestamp, is_from_me, created_at)
        VALUES ('w1', ${CHAT}, ${chatId}, ${CHAT}, 'outgoing', 'text', 'Посмотрю вечером', ${NOW - 2000}, 1, ${NOW - 2000})`);
      const msgId = db.get<{ id: number }>(sql`SELECT id FROM messages WHERE whatsapp_message_id = 'w1'`)!.id;
      const bundle = { chatJid: CHAT, chatId, contactName: null, contactId: null, messages: [], newMessageIds: [] as number[] };
      const out1 = { tasks: [{ action: 'create' as const, taskId: null, title: 'Посмотреть анализы', description: null, status: 'open' as const, dueAt: null, dueText: null, confidence: 0.9, messageId: msgId }] };
      const r1 = await analyzeChat(db, log, new MockProvider({ [CHAT]: out1 }), bundle, NOW);
      assert.equal(r1.created.length, 1);
      // правка сообщения: текст новый, processed_at сброшен
      assert.equal(applyEdit(db, log, { chatJid: CHAT, targetId: 'w1', text: 'Посмотрю завтра утром', timestampMs: NOW }), true);
      const out2 = { tasks: [{ action: 'create' as const, taskId: null, title: 'Глянуть анализы завтра', description: null, status: 'open' as const, dueAt: null, dueText: null, confidence: 0.9, messageId: msgId }] };
      const r2 = await analyzeChat(db, log, new MockProvider({ [CHAT]: out2 }), bundle, NOW + 1000);
      assert.equal(r2.created.length, 0);
      assert.equal(db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tasks`)!.n, 1);
      assert.equal(db.get<{ status: string }>(sql`SELECT status FROM tasks`)!.status, 'needs_review');
    } finally {
      close();
    }
  });
});

describe('5. docker data-dir + мёртвые настройки', () => {
  it('ensureDataDirWritable: чтение/запись ок, read-only -> русская ошибка с chown', async () => {
    const mod = (await import('../src/database/db.js')) as unknown as {
      ensureDataDirWritable?: (dir: string) => void;
    };
    assert.equal(typeof mod.ensureDataDirWritable, 'function');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'datadir-'));
    try {
      mod.ensureDataDirWritable!(path.join(tmp, 'sub'));
      assert.ok(fs.existsSync(path.join(tmp, 'sub')));
      if (process.getuid?.() === 0) return; // root пишет везде — read-only кейс неприменим
      const ro = path.join(tmp, 'ro');
      fs.mkdirSync(ro);
      fs.chmodSync(ro, 0o555);
      assert.throws(() => mod.ensureDataDirWritable!(ro), /sudo chown -R 1000:1000 data/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('README описывает chown при проблемах с томом; TRANSCRIBE_TMP_DIR нигде нет', () => {
    const root = process.cwd();
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf-8');
    assert.ok(readme.includes('sudo chown -R 1000:1000 data'));
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|md|yml|yaml|example|Dockerfile)$/.test(e.name) || e.name === 'Dockerfile') {
          const text = fs.readFileSync(p, 'utf-8');
          if (text.includes('TRANSCRIBE_TMP_DIR')) hits.push(p);
        }
      }
    };
    walk(path.join(root, 'src'));
    for (const f of ['.env.example', 'README.md', 'Dockerfile', 'docker-compose.yml']) {
      const p = path.join(root, f);
      if (fs.existsSync(p) && fs.readFileSync(p, 'utf-8').includes('TRANSCRIBE_TMP_DIR')) hits.push(p);
    }
    assert.deepEqual(hits, []);
  });
});
