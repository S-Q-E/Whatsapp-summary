import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { openTestDb } from './db.js';
import { DigestService } from '../src/digest/service.js';
import { renderWhatsAppDigest } from '../src/digest/renderer.js';
import { buildDigest } from '../src/digest/builder.js';
import { runRetention } from '../src/ops/retention.js';
import { processVoiceMessage } from '../src/whatsapp/voice.js';
import { startOfDay } from '../src/utils/time.js';
import type { WAMessage } from '@whiskeysockets/baileys';

const log = pino({ level: 'silent' });
const TZ = 'Asia/Almaty';
const OWNER = '77001234567@s.whatsapp.net';
type TestDb = ReturnType<typeof openTestDb>['db'];

function fakeTransport(delayMs = 0) {
  const t = {
    sent: [] as string[],
    connected: true,
    isConnected: () => t.connected,
    sendDigestText: async (text: string): Promise<void> => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      t.sent.push(text);
    },
  };
  return t;
}

function seedChat(db: TestDb, jid: string): number {
  db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES (${jid}, 'N', 0, 1)`);
  return db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${jid}`)!.id;
}

describe('кнопка «Отправить сейчас» (force до времени)', () => {
  it('(a) force=true в 10:00 реально отправляет', async () => {
    const { db, close } = openTestDb();
    try {
      seedChat(db, 'a@s.whatsapp.net');
      const t = fakeTransport();
      const svc = new DigestService(db, log, t, { ownerJid: OWNER, timezone: TZ, digestTime: '18:00' });
      const r = await svc.sendToday('manual', { force: true, nowMs: new Date('2026-10-06T10:00:00+05:00').getTime() });
      assert.equal(r.sent, true);
      assert.equal(t.sent.length, 1);
    } finally {
      close();
    }
  });

  it('(b) два параллельных sendToday отправляют РОВНО одно сообщение', async () => {
    const { db, close } = openTestDb();
    try {
      seedChat(db, 'a@s.whatsapp.net');
      const t = fakeTransport(50);
      const svc = new DigestService(db, log, t, { ownerJid: OWNER, timezone: TZ, digestTime: '18:00' });
      const nowMs = new Date('2026-10-06T19:00:00+05:00').getTime();
      const [r1, r2] = await Promise.all([svc.sendToday('manual', { nowMs }), svc.sendToday('schedule', { nowMs })]);
      assert.equal(t.sent.length, 1);
      assert.ok((r1.sent && !r2.sent) || (!r1.sent && r2.sent));
    } finally {
      close();
    }
  });

  it('force без resend не шлёт повторно за тот же день', async () => {
    const { db, close } = openTestDb();
    try {
      seedChat(db, 'a@s.whatsapp.net');
      const t = fakeTransport();
      const svc = new DigestService(db, log, t, { ownerJid: OWNER, timezone: TZ, digestTime: '18:00' });
      const nowMs = new Date('2026-10-06T19:00:00+05:00').getTime();
      await svc.sendToday('manual', { force: true, nowMs });
      const r = await svc.sendToday('manual', { force: true, nowMs });
      assert.equal(r.sent, false);
      assert.equal(r.reason, 'already-sent');
      assert.equal(t.sent.length, 1);
    } finally {
      close();
    }
  });
});

describe('ретеншн: тексты, транскрипты, удалённые (c)', () => {
  it('обнуляет text/transcript/sender_name у старых; удалённые — сразу', () => {
    const { db, close } = openTestDb();
    try {
      const now = Date.now();
      const DAY = 86_400_000;
      const chatId = seedChat(db, 'a@s.whatsapp.net');
      const oldTs = now - 40 * DAY;
      db.run(sql`INSERT INTO messages (whatsapp_message_id, chat_jid, chat_id, sender_jid, sender_name, direction, message_type, text, transcript, timestamp, is_from_me, created_at)
        VALUES ('old1', 'a@s.whatsapp.net', ${chatId}, 'x', 'Иван', 'incoming', 'voice', NULL, 'секретный транскрипт', ${oldTs}, 0, ${oldTs})`);
      // молодое, но удалённое — чистится сразу, без оглядки на возраст
      db.run(sql`INSERT INTO messages (whatsapp_message_id, chat_jid, chat_id, direction, message_type, text, transcript, sender_name, timestamp, is_from_me, created_at, deleted_at)
        VALUES ('del1', 'a@s.whatsapp.net', ${chatId}, 'incoming', 'text', 'удалённое', 'тр', 'Петр', ${now - 1000}, 0, ${now - 1000}, ${now - 500})`);
      // молодое живое — не трогаем
      db.run(sql`INSERT INTO messages (whatsapp_message_id, chat_jid, chat_id, direction, message_type, text, timestamp, is_from_me, created_at)
        VALUES ('new1', 'a@s.whatsapp.net', ${chatId}, 'incoming', 'text', 'свежее', ${now}, 0, ${now})`);
      const n = runRetention(db, log, { days: 30, now });
      assert.equal(n, 2);
      const old = db.get<{ text: string | null; transcript: string | null; sender_name: string | null }>(
        sql`SELECT text, transcript, sender_name FROM messages WHERE whatsapp_message_id = 'old1'`);
      assert.equal(old?.text, null);
      assert.equal(old?.transcript, null);
      assert.equal(old?.sender_name, null);
      const del = db.get<{ text: string | null; transcript: string | null }>(
        sql`SELECT text, transcript FROM messages WHERE whatsapp_message_id = 'del1'`);
      assert.equal(del?.text, null);
      assert.equal(del?.transcript, null);
      assert.equal(
        db.get<{ text: string | null }>(sql`SELECT text FROM messages WHERE whatsapp_message_id = 'new1'`)?.text,
        'свежее',
      );
    } finally {
      close();
    }
  });
});

describe('транскрипт сбрасывает processed_at (d)', () => {
  it('после записи transcript сообщение снова необработанное', async () => {
    const { db, close } = openTestDb();
    try {
      const chatId = seedChat(db, 'a@s.whatsapp.net');
      const ts = Date.now();
      db.run(sql`INSERT INTO messages (whatsapp_message_id, chat_jid, chat_id, direction, message_type, text, timestamp, is_from_me, created_at, processed_at)
        VALUES ('v1', 'a@s.whatsapp.net', ${chatId}, 'incoming', 'voice', NULL, ${ts}, 0, ${ts}, ${ts})`);
      const tr = { name: 'fake', model: 'm', transcribe: async () => 'текст' };
      const r = await processVoiceMessage(
        { db, log, transcriber: tr, downloadAudio: async () => Buffer.from('x'), enabled: true },
        {} as WAMessage,
        { chatJid: 'a@s.whatsapp.net', whatsappMessageId: 'v1', messageType: 'voice' },
      );
      assert.equal(r, 'transcribed');
      const row = db.get<{ transcript: string | null; processed_at: number | null }>(
        sql`SELECT transcript, processed_at FROM messages WHERE whatsapp_message_id = 'v1'`);
      assert.equal(row?.transcript, 'текст');
      assert.equal(row?.processed_at, null);
    } finally {
      close();
    }
  });
});

describe('completed без «Срока» в дайджесте (e)', () => {
  it('у выполненной задачи строки Срок нет', () => {
    const { db, close } = openTestDb();
    try {
      const dayStart = startOfDay(new Date('2026-10-06T12:00:00+05:00'), TZ);
      const chatId = seedChat(db, 'a@s.whatsapp.net');
      db.run(sql`INSERT INTO contacts (jid, phone, push_name, created_at, updated_at) VALUES ('a@s.whatsapp.net', '1', 'Айгуль', 1, 1)`);
      db.run(sql`INSERT INTO tasks (chat_id, chat_jid, title, status, due_at, created_at, updated_at, closed_at)
        VALUES (${chatId}, 'a@s.whatsapp.net', 'Готовая', 'done', ${dayStart - 3_600_000}, ${dayStart - 7_200_000}, ${dayStart - 7_200_000}, ${dayStart + 3_600_000})`);
      const digest = buildDigest(db, new Date('2026-10-06T12:00:00+05:00'));
      const text = renderWhatsAppDigest(digest, TZ);
      assert.ok(text.includes('✅'));
      const lines = text.split('\n');
      const idx = lines.findIndex((l) => l.includes('Готовая'));
      assert.ok(idx >= 0);
      assert.ok(!lines.slice(idx, idx + 3).some((l) => l.includes('Срок')), 'у completed нет строки Срок');
    } finally {
      close();
    }
  });
});
