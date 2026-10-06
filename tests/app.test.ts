import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { openTestDb } from './db.js';
import { createApp, type AppWaClient } from '../src/app.js';
import type { WaStatus } from '../src/whatsapp/status-store.js';
import { AnalyzeScheduler } from '../src/ai/analyzeScheduler.js';
import { MockProvider } from '../src/ai/providers/mock.js';
const log = pino({ level: 'silent' });
type TestDb = ReturnType<typeof openTestDb>['db'];

function mockWa(state: WaStatus = 'qr_pending'): AppWaClient & { loggedOut: boolean } {
  const stub = {
    loggedOut: false,
    snapshot: () => ({
      status: state,
      phone: state === 'connected' ? '7700@s.whatsapp.net' : null,
      connectedAt: null,
      lastSeen: null,
      hasSession: false,
      qrAvailable: state === 'qr_pending',
    }),
    qrString: () => (state === 'qr_pending' ? 'QR-STRING' : null),
    disconnect: () => stub.snapshot(),
    connect: async () => stub.snapshot(),
    logout: async () => {
      stub.loggedOut = true;
      return stub.snapshot();
    },
    on: () => () => {},
  };
  return stub;
}

function mockScheduler() {
  return {
    metricsSnapshot: () => ({
      lastRunAt: 1000,
      lastDurationMs: 50,
      lastChats: 2,
      lastCreated: 1,
      lastUpdated: 0,
      lastSkipped: 0,
      lastError: null,
      runCount: 5,
      providerErrorCount: 1,
      lastProviderError: 'boom',
      running: false,
    }),
    start: () => {},
    stop: () => {},
  };
}

const qrPng = async (s: string | null): Promise<string | null> =>
  s ? `data:image/png;base64,QR(${s})` : null;

describe('app API (шаг 5)', () => {
  it('GET /health без авторизации', async () => {
    const { db, close } = openTestDb();
    try {
      const app = await createApp({ db, log, wa: mockWa(), scheduler: mockScheduler(), qrPng });
      const res = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true });
      await app.close();
    } finally {
      close();
    }
  });

  it('без пароля — API открыто; статус mapped (qr_pending→qr)', async () => {
    const { db, close } = openTestDb();
    try {
      const app = await createApp({ db, log, wa: mockWa('qr_pending'), scheduler: mockScheduler(), qrPng });
      const res = await app.inject({ method: 'GET', url: '/api/whatsapp/status' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().state, 'qr');
      await app.close();
    } finally {
      close();
    }
  });

  it('с паролем: без cookie — 401; неверный пароль — 401; верный — cookie и 200', async () => {
    const { db, close } = openTestDb();
    try {
      const app = await createApp({
        db, log, wa: mockWa('connected'), scheduler: mockScheduler(), qrPng,
        auth: { password: 'secret', loginMaxAttempts: 100, loginWindowMs: 60_000 },
      });
      assert.equal((await app.inject({ method: 'GET', url: '/api/whatsapp/status' })).statusCode, 401);
      const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'nope' } });
      assert.equal(bad.statusCode, 401);
      const good = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'secret' } });
      assert.equal(good.statusCode, 200);
      const cookie = good.headers['set-cookie'];
      assert.ok(cookie, 'нет Set-Cookie');
      const withCookie = await app.inject({
        method: 'GET', url: '/api/whatsapp/status', headers: { cookie: String(cookie).split(';')[0] },
      });
      assert.equal(withCookie.statusCode, 200);
      assert.equal(withCookie.json().state, 'open');
      await app.close();
    } finally {
      close();
    }
  });

  it('rate limit на логин: частые попытки — 429', async () => {
    const { db, close } = openTestDb();
    try {
      const app = await createApp({
        db, log, wa: mockWa(), scheduler: mockScheduler(), qrPng,
        auth: { password: 'secret', loginMaxAttempts: 3, loginWindowMs: 60_000 },
      });
      for (let i = 0; i < 3; i++) {
        await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'nope' } });
      }
      const limited = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'nope' } });
      assert.equal(limited.statusCode, 429);
      await app.close();
    } finally {
      close();
    }
  });

  it('POST /api/whatsapp/logout требует confirm:true и вызывает wa.logout', async () => {
    const { db, close } = openTestDb();
    try {
      const wa = mockWa('connected');
      const app = await createApp({ db, log, wa, scheduler: mockScheduler(), qrPng });
      const noConfirm = await app.inject({ method: 'POST', url: '/api/whatsapp/logout', payload: {} });
      assert.equal(noConfirm.statusCode, 400);
      assert.equal(wa.loggedOut, false);
      const ok = await app.inject({ method: 'POST', url: '/api/whatsapp/logout', payload: { confirm: true } });
      assert.equal(ok.statusCode, 200);
      assert.equal(wa.loggedOut, true);
      await app.close();
    } finally {
      close();
    }
  });

  it('GET /api/whatsapp/qr — PNG data URL; null без QR', async () => {
    const { db, close } = openTestDb();
    try {
      const app = await createApp({ db, log, wa: mockWa('qr_pending'), scheduler: mockScheduler(), qrPng });
      const res = await app.inject({ method: 'GET', url: '/api/whatsapp/qr' });
      assert.equal(res.statusCode, 200);
      assert.match(res.json().dataUrl, /^data:image\/png;base64,/);
      await app.close();
      const app2 = await createApp({ db, log, wa: mockWa('connected'), scheduler: mockScheduler(), qrPng });
      assert.deepEqual((await app2.inject({ method: 'GET', url: '/api/whatsapp/qr' })).json().dataUrl, null);
      await app2.close();
    } finally {
      close();
    }
  });

  it('GET /api/system/status — метрики анализа и необработанные', async () => {
    const { db, close } = openTestDb();
    try {
      db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES ('a@s.whatsapp.net', 'А', 0, 1)`);
      db.run(sql`INSERT INTO messages (whatsapp_message_id, chat_jid, direction, message_type, timestamp, is_from_me, created_at)
        VALUES ('w1', 'a@s.whatsapp.net', 'incoming', 'text', 1000, 0, 1000)`);
      const app = await createApp({ db, log, wa: mockWa(), scheduler: mockScheduler(), qrPng });
      const res = await app.inject({ method: 'GET', url: '/api/system/status' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.unprocessedMessages, 1);
      assert.equal(body.analyze.runCount, 5);
      assert.equal(body.analyze.providerErrorCount, 1);
      assert.equal(body.analyze.lastProviderError, 'boom');
      await app.close();
    } finally {
      close();
    }
  });
});

describe('AnalyzeScheduler — mutex и учёт ошибок', () => {
  function seedChat(db: TestDb): void {
    const ts = Date.now();
    db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES ('a@s.whatsapp.net', 'А', 0, 1)`);
    db.run(sql`INSERT INTO messages (whatsapp_message_id, chat_jid, direction, message_type, text, timestamp, is_from_me, created_at)
      VALUES ('w1', 'a@s.whatsapp.net', 'incoming', 'text', 'Привет', ${ts}, 0, ${ts})`);
  }

  it('параллельные tick() — второй пропускается (mutex)', async () => {
    const { db, close } = openTestDb();
    try {
      seedChat(db);
      let calls = 0;
      const slow = {
        name: 'slow', model: 's', promptVersion: 'v',
        analyzeConversation: async () => {
          calls += 1;
          await new Promise((r) => setTimeout(r, 50));
          return { tasks: [] };
        },
      };
      const sched = new AnalyzeScheduler({ db, log, getProvider: () => slow, intervalMs: 60_000, maxChats: 10, chatTimeoutMs: 5000 });
      const [a, b] = await Promise.all([sched.tick(), sched.tick()]);
      assert.equal(calls, 1);
      assert.equal((a.started ? 1 : 0) + (b.started ? 1 : 0), 1);
      sched.stop();
      close();
    } finally {
      // closed above
    }
  });

  it('ошибка провайдера считается, сообщения остаются необработанными', async () => {
    const { db, close } = openTestDb();
    try {
      seedChat(db);
      const failing = {
        name: 'x', model: 'x', promptVersion: 'v',
        analyzeConversation: async () => {
          throw new Error('LLM down');
        },
      };
      const sched = new AnalyzeScheduler({ db, log, getProvider: () => failing, intervalMs: 60_000, maxChats: 10, chatTimeoutMs: 5000 });
      await sched.tick();
      const m = sched.metricsSnapshot();
      assert.equal(m.providerErrorCount, 1);
      assert.match(m.lastProviderError ?? '', /LLM down/);
      assert.equal(db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM messages WHERE processed_at IS NULL`)?.n, 1);
      sched.stop();
      close();
    } finally {
      // closed above
    }
  });
});
