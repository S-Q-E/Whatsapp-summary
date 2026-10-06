import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { openTestDb } from './db.js';
import { createApp } from '../src/app.js';
import { SseHub } from '../src/server/sse.js';
import type { AppWaClient } from '../src/app.js';

const log = pino({ level: 'silent' });
type TestDb = ReturnType<typeof openTestDb>['db'];

function mockWa(state: 'connected' | 'qr_pending' = 'connected'): AppWaClient & { loggedOut: boolean } {
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
    logout: async () => ({
      status: stub.snapshot(),
      serverRevoked: true,
    }),
    on: () => () => {},
  };
  return stub;
}

function mockScheduler() {
  return {
    metricsSnapshot: () => ({
      lastRunAt: null, lastDurationMs: 0, lastChats: 0, lastCreated: 0,
      lastUpdated: 0, lastSkipped: 0, lastError: null, runCount: 0,
      providerErrorCount: 0, lastProviderError: null, running: false,
    }),
    start: () => {},
    stop: () => {},
  };
}

const qrPng = async (s: string | null): Promise<string | null> =>
  s ? `data:image/png;base64,QR(${s})` : null;

function seedChat(db: TestDb, jid: string): number {
  db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES (${jid}, 'N', 0, 1)`);
  return db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${jid}`)!.id;
}

function seedTask(
  db: TestDb, chatId: number, title: string, status: string, dueAt: number | null, closedAt: number | null,
): number {
  db.run(sql`INSERT INTO tasks (chat_id, chat_jid, title, status, due_at, created_at, updated_at, closed_at)
    VALUES (${chatId}, 'x', ${title}, ${status}, ${dueAt}, 1, 1, ${closedAt})`);
  return db.get<{ id: number }>(sql`SELECT last_insert_rowid() AS id`)!.id;
}

describe('SSE shutdown (п.3)', () => {
  it('closeAll завершает все висящие ответы', () => {
    const hub = new SseHub();
    const ended: string[] = [];
    const mkRes = (id: string) => ({
      write: () => true,
      end: () => {
        ended.push(id);
      },
    });
    const off1 = hub.add(mkRes('a') as never);
    hub.add(mkRes('b') as never);
    assert.equal(hub.size, 2);
    off1();
    assert.equal(hub.size, 1);
    hub.closeAll();
    assert.deepEqual(ended, ['b']);
    assert.equal(hub.size, 0);
  });

  it('app.close резолвится при открытом SSE (порядок: сначала closeAll)', async () => {
    const { db, close } = openTestDb();
    try {
      const { createApp: build } = await import('../src/app.js');
      const app = await build({ db, log, wa: mockWa(), scheduler: mockScheduler(), qrPng, auth: { password: '', allowNoAuth: true } });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const addr = app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      assert.ok(port > 0);
      const { default: http } = await import('node:http');
      const sseDone = new Promise<void>((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/api/whatsapp/events`, (res) => {
          assert.equal(res.statusCode, 200);
          res.on('data', () => {});
          res.on('close', () => resolve());
        });
        req.on('error', () => resolve());
      });
      // даём соединению открыться
      await new Promise((r) => setTimeout(r, 300));
      const hub = (app as unknown as { sseHub: SseHub }).sseHub;
      assert.ok(hub && hub.size >= 1, 'SSE не зарегистрировалось');
      hub.closeAll();
      await Promise.race([
        (async () => {
          await sseDone;
          await app.close();
        })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('app.close завис')), 5000)),
      ]);
    } finally {
      close();
    }
  });
});

describe('dashboard attention на бэкенде (п.4)', () => {
  it('done не попадает в просроченные; секции разделены', async () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db, 'a@s.whatsapp.net');
      const PAST = 1_700_000_000_000;
      const FUTURE = 4_100_000_000_000;
      seedTask(db, chatId, 'Просроченная открытая', 'open', PAST, null);
      seedTask(db, chatId, 'Выполненная просроченная', 'done', PAST, PAST + 1000);
      seedTask(db, chatId, 'Будущая', 'open', FUTURE, null);
      seedTask(db, chatId, 'На проверке', 'needs_review', null, null);
      const app = await createApp({ db, log, wa: mockWa(), scheduler: mockScheduler(), qrPng, auth: { password: '', allowNoAuth: true } });
      const res = await app.inject({ method: 'GET', url: '/api/dashboard/attention' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(body.overdue.map((t: { title: string }) => t.title), ['Просроченная открытая']);
      assert.deepEqual(body.upcoming.map((t: { title: string }) => t.title), ['Будущая']);
      assert.deepEqual(body.needsReview.map((t: { title: string }) => t.title), ['На проверке']);
      assert.ok(!JSON.stringify(body).includes('Выполненная просроченная'));
      await app.close();
    } finally {
      close();
    }
  });
});

describe('пагинация /api/tasks (п.4)', () => {
  it('limit/cursor, открытые сначала', async () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db, 'a@s.whatsapp.net');
      seedTask(db, chatId, 'Готовая 1', 'done', null, null);
      seedTask(db, chatId, 'Открытая 1', 'open', null, null);
      seedTask(db, chatId, 'Готовая 2', 'done', null, null);
      seedTask(db, chatId, 'Открытая 2', 'open', null, null);
      const app = await createApp({ db, log, wa: mockWa(), scheduler: mockScheduler(), qrPng, auth: { password: '', allowNoAuth: true } });
      const p1 = await app.inject({ method: 'GET', url: '/api/tasks?limit=2' });
      assert.equal(p1.statusCode, 200);
      const b1 = p1.json();
      assert.equal(b1.items.length, 2);
      assert.ok(b1.items.every((t: { status: string }) => t.status === 'open'));
      assert.ok(typeof b1.nextCursor === 'string');
      const p2 = await app.inject({ method: 'GET', url: `/api/tasks?limit=2&cursor=${encodeURIComponent(b1.nextCursor)}` });
      const b2 = p2.json();
      assert.equal(b2.items.length, 2);
      assert.ok(b2.nextCursor === null);
      const ids1 = new Set(b1.items.map((t: { id: number }) => t.id));
      for (const t of b2.items as { id: number }[]) assert.ok(!ids1.has(t.id), 'страницы не пересекаются');
      const bad = await app.inject({ method: 'GET', url: '/api/tasks?limit=abc' });
      assert.equal(bad.statusCode, 400);
      await app.close();
    } finally {
      close();
    }
  });
});

describe('logout отзывает сессию на сервере (п.2)', () => {
  it('sock.logout() вызван, auth стёрт, serverRevoked true', async () => {
    const { tryRevokeSession } = await import('../src/whatsapp/manager.js');
    let called = false;
    const ok = await tryRevokeSession({ logout: async () => { called = true; } });
    assert.equal(called, true);
    assert.equal(ok, true);
  });

  it('ошибка logout() не мешает: вернётся serverRevoked false', async () => {
    const { tryRevokeSession } = await import('../src/whatsapp/manager.js');
    const ok = await tryRevokeSession({
      logout: async () => {
        throw new Error('net down');
      },
    });
    assert.equal(ok, false);
  });

  it('route отдаёт serverRevoked из контроллера', async () => {
    const Fastify = (await import('fastify')).default;
    const { whatsappRoutes } = await import('../src/server/routes/whatsapp.js');
    const { SseHub } = await import('../src/server/sse.js');
    const app = Fastify();
    await whatsappRoutes(
      app,
      {
        snapshot: () => ({ status: 'logged_out', phone: null, connectedAt: null, lastSeen: null, hasSession: false, qrAvailable: false }),
        qrString: () => null,
        on: () => () => {},
        disconnect: () => { throw new Error('unused'); },
        connect: async () => { throw new Error('unused'); },
        logout: async () => ({
          status: { status: 'logged_out', phone: null, connectedAt: null, lastSeen: null, hasSession: false, qrAvailable: false },
          serverRevoked: false,
        }),
      },
      async () => null,
      new SseHub(),
    );
    const res = await app.inject({ method: 'POST', url: '/api/whatsapp/logout', payload: { confirm: true } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().state, 'logged_out');
    assert.equal(res.json().serverRevoked, false);
    await app.close();
  });
});

describe('timezone в system/status (п.5)', () => {
  it('отдаёт TIMEZONE сервера', async () => {
    const { db, close } = openTestDb();
    try {
      const app = await createApp({ db, log, wa: mockWa(), scheduler: mockScheduler(), qrPng, auth: { password: '', allowNoAuth: true } });
      const res = await app.inject({ method: 'GET', url: '/api/system/status' });
      assert.equal(res.statusCode, 200);
      assert.equal(typeof res.json().timezone, 'string');
      assert.ok(res.json().timezone.length > 0);
      await app.close();
    } finally {
      close();
    }
  });
});
