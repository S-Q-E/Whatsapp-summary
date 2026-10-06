import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { openTestDb } from './db.js';
import { createApp } from '../src/app.js';
import { Auth, SESSION_COOKIE } from '../src/server/auth.js';

const log = pino({ level: 'silent' });

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
const AUTH = { password: 'secret', loginMaxAttempts: 100, loginWindowMs: 60_000 };

async function loginCookie(app: Awaited<ReturnType<typeof createApp>>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'secret' } });
  assert.equal(res.statusCode, 200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

describe('обход авторизации через кодирование пути', () => {
  const vectors = [
    ['GET', '/%61pi/tasks'],
    ['GET', '/%61pi/dashboard'],
    ['GET', '/%61pi/chats'],
    ['GET', '/api/%74asks'],
    ['GET', '/API/tasks'],
    ['GET', '//api/tasks'],
    ['GET', '/api/tasks/../tasks'],
    ['POST', '/%61pi/whatsapp/connect'],
    ['PATCH', '/%61pi/tasks/1'],
  ] as Array<['GET' | 'POST' | 'PATCH', string]>;

  for (const [method, url] of vectors) {
    it(`${method} ${url} без cookie — никогда не 200`, async () => {
      const { db, close } = openTestDb();
      try {
        const app = await createApp({ db, log, wa: waStub, scheduler: schedStub, qrPng, auth: AUTH });
        const res = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
        // 401 (закрыто), 404 (нет такого пути) или 403 (клиент распарсил URL как чужой host) —
        // главное: никогда не 200 и не данные.
        assert.ok(res.statusCode === 401 || res.statusCode === 404 || res.statusCode === 403, `получен ${res.statusCode}`);
        assert.notEqual(res.statusCode, 200);
        await app.close();
      } finally {
        close();
      }
    });
  }

  it('с валидной cookie — как раньше (200)', async () => {
    const { db, close } = openTestDb();
    try {
      const app = await createApp({ db, log, wa: waStub, scheduler: schedStub, qrPng, auth: AUTH });
      const cookie = await loginCookie(app);
      const res = await app.inject({ method: 'GET', url: '/api/tasks', headers: { cookie } });
      assert.equal(res.statusCode, 200);
      await app.close();
    } finally {
      close();
    }
  });
});

describe('default-deny и Host', () => {
  it('неизвестный /api путь без cookie — 404, не 200 и не данные', async () => {
    const { db, close } = openTestDb();
    try {
      const app = await createApp({ db, log, wa: waStub, scheduler: schedStub, qrPng, auth: AUTH });
      const res = await app.inject({ method: 'GET', url: '/api/no-such-thing' });
      assert.equal(res.statusCode, 404);
      await app.close();
    } finally {
      close();
    }
  });

  it('чужой Host — 403 даже с валидной cookie', async () => {
    const { db, close } = openTestDb();
    try {
      const app = await createApp({ db, log, wa: waStub, scheduler: schedStub, qrPng, auth: AUTH });
      const cookie = await loginCookie(app);
      const res = await app.inject({
        method: 'GET', url: '/api/tasks', headers: { cookie, host: 'evil.example.com' },
      });
      assert.equal(res.statusCode, 403);
      await app.close();
    } finally {
      close();
    }
  });

  it('ALLOWED_HOSTS пропускает свой домен', async () => {
    const { db, close } = openTestDb();
    try {
      const app = await createApp({
        db, log, wa: waStub, scheduler: schedStub, qrPng,
        auth: { ...AUTH, allowedHosts: ['home.example.com'] },
      });
      const cookie = await loginCookie(app);
      const res = await app.inject({
        method: 'GET', url: '/api/tasks', headers: { cookie, host: 'home.example.com' },
      });
      assert.equal(res.statusCode, 200);
      await app.close();
    } finally {
      close();
    }
  });
});

describe('mutating-запросы без Content-Type/X-Requested-With', () => {
  it('POST /api/whatsapp/connect без маркеров — 400 даже с cookie', async () => {
    const { db, close } = openTestDb();
    try {
      const app = await createApp({ db, log, wa: waStub, scheduler: schedStub, qrPng, auth: AUTH });
      const cookie = await loginCookie(app);
      const res = await app.inject({
        method: 'POST', url: '/api/whatsapp/connect',
        headers: { cookie, 'content-type': 'text/plain' },
        payload: 'x=1',
      });
      assert.equal(res.statusCode, 400);
      await app.close();
    } finally {
      close();
    }
  });
});

describe('сессии: TTL, Secure, Max-Age', () => {
  it('cookie содержит Max-Age=604800, HttpOnly, SameSite; Secure только для https', () => {
    const auth = new Auth({ password: 'secret' });
    const token = auth.createSession();
    const http = auth.sessionCookieHeader(token, { secure: false });
    assert.ok(http.includes('Max-Age=604800'));
    assert.ok(http.includes('HttpOnly'));
    assert.ok(http.includes('SameSite=Lax'));
    assert.ok(!http.includes('Secure'));
    assert.ok(auth.sessionCookieHeader(token, { secure: true }).includes('Secure'));
  });

  it('просроченная сессия не принимается', () => {
    const auth = new Auth({ password: 'secret', sessionTtlMs: 1000 });
    const token = auth.createSession(1_000_000);
    assert.equal(auth.checkCookie(`${SESSION_COOKIE}=${token}`, 1_000_500), true);
    assert.equal(auth.checkCookie(`${SESSION_COOKIE}=${token}`, 1_002_000), false);
  });
});
