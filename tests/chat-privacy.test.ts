import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { openTestDb } from './db.js';
import {
  ensureChat,
  isChatIgnored,
  mergeChats,
  recordAlias,
  recordAliasAndMerge,
  resolveCanonical,
  setChatIgnored,
  storeMessage,
  upsertContact,
} from '../src/whatsapp/store.js';
import { loadPendingBundles } from '../src/ai/taskService.js';

const log = pino({ level: 'silent' });
type TestDb = ReturnType<typeof openTestDb>['db'];
const NOW = 1_800_000_000_000;

function seedChat(db: TestDb, jid: string, displayName: string | null = 'N'): number {
  const isGroup = jid.endsWith('@g.us') ? 1 : 0;
  db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES (${jid}, ${displayName}, ${isGroup}, 1)`);
  return db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${jid}`)!.id;
}

function seedMsg(db: TestDb, chatJid: string, chatId: number, wamid: string, ts: number, text = 't'): number {
  db.run(sql`INSERT INTO messages
    (whatsapp_message_id, chat_jid, chat_id, sender_jid, direction, message_type, text, timestamp, is_from_me, created_at)
    VALUES (${wamid}, ${chatJid}, ${chatId}, ${chatJid}, 'incoming', 'text', ${text}, ${ts}, 0, ${ts})`);
  return db.get<{ id: number }>(sql`SELECT last_insert_rowid() AS id`)!.id;
}

describe('приватность: игнор по LID распространяется на PN-чат (a)', () => {
  it('чат по номеру тоже игнорируется после алиаса', () => {
    const { db, close } = openTestDb();
    try {
      const lidId = seedChat(db, '111@lid');
      seedMsg(db, '111@lid', lidId, 'w1', NOW - 1000);
      setChatIgnored(db, lidId, 1);
      assert.equal(isChatIgnored(db, lidId), true);
      // новое сообщение под тем же человеком приходит уже под PN:
      // продакшн-флоу: recordAliasAndMerge (запись + слияние) -> store
      const rec = recordAliasAndMerge(db, log, { aliasJid: '111@lid', canonicalJid: '77001112233@s.whatsapp.net' });
      assert.ok(rec !== null);
      assert.equal(rec.messagesMoved, 1);
      storeMessage(db, log, {
        whatsappMessageId: 'w2', chatJid: '77001112233@s.whatsapp.net', senderJid: '77001112233@s.whatsapp.net',
        senderName: null, direction: 'incoming', messageType: 'text', text: 'секретный текст',
        durationSec: null, timestampMs: NOW, isFromMe: false, pushName: null,
      });
      const bundles = loadPendingBundles(db, { now: NOW });
      assert.deepEqual(bundles.map((b) => b.chatJid), []);
    } finally {
      close();
    }
  });

  it('повторный recordAlias той же пары — не новый (isNew false)', () => {
    const { db, close } = openTestDb();
    try {
      assert.equal(recordAlias(db, log, { aliasJid: '1@lid', canonicalJid: '7700@s.whatsapp.net' }).isNew, true);
      assert.equal(recordAlias(db, log, { aliasJid: '1@lid', canonicalJid: '7700@s.whatsapp.net' }).isNew, false);
      assert.equal(resolveCanonical(db, '1@lid'), '7700@s.whatsapp.net');
    } finally {
      close();
    }
  });
});

describe('mergeChats вызывается при новом алиасе (b)', () => {
  it('recordAliasAndMerge сливает существующие чаты с данными', () => {
    const { db, close } = openTestDb();
    try {
      const lidId = seedChat(db, '222@lid');
      seedMsg(db, '222@lid', lidId, 'w1', NOW - 1000);
      const pnId = seedChat(db, '77002223344@s.whatsapp.net');
      seedMsg(db, '77002223344@s.whatsapp.net', pnId, 'w2', NOW - 500);
      const res = recordAliasAndMerge(db, log, { aliasJid: '222@lid', canonicalJid: '77002223344@s.whatsapp.net' });
      assert.ok(res !== null);
      assert.equal(res.messagesMoved, 1); // только сообщение LID-чата переехало; своё у PN осталось
      assert.equal(
        db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM chats WHERE jid IN ('222@lid','77002223344@s.whatsapp.net')`)?.n,
        1,
      );
    } finally {
      close();
    }
  });

  it('без существующих чатов — no-op, ничего не падает', () => {
    const { db, close } = openTestDb();
    try {
      const res = recordAliasAndMerge(db, log, { aliasJid: '333@lid', canonicalJid: '77003334455@s.whatsapp.net' });
      assert.equal(res, null);
    } finally {
      close();
    }
  });
});

describe('merge с дублирующимся wamid (c)', () => {
  it('не падает, дубль удаляется, ссылки задач переносятся', () => {
    const { db, close } = openTestDb();
    try {
      const lidId = seedChat(db, '444@lid');
      const dupLid = seedMsg(db, '444@lid', lidId, 'same-w', NOW - 1000, 'старый текст');
      const pnId = seedChat(db, '77004445566@s.whatsapp.net');
      seedMsg(db, '77004445566@s.whatsapp.net', pnId, 'same-w', NOW - 900, 'новый текст');
      db.run(sql`INSERT INTO tasks (chat_id, chat_jid, title, status, source_message_id, created_at, updated_at)
        VALUES (${lidId}, '444@lid', 'Позвонить', 'open', ${dupLid}, 1, 1)`);
      const res = mergeChats(db, log, { fromJid: '444@lid', intoJid: '77004445566@s.whatsapp.net' });
      assert.equal(res.messagesMoved, 0); // единственное сообщение LID-чата оказалось дублем и удалено
      assert.equal(res.tasksMoved, 1);
      // дубль один: wamid встречается ровно раз
      assert.equal(
        db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM messages WHERE whatsapp_message_id = 'same-w'`)?.n,
        1,
      );
      // задача переехала и ссылается на выжившее сообщение
      const task = db.get<{ chat_jid: string; source_message_id: number }>(
        sql`SELECT chat_jid, source_message_id FROM tasks WHERE title = 'Позвонить'`,
      );
      assert.equal(task?.chat_jid, '77004445566@s.whatsapp.net');
      const survivor = db.get<{ id: number }>(sql`SELECT id FROM messages WHERE whatsapp_message_id = 'same-w'`);
      assert.equal(task?.source_message_id, survivor?.id);
    } finally {
      close();
    }
  });

  it('откат при ошибке: данные обоих чатов нетронуты', () => {
    const { db, close } = openTestDb();
    try {
      const lidId = seedChat(db, '555@lid');
      seedMsg(db, '555@lid', lidId, 'w1', NOW - 1000);
      const pnId = seedChat(db, '77005556677@s.whatsapp.net');
      seedMsg(db, '77005556677@s.whatsapp.net', pnId, 'w2', NOW - 500);
      assert.throws(
        () => mergeChats(db, log, { fromJid: '555@lid', intoJid: '77005556677@s.whatsapp.net' }, { failAfter: 'dedupe' }),
        /inject/,
      );
      // оба чата на месте, сообщения не сдвинуты
      assert.equal(
        db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM chats WHERE jid IN ('555@lid','77005556677@s.whatsapp.net')`)?.n,
        2,
      );
      assert.equal(
        db.get<{ chat_jid: string }>(sql`SELECT chat_jid FROM messages WHERE whatsapp_message_id = 'w1'`)?.chat_jid,
        '555@lid',
      );
      assert.equal(
        db.get<{ chat_jid: string }>(sql`SELECT chat_jid FROM messages WHERE whatsapp_message_id = 'w2'`)?.chat_jid,
        '77005556677@s.whatsapp.net',
      );
    } finally {
      close();
    }
  });
});

describe('merge переносит настройки и контакты (d)', () => {
  it('ignored = OR, задачи переезжают, push_name контакта сохраняется', () => {
    const { db, close } = openTestDb();
    try {
      const lidId = seedChat(db, '666@lid', 'Доктор');
      seedMsg(db, '666@lid', lidId, 'w1', NOW - 1000);
      const pnId = seedChat(db, '77006667788@s.whatsapp.net', null);
      seedMsg(db, '77006667788@s.whatsapp.net', pnId, 'w2', NOW - 500);
      upsertContact(db, log, { jid: '666@lid', pushName: 'Доктор Ли' });
      setChatIgnored(db, lidId, 1);
      db.run(sql`INSERT INTO tasks (chat_id, chat_jid, title, status, created_at, updated_at)
        VALUES (${lidId}, '666@lid', 'Задача', 'open', 1, 1)`);
      mergeChats(db, log, { fromJid: '666@lid', intoJid: '77006667788@s.whatsapp.net' });
      assert.equal(isChatIgnored(db, pnId), true);
      assert.equal(
        db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tasks WHERE chat_jid = '77006667788@s.whatsapp.net'`)?.n,
        1,
      );
      const c = db.get<{ push_name: string | null }>(
        sql`SELECT push_name FROM contacts WHERE jid = '77006667788@s.whatsapp.net'`,
      );
      assert.equal(c?.push_name, 'Доктор Ли');
      assert.equal(
        db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM contacts WHERE jid = '666@lid'`)?.n,
        0,
      );
    } finally {
      close();
    }
  });
});

describe('ANALYZE_NEW_CHATS и имена (п.4, п.5)', () => {
  it('direct по умолчанию: группы без явного разрешения не анализируются', () => {
    const { db, close } = openTestDb();
    try {
      const gId = seedChat(db, '123-456@g.us');
      seedMsg(db, '123-456@g.us', gId, 'w1', NOW - 1000);
      const dId = seedChat(db, '77007778899@s.whatsapp.net');
      seedMsg(db, '77007778899@s.whatsapp.net', dId, 'w2', NOW - 1000);
      assert.deepEqual(
        loadPendingBundles(db, { now: NOW, newChats: 'direct' }).map((b) => b.chatJid),
        ['77007778899@s.whatsapp.net'],
      );
      assert.deepEqual(
        loadPendingBundles(db, { now: NOW, newChats: 'all' }).map((b) => b.chatJid).sort(),
        ['123-456@g.us', '77007778899@s.whatsapp.net'],
      );
      assert.deepEqual(loadPendingBundles(db, { now: NOW, newChats: 'none' }).map((b) => b.chatJid), []);
      // явное разрешение группы перекрывает политику
      setChatIgnored(db, gId, 0);
      assert.ok(
        loadPendingBundles(db, { now: NOW, newChats: 'direct' }).map((b) => b.chatJid).includes('123-456@g.us'),
      );
    } finally {
      close();
    }
  });

  it('ensureChat: имя группы не затирается репликами; личка пишется только входящим pushName', () => {
    const { db, close } = openTestDb();
    try {
      ensureChat(db, log, { jid: '777-888@g.us', displayName: 'Рабочий чат', source: 'group-meta' });
      ensureChat(db, log, { jid: '777-888@g.us', displayName: 'Вася', source: 'chat-message' });
      assert.equal(
        db.get<{ display_name: string }>(sql`SELECT display_name FROM chats WHERE jid = '777-888@g.us'`)?.display_name,
        'Рабочий чат',
      );
      ensureChat(db, log, { jid: '77009990011@s.whatsapp.net', displayName: 'Я сама', source: 'own-message' });
      assert.equal(
        db.get<{ display_name: string | null }>(sql`SELECT display_name FROM chats WHERE jid = '77009990011@s.whatsapp.net'`)?.display_name,
        null,
      );
      ensureChat(db, log, { jid: '77009990011@s.whatsapp.net', displayName: 'Пациент', source: 'incoming-message' });
      assert.equal(
        db.get<{ display_name: string | null }>(sql`SELECT display_name FROM chats WHERE jid = '77009990011@s.whatsapp.net'`)?.display_name,
        'Пациент',
      );
    } finally {
      close();
    }
  });

  it('contacts.push_name групповых jid не пишется', () => {
    const { db, close } = openTestDb();
    try {
      upsertContact(db, log, { jid: '999-000@g.us', pushName: 'Вася' });
      assert.equal(
        db.get<{ push_name: string | null }>(sql`SELECT push_name FROM contacts WHERE jid = '999-000@g.us'`)?.push_name,
        null,
      );
      upsertContact(db, log, { jid: '77001112233@s.whatsapp.net', pushName: 'Пациент' });
      assert.equal(
        db.get<{ push_name: string | null }>(sql`SELECT push_name FROM contacts WHERE jid = '77001112233@s.whatsapp.net'`)?.push_name,
        'Пациент',
      );
    } finally {
      close();
    }
  });
});
