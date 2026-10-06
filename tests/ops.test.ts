import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { openTestDb } from './db.js';
import { runBackup, rotateBackups } from '../src/ops/backup.js';
import { runRetention } from '../src/ops/retention.js';
import { loadPendingBundles } from '../src/ai/taskService.js';
import { setChatIgnored, storeMessage } from '../src/whatsapp/store.js';

const silent = pino({ level: 'silent' });
type TestDb = ReturnType<typeof openTestDb>['db'];
const DAY = 86_400_000;

function seedChat(db: TestDb, jid: string): number {
  db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES (${jid}, 'N', 0, 1)`);
  return db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${jid}`)!.id;
}

describe('шаг 9: ретеншн текстов', () => {
  it('тексты старше срока зануляются, задачи/ссылки/новые — целы', () => {
    const { db, close } = openTestDb();
    try {
      const now = Date.now();
      const chatId = seedChat(db, 'a@s.whatsapp.net');
      const oldTs = now - 40 * DAY;
      db.run(sql`INSERT INTO messages (whatsapp_message_id, chat_jid, chat_id, direction, message_type, text, timestamp, is_from_me, created_at)
        VALUES ('old1', 'a@s.whatsapp.net', ${chatId}, 'incoming', 'text', 'старый секрет', ${oldTs}, 0, ${oldTs})`);
      const oldId = db.get<{ id: number }>(sql`SELECT last_insert_rowid() AS id`)!.id;
      db.run(sql`INSERT INTO messages (whatsapp_message_id, chat_jid, chat_id, direction, message_type, text, timestamp, is_from_me, created_at)
        VALUES ('new1', 'a@s.whatsapp.net', ${chatId}, 'incoming', 'text', 'свежий текст', ${now}, 0, ${now})`);
      db.run(sql`INSERT INTO tasks (chat_id, chat_jid, title, status, source_message_id, created_at, updated_at)
        VALUES (${chatId}, 'a@s.whatsapp.net', 'Старая задача', 'done', ${oldId}, ${oldTs}, ${oldTs})`);
      const nulled = runRetention(db, silent, { days: 30, now });
      assert.equal(nulled, 1);
      assert.equal(db.get<{ text: string | null }>(sql`SELECT text FROM messages WHERE whatsapp_message_id = 'old1'`)?.text, null);
      assert.equal(db.get<{ text: string | null }>(sql`SELECT text FROM messages WHERE whatsapp_message_id = 'new1'`)?.text, 'свежий текст');
      // задача и ссылка на сообщение живы
      assert.equal(db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tasks`)?.n, 1);
      assert.equal(db.get<{ source_message_id: number | null }>(sql`SELECT source_message_id FROM tasks`)?.source_message_id, oldId);
      // повтор идемпотентен
      assert.equal(runRetention(db, silent, { days: 30, now }), 0);
    } finally {
      close();
    }
  });

  it('retention 0 = выключено', () => {
    const { db, close } = openTestDb();
    try {
      assert.equal(runRetention(db, silent, { days: 0, now: Date.now() }), 0);
    } finally {
      close();
    }
  });
});

describe('шаг 9: бэкапы sqlite', () => {
  it('backup — валидная копия; повтор в те же сутки пропускается; ротация держит N', async () => {
    const { db, close } = openTestDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waback-'));
    try {
      seedChat(db, 'a@s.whatsapp.net');
      // бэкапу нужен файловый БД: копируем текущую :memory: в файл
      const file = path.join(dir, 'src.db');
      const fileDb = new Database(file);
      fileDb.exec(`CREATE TABLE chats AS SELECT * FROM (SELECT 1 AS id, 'a' AS jid, 'N' AS display_name, 0 AS is_group, 1 AS created_at)`);
      fileDb.close();
      const p1 = await runBackup(file, dir, 2, silent, { timezone: 'Asia/Almaty' });
      assert.ok(p1 && fs.existsSync(p1));
      assert.ok(!p1.includes('auth'), 'auth не копируется — только sqlite файл');
      const check = new Database(p1, { readonly: true });
      assert.equal((check.prepare(`SELECT COUNT(*) AS n FROM chats`).get() as { n: number }).n, 1);
      check.close();
      // тот же день — пропуск, нового файла нет
      const p2 = await runBackup(file, dir, 2, silent, { timezone: 'Asia/Almaty' });
      assert.equal(p2, null);
      // ротация на файлах прошлых дней
      fs.writeFileSync(path.join(dir, 'whatsapp-2020-01-01T00-00-00.db'), 'x');
      fs.writeFileSync(path.join(dir, 'whatsapp-2020-01-02T00-00-00.db'), 'x');
      fs.writeFileSync(path.join(dir, 'whatsapp-2020-01-03T00-00-00.db'), 'x');
      const kept = rotateBackups(dir, 2, silent);
      assert.equal(kept, 2);
      close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('шаг 9: игнорируемые чаты не идут в AI', () => {
  it('чат с ignored=1 исключается из бандлов анализа', () => {
    const { db, close } = openTestDb();
    try {
      const now = Date.now();
      for (const jid of ['a@s.whatsapp.net', 'b@s.whatsapp.net']) {
        const chatId = seedChat(db, jid);
        db.run(sql`INSERT INTO messages (whatsapp_message_id, chat_jid, chat_id, direction, message_type, text, timestamp, is_from_me, created_at)
          VALUES (${`w-${jid}`}, ${jid}, ${chatId}, 'incoming', 'text', 'секретный текст', ${now}, 0, ${now})`);
      }
      db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES ('b@s.whatsapp.net', 'B', 0, 1)
        ON CONFLICT(jid) DO NOTHING`);
      setChatIgnored(db, db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = 'b@s.whatsapp.net'`)!.id, 1);
      const bundles = loadPendingBundles(db, { now });
      assert.deepEqual(bundles.map((b) => b.chatJid), ['a@s.whatsapp.net']);
    } finally {
      close();
    }
  });
});

describe('шаг 9: в логах нет текстов (info-уровень)', () => {
  it('storeMessage на info не пишет текст сообщения', () => {
    const { db, close } = openTestDb();
    try {
      let out = '';
      const memLog = pino({ level: 'info' }, { write: (s: string) => { out += s; } });
      seedChat(db, 'a@s.whatsapp.net');
      storeMessage(db, memLog, {
        whatsappMessageId: 'w1',
        chatJid: 'a@s.whatsapp.net',
        senderJid: 'a@s.whatsapp.net',
        senderName: null,
        direction: 'incoming',
        messageType: 'text',
        text: 'СУПЕРСЕКРЕТ-48151623',
        durationSec: null,
        timestampMs: Date.now(),
        isFromMe: false,
        pushName: null,
      });
      assert.ok(!out.includes('СУПЕРСЕКРЕТ-48151623'));
    } finally {
      close();
    }
  });
});
