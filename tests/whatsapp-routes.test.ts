import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { formatSseEvent, whatsappRoutes, type WhatsAppController } from '../src/server/routes/whatsapp.js';
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
  return {
    calls,
    snapshot: () => snap,
    qrSnapshot: () => ({ qr: 'QR-STRING', updatedAt: 456 }),
    on: () => () => {},
    disconnect: () => {
      calls.push('disconnect');
      return { ...snap, status: 'disconnected', qrAvailable: false };
    },
    connect: async () => {
      calls.push('connect');
      return { ...snap, status: 'connecting' };
    },
  };
}

async function buildApp(ctrl: WhatsAppController) {
  const app = Fastify();
  await whatsappRoutes(app, ctrl);
  return app;
}

describe('whatsapp routes', () => {
  it('GET /api/whatsapp/status — контракт Zod', async () => {
    const app = await buildApp(stubController());
    const res = await app.inject({ method: 'GET', url: '/api/whatsapp/status' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      status: 'qr_pending',
      phone: null,
      connectedAt: null,
      lastSeen: 123,
      hasSession: false,
      qrAvailable: true,
    });
    await app.close();
  });

  it('GET /api/whatsapp/qr — сырая строка для фронта', async () => {
    const app = await buildApp(stubController());
    const res = await app.inject({ method: 'GET', url: '/api/whatsapp/qr' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { qr: 'QR-STRING', updatedAt: 456 });
    await app.close();
  });

  it('POST disconnect/connect вызывают контроллер и возвращают статус', async () => {
    const ctrl = stubController();
    const app = await buildApp(ctrl);
    const d = await app.inject({ method: 'POST', url: '/api/whatsapp/disconnect' });
    assert.equal(d.statusCode, 200);
    assert.equal(d.json().status, 'disconnected');
    const c = await app.inject({ method: 'POST', url: '/api/whatsapp/connect' });
    assert.equal(c.statusCode, 200);
    assert.equal(c.json().status, 'connecting');
    assert.deepEqual(ctrl.calls, ['disconnect', 'connect']);
    await app.close();
  });

  it('formatSseEvent — корректная SSE-рамка', () => {
    assert.equal(formatSseEvent('qr', { qr: 'X' }), 'event: qr\ndata: {"qr":"X"}\n\n');
  });
});
