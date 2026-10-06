import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { openTestDb } from './db.js';
import { assertDigestRecipient, resolveOwnerJid, sendDigest } from '../src/whatsapp/sendGuard.js';
import { DigestService } from '../src/digest/service.js';
import { renderWhatsAppDigest } from '../src/digest/renderer.js';
import { buildDigest } from '../src/digest/builder.js';
import { startOfDay } from '../src/utils/time.js';

const log = pino({ level: 'silent' });
const TZ = 'Asia/Almaty';
const OWNER = '77001234567@s.whatsapp.net';
type TestDb = ReturnType<typeof openTestDb>['db'];

function seedDay(db: TestDb, dayStart: number): void {
  const H = 3_600_000;
  db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES ('a@s.whatsapp.net', 'Айгуль', 0, 1)`);
  db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES ('b@s.whatsapp.net', NULL, 0, 1)`);
  const chatA = db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = 'a@s.whatsapp.net'`)!.id;
  const chatB = db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = 'b@s.whatsapp.net'`)!.id;
  db.run(sql`INSERT INTO contacts (jid, phone, push_name, created_at, updated_at) VALUES ('a@s.whatsapp.net', '1', 'Айгуль', 1, 1)`);
  const t: Array<[number, string, string, string | null, number | null, number]> = [
    // chatId, title, status, dueText, dueAt, createdAt
    [chatA, 'Просрочка', 'open', null, dayStart - H, dayStart - 2 * H],
    [chatA, 'Сегодня', 'open', null, dayStart + 5 * H, dayStart],
    [chatB, 'Безымянная', 'open', null, null, dayStart],
    [chatA, 'Сомнительная', 'needs_review', null, null, dayStart],
    [chatA, 'Готовая', 'done', null, null, dayStart - 2 * H],
  ];
  const jids: Record<number, string> = { [chatA]: 'a@s.whatsapp.net', [chatB]: 'b@s.whatsapp.net' };
  t.forEach(([chatId, title, status, _dt, due, created]) => {
    const closed = status === 'done' ? dayStart + H : null;
    db.run(sql`INSERT INTO tasks (chat_id, chat_jid, title, status, due_at, created_at, updated_at, closed_at)
      VALUES (${chatId}, ${jids[chatId]!}, ${title}, ${status}, ${due}, ${created}, ${created}, ${closed})`);
  });
}

function fakeTransport() {
  const t = {
    sent: [] as string[],
    connected: true,
    isConnected: () => t.connected,
    sendDigestText: async (text: string): Promise<void> => {
      t.sent.push(text);
    },
  };
  return t;
}

describe('шаг 7.1: sendGuard — единственная точка отправки', () => {
  it('владельцу можно, пациенту — исключение', () => {
    assert.doesNotThrow(() => assertDigestRecipient(OWNER, OWNER));
    assert.throws(() => assertDigestRecipient(OWNER, '79998887766@s.whatsapp.net'), /только OWNER_JID/);
    assert.throws(() => assertDigestRecipient('', OWNER), /не задан/);
  });

  it('resolveOwnerJid: телефон превращается в JID', () => {
    assert.equal(resolveOwnerJid('+7 700 123-45-67'), OWNER);
    assert.equal(resolveOwnerJid('77001234567@s.whatsapp.net'), OWNER);
  });

  it('sendDigest шлёт только владельцу и возвращает id', async () => {
    const calls: Array<{ jid: string; text: string }> = [];
    const sock = { sendMessage: async (jid: string, msg: { text: string }) => {
      calls.push({ jid, text: msg.text });
      return { key: { id: 'mid1' } };
    } };
    const id = await sendDigest(sock as never, OWNER, '77001234567@s.whatsapp.net', 'привет');
    assert.equal(id, 'mid1');
    assert.equal(calls.length, 1);
    await assert.rejects(sendDigest(sock as never, OWNER, '79998887766@s.whatsapp.net', 'привет'), /только OWNER_JID/);
    assert.equal(calls.length, 1);
  });

  it('sendMessage вызывается только из sendGuard (grep по src/whatsapp)', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const text = fs.readFileSync(p, 'utf-8');
          if (/\.sendMessage\s*\(/.test(text)) offenders.push(path.relative(process.cwd(), p));
        }
      }
    };
    walk('src/whatsapp');
    assert.deepEqual(offenders, [path.join('src', 'whatsapp', 'sendGuard.ts')]);
  });
});

describe('шаг 7.3: формат WhatsApp-дайджеста', () => {
  it('секции, относительные сроки, неизвестный контакт, needs_review строкой, без уверенности', () => {
    const { db, close } = openTestDb();
    try {
      const dayStart = startOfDay(new Date('2026-10-06T12:00:00+05:00'), TZ);
      seedDay(db, dayStart);
      const digest = buildDigest(db, new Date('2026-10-06T12:00:00+05:00'));
      const text = renderWhatsAppDigest(digest, TZ);
      assert.ok(text.startsWith('📋 Итоги дня'));
      assert.ok(text.includes('🔴'));
      assert.ok(text.includes('🟡'));
      assert.ok(text.includes('✅'));
      assert.ok(text.includes('Срок: сегодня'));
      assert.ok(text.includes('Срок: не указан'));
      assert.ok(text.includes('Неизвестный контакт'));
      assert.ok(text.includes('❓'));
      assert.ok(text.includes('Осталось:'));
      assert.ok(!text.includes('Уверенность'));
      assert.ok(!text.includes('b@s.whatsapp.net'));
    } finally {
      close();
    }
  });
});

describe('шаг 7.2: идемпотентность и повтор после рестарта/офлайна', () => {
  it('двойная отправка — одно сообщение; рестарт (новый инстанс) не дублирует', async () => {
    const { db, close } = openTestDb();
    try {
      const dayStart = startOfDay(new Date('2026-10-06T12:00:00+05:00'), TZ);
      seedDay(db, dayStart);
      const t = fakeTransport();
      const svc = new DigestService(db, log, t, { ownerJid: OWNER, timezone: TZ, digestTime: '18:00' });
      const r1 = await svc.sendToday('manual', new Date('2026-10-06T19:00:00+05:00').getTime());
      assert.equal(r1.sent, true);
      assert.equal(t.sent.length, 1);
      const r2 = await svc.sendToday('manual', new Date('2026-10-06T19:30:00+05:00').getTime());
      assert.equal(r2.sent, false);
      assert.equal(t.sent.length, 1);
      // «рестарт»: новый инстанс сервиса на той же БД
      const t2 = fakeTransport();
      const svc2 = new DigestService(db, log, t2, { ownerJid: OWNER, timezone: TZ, digestTime: '18:00' });
      const r3 = await svc2.sendToday('schedule', new Date('2026-10-06T20:00:00+05:00').getTime());
      assert.equal(r3.sent, false);
      assert.equal(t2.sent.length, 0);
    } finally {
      close();
    }
  });

  it('офлайн — не отправлено; позже, когда связь появилась, — отправлено', async () => {
    const { db, close } = openTestDb();
    try {
      const dayStart = startOfDay(new Date('2026-10-06T12:00:00+05:00'), TZ);
      seedDay(db, dayStart);
      const t = fakeTransport();
      t.connected = false;
      const svc = new DigestService(db, log, t, { ownerJid: OWNER, timezone: TZ, digestTime: '18:00' });
      const r1 = await svc.sendToday('schedule', new Date('2026-10-06T19:00:00+05:00').getTime());
      assert.equal(r1.sent, false);
      assert.equal(t.sent.length, 0);
      t.connected = true;
      const r2 = await svc.sendToday('schedule', new Date('2026-10-06T19:05:00+05:00').getTime());
      assert.equal(r2.sent, true);
      assert.equal(t.sent.length, 1);
    } finally {
      close();
    }
  });

  it('до времени отправки — тихо, без записи', async () => {
    const { db, close } = openTestDb();
    try {
      const dayStart = startOfDay(new Date('2026-10-06T12:00:00+05:00'), TZ);
      seedDay(db, dayStart);
      const t = fakeTransport();
      const svc = new DigestService(db, log, t, { ownerJid: OWNER, timezone: TZ, digestTime: '18:00' });
      const r = await svc.sendToday('schedule', new Date('2026-10-06T17:00:00+05:00').getTime());
      assert.equal(r.sent, false);
      assert.equal(t.sent.length, 0);
    } finally {
      close();
    }
  });
});
