import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { openTestDb } from './db.js';
import {
  parseWAMessage,
  type ProtocolEvent,
} from '../src/whatsapp/messageParser.js';
import {
  applyEdit,
  applyRevoke,
  mergeChats,
  recordAlias,
  resolveCanonical,
  storeMessage,
} from '../src/whatsapp/store.js';
import { ReconnectSupervisor } from '../src/whatsapp/connection.js';
import type { ParsedMessage } from '../src/whatsapp/messageParser.js';

const log = pino({ level: 'silent' });
type TestDb = ReturnType<typeof openTestDb>['db'];

const baseKey = (id: string) => ({
  remoteJid: 'a@s.whatsapp.net',
  fromMe: false,
  id,
});

/** синтетический WAMessage поверх сырого message-объекта */
function waMsg(message: unknown, id = 'm1'): Parameters<typeof parseWAMessage>[0] {
  return { key: baseKey(id), message: message as never, messageTimestamp: 1000, pushName: 'Пациент' };
}

describe('шаг 4.1: обёртки Baileys разворачиваются до текста', () => {
  it('ephemeralMessage скрывает conversation', () => {
    const r = parseWAMessage(waMsg({ ephemeralMessage: { message: { conversation: 'секретный текст' } } }));
    assert.equal((r as ParsedMessage).text, 'секретный текст');
  });

  it('viewOnceMessageV2 скрывает extendedText', () => {
    const r = parseWAMessage(
      waMsg({ viewOnceMessageV2: { message: { extendedTextMessage: { text: 'глянь один раз' } } } }),
    );
    assert.equal((r as ParsedMessage).text, 'глянь один раз');
  });

  it('documentWithCaptionMessage отдаёт caption', () => {
    const r = parseWAMessage(
      waMsg({
        documentWithCaptionMessage: {
          message: { documentMessage: { caption: 'анализы за март', fileName: 'a.pdf' } },
        },
      }),
    );
    assert.equal((r as ParsedMessage).text, 'анализы за март');
  });

  it('голосовое: ptt → type voice + длительность', () => {
    const r = parseWAMessage(
      waMsg({ audioMessage: { ptt: true, seconds: 42 } }),
    ) as ParsedMessage;
    assert.equal(r.messageType, 'voice');
    assert.equal(r.durationSec, 42);
  });

  it('обычное аудио остаётся audio', () => {
    const r = parseWAMessage(waMsg({ audioMessage: { ptt: false, seconds: 180 } })) as ParsedMessage;
    assert.equal(r.messageType, 'audio');
    assert.equal(r.durationSec, 180);
  });
});

describe('шаг 4.2: правки и удаления', () => {
  it('protocolMessage edit в upsert → EditEvent с новым текстом', () => {
    const r = parseWAMessage(
      waMsg({
        protocolMessage: {
          type: 14, // MESSAGE_EDIT
          key: { remoteJid: 'a@s.whatsapp.net', fromMe: false, id: 'orig1' },
          editedMessage: { conversation: 'исправленный текст' },
        },
      }),
    ) as unknown as ProtocolEvent;
    assert.equal(r.kind, 'edit');
    assert.equal(r.targetId, 'orig1');
    assert.equal((r as { text: string }).text, 'исправленный текст');
  });

  it('protocolMessage revoke → RevokeEvent', () => {
    const r = parseWAMessage(
      waMsg({
        protocolMessage: { type: 0, key: { remoteJid: 'a@s.whatsapp.net', fromMe: false, id: 'orig2' } },
      }),
    ) as unknown as ProtocolEvent;
    assert.equal(r.kind, 'revoke');
    assert.equal(r.targetId, 'orig2');
  });

  it('applyEdit обновляет текст + edited_at и возвращает на переанализ', () => {
    const { db, close } = openTestDb();
    try {
      db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES ('a@s.whatsapp.net', 'А', 0, 1)`);
      db.run(sql`INSERT INTO messages (whatsapp_message_id, chat_jid, direction, message_type, text, timestamp, is_from_me, created_at, processed_at)
        VALUES ('orig1', 'a@s.whatsapp.net', 'incoming', 'text', 'старый', 1000, 0, 1000, 2000)`);
      const ok = applyEdit(db, log, { chatJid: 'a@s.whatsapp.net', targetId: 'orig1', text: 'новый', timestampMs: 3000 });
      assert.equal(ok, true);
      const row = db.get<{ text: string; edited_at: number; processed_at: number | null }>(
        sql`SELECT text, edited_at, processed_at FROM messages WHERE whatsapp_message_id = 'orig1'`,
      );
      assert.equal(row?.text, 'новый');
      assert.equal(row?.edited_at, 3000);
      assert.equal(row?.processed_at, null);
    } finally {
      close();
    }
  });

  it('applyRevoke ставит deleted_at, текст из AI-контекста исключается фильтром', () => {
    const { db, close } = openTestDb();
    try {
      db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES ('a@s.whatsapp.net', 'А', 0, 1)`);
      db.run(sql`INSERT INTO messages (whatsapp_message_id, chat_jid, direction, message_type, text, timestamp, is_from_me, created_at)
        VALUES ('orig2', 'a@s.whatsapp.net', 'incoming', 'text', 'удалённое', 1000, 0, 1000)`);
      assert.equal(applyRevoke(db, log, { chatJid: 'a@s.whatsapp.net', targetId: 'orig2', timestampMs: 4000 }), true);
      const n = db.get<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM messages WHERE chat_jid = 'a@s.whatsapp.net' AND deleted_at IS NULL`,
      );
      assert.equal(n?.n, 0);
      // правка/удаление несуществующего — пропуск без падения
      assert.equal(applyEdit(db, log, { chatJid: 'a@s.whatsapp.net', targetId: 'ghost', text: 'x', timestampMs: 1 }), false);
      assert.equal(applyRevoke(db, log, { chatJid: 'a@s.whatsapp.net', targetId: 'ghost', timestampMs: 1 }), false);
    } finally {
      close();
    }
  });
});

describe('шаг 4.3: LID ↔ номер (алиасы и слияние чатов)', () => {
  it('каноника: PN побеждает LID; recordAlias + resolveCanonical', () => {
    const { db, close } = openTestDb();
    try {
      assert.equal(resolveCanonical(db, '1@lid'), '1@lid'); // алиаса нет — сам себе каноника
      recordAlias(db, log, { aliasJid: '999@lid', canonicalJid: '7700@s.whatsapp.net' });
      assert.equal(resolveCanonical(db, '999@lid'), '7700@s.whatsapp.net');
      assert.equal(resolveCanonical(db, '7700@s.whatsapp.net'), '7700@s.whatsapp.net');
    } finally {
      close();
    }
  });

  it('поздний алиас сливает чаты: сообщения и задачи переезжают в транзакции', () => {
    const { db, close } = openTestDb();
    try {
      storeMessage(db, log, {
        whatsappMessageId: 'w1', chatJid: '999@lid', senderJid: '999@lid', senderName: 'П',
        direction: 'incoming', messageType: 'text', text: 'привет', timestampMs: 1000,
        isFromMe: false, pushName: 'П', durationSec: null,
      });
      const lidChat = db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = '999@lid'`)!.id;
      db.run(sql`INSERT INTO tasks (chat_id, chat_jid, title, status, created_at, updated_at)
        VALUES (${lidChat}, '999@lid', 'Позвонить', 'open', 1, 1)`);
      recordAlias(db, log, { aliasJid: '999@lid', canonicalJid: '7700@s.whatsapp.net' });
      const merged = mergeChats(db, log, { fromJid: '999@lid', intoJid: '7700@s.whatsapp.net' });
      assert.equal(merged.messagesMoved, 1);
      assert.equal(merged.tasksMoved, 1);
      assert.equal(db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM chats WHERE jid IN ('999@lid','7700@s.whatsapp.net')`)?.n, 1);
      assert.equal(db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM messages WHERE chat_jid = '7700@s.whatsapp.net'`)?.n, 1);
      assert.equal(db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tasks WHERE chat_jid = '7700@s.whatsapp.net'`)?.n, 1);
    } finally {
      close();
    }
  });
});

describe('шаг 4.5/4.6: голосовые в контексте и супервизор переподключений', () => {
  it('ReconnectSupervisor: двойной close → один connect; stop в backoff → ноль', async () => {
    let connects = 0;
    const Sleeps: Array<() => void> = [];
    const sup = new ReconnectSupervisor(async () => {
      connects += 1;
    }, (ms: number) => new Promise<void>((r) => Sleeps.push(r)));
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    sup.onClose();
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    sup.onClose();
    assert.equal(Sleeps.length, 1);
    Sleeps[0]!();
    await new Promise((r) => setImmediate(r));
    assert.equal(connects, 1);
    // stop во время backoff отменяет connect
    const sup2 = new ReconnectSupervisor(async () => {
      connects += 1;
    }, (ms: number) => new Promise<void>((r) => Sleeps.push(r)));
    const p = sup2.onClose();
    sup2.stop();
    Sleeps[Sleeps.length - 1]!();
    await p;
    assert.equal(connects, 1);
  });
});
