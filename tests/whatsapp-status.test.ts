import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QrStore } from '../src/whatsapp/qr-manager.js';
import { StatusStore } from '../src/whatsapp/status-store.js';

describe('QrStore', () => {
  it('пусто -> set -> clear', () => {
    const q = new QrStore();
    assert.deepEqual(q.snapshot(), { qr: null, updatedAt: null });
    q.set('QR1');
    const s = q.snapshot();
    assert.equal(s.qr, 'QR1');
    assert.ok(typeof s.updatedAt === 'number');
    q.set('QR2'); // Baileys ротирует QR — храним последний
    assert.equal(q.snapshot().qr, 'QR2');
    q.clear();
    assert.deepEqual(q.snapshot(), { qr: null, updatedAt: null });
  });
});

describe('StatusStore', () => {
  it('переходы qr -> connected -> manual disconnect', () => {
    const st = new StatusStore(() => true);
    assert.equal(st.snapshot(false).status, 'disconnected');
    st.onQr();
    const qr = st.snapshot(true);
    assert.equal(qr.status, 'qr_pending');
    assert.equal(qr.qrAvailable, true);
    assert.equal(qr.hasSession, true);
    st.onConnected('7700@s.whatsapp.net');
    const c = st.snapshot(false);
    assert.equal(c.status, 'connected');
    assert.equal(c.phone, '7700@s.whatsapp.net');
    assert.ok(typeof c.connectedAt === 'number');
    st.onManualDisconnect();
    const d = st.snapshot(false);
    assert.equal(d.status, 'disconnected');
    assert.equal(d.phone, null);
  });

  it('logged_out сбрасывает phone и поднимает флаг пересканирования', () => {
    const st = new StatusStore(() => false); // auth уже стёрт
    st.onConnected('7700@s.whatsapp.net');
    st.onLoggedOut();
    const s = st.snapshot(false);
    assert.equal(s.status, 'logged_out');
    assert.equal(s.phone, null);
    assert.equal(s.hasSession, false);
  });
});
