import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { formatSseEvent, mapState, whatsappRoutes, type WhatsAppController } from '../src/server/routes/whatsapp.js';
import type { StatusSnapshot } from '../src/whatsapp/status-store.js';

function stubController(over: Partial<StatusSnapshot> = {}): WhatsAppController & { calls: string[] } {
  const snap: StatusSnapshot = {
    status: 'qr_pending',
    phone: null,
    connectedAt: null,
    lastSeen: 123,
    hasSession: false,
    qrAvailable: true,
    ...over,
  };
  const calls: string[] = [];
  const mapped = (s: StatusSnapshot): StatusSnapshot => s;
  return {
    calls,
    snapshot: () => snap,
    qrString: () => 'QR-STRING',
    on: () => () => {},
    disconnect: () => {
      calls.push('disconnect');
      return mapped({ ...snap, status: 'disconnected', qrAvailable: false });
    },
    connect: async () => {
      calls.push('connect');
      return mapped({ ...snap, status: 'connecting' });
    },
    logout: async () => {
      calls.push('logout');
      return { status: mapped({ ...snap, status: 'logged_out', phone: null }), serverRevoked: true };
    },
  };
}

const qrPng = async (s: string | null): Promise<string | null> =>
  s ? `data:image/png;base64,QR(${s})` : null;

async function buildApp(ctrl: WhatsAppController) {
  const app = Fastify();
  const { SseHub } = await import('../src/server/sse.js');
  await whatsappRoutes(app, ctrl, qrPng, new SseHub());
  return app;
}

describe('whatsapp routes (шаг 5: mapped states, PNG QR, logout)', () => {
  it('mapState: qr_pending→qr, connected→open, disconnected→closed', () => {
    assert.equal(mapState('qr_pending'), 'qr');
    assert.equal(mapState('connected'), 'open');
    assert.equal(mapState('disconnected'), 'closed');
    assert.equal(mapState('connecting'), 'connecting');
    assert.equal(mapState('logged_out'), 'logged_out');
  });

  it('GET /api/whatsapp/status — mapped state', async () => {
    const app = await buildApp(stubController());
    const res = await app.inject({ method: 'GET', url: '/api/whatsapp/status' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      state: 'qr',
      phone: null,
      connectedAt: null,
      lastSeen: 123,
      hasSession: false,
      qrAvailable: true,
    });
    await app.close();
  });

  it('GET /api/whatsapp/qr — PNG data URL', async () => {
    const app = await buildApp(stubController());
    const res = await app.inject({ method: 'GET', url: '/api/whatsapp/qr' });
    assert.equal(res.statusCode, 200);
    assert.match(res.json().dataUrl, /^data:image\/png;base64,/);
    await app.close();
  });

  it('POST disconnect/connect/logout вызывают контроллер', async () => {
    const ctrl = stubController();
    const app = await buildApp(ctrl);
    const d = await app.inject({ method: 'POST', url: '/api/whatsapp/disconnect' });
    assert.equal(d.statusCode, 200);
    assert.equal(d.json().state, 'closed');
    const c = await app.inject({ method: 'POST', url: '/api/whatsapp/connect' });
    assert.equal(c.statusCode, 200);
    assert.equal(c.json().state, 'connecting');
    const bad = await app.inject({ method: 'POST', url: '/api/whatsapp/logout', payload: {} });
    assert.equal(bad.statusCode, 400);
    const l = await app.inject({ method: 'POST', url: '/api/whatsapp/logout', payload: { confirm: true } });
    assert.equal(l.statusCode, 200);
    assert.equal(l.json().state, 'logged_out');
    assert.deepEqual(ctrl.calls, ['disconnect', 'connect', 'logout']);
    await app.close();
  });

  it('formatSseEvent — корректная SSE-рамка', () => {
    assert.equal(formatSseEvent('qr', { qr: 'X' }), 'event: qr\ndata: {"qr":"X"}\n\n');
  });
});
