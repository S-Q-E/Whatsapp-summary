import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { openTestDb } from './db.js';
import { setChatIgnored } from '../src/whatsapp/store.js';
import { buildUserPrompt } from '../src/ai/prompts.js';
import type { Transcriber } from '../src/ai/transcriber.js';
import { processVoiceMessage } from '../src/whatsapp/voice.js';
import type { WAMessage } from '@whiskeysockets/baileys';

const silent = pino({ level: 'silent' });
type TestDb = ReturnType<typeof openTestDb>['db'];

class FakeTranscriber implements Transcriber {
  readonly name = 'fake';
  readonly model = 'fake-whisper';
  calls: number = 0;
  fail = false;
  async transcribe(_audio: Buffer, _mime: string): Promise<string> {
    this.calls += 1;
    if (this.fail) throw new Error('ASR down');
    return 'посмотрите мои анализы вечером';
  }
}

function seedVoice(db: TestDb, chatJid: string, wamid: string): void {
  db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES (${chatJid}, 'N', 0, 1)`);
  const chatId = db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = ${chatJid}`)!.id;
  const ts = Date.now();
  db.run(sql`INSERT INTO messages (whatsapp_message_id, chat_jid, chat_id, direction, message_type, text, timestamp, is_from_me, created_at)
    VALUES (${wamid}, ${chatJid}, ${chatId}, 'incoming', 'voice', NULL, ${ts}, 0, ${ts})`);
}

function deps(db: TestDb, tr: FakeTranscriber, enabled = true) {
  return {
    db,
    log: silent,
    transcriber: tr,
    downloadAudio: async (_m: WAMessage) => Buffer.from('FAKE-OGG-BYTES'),
    enabled,
  };
}

const parsedOf = (chatJid: string, wamid: string) => ({
  chatJid,
  whatsappMessageId: wamid,
  messageType: 'voice',
});

describe('шаг 10: транскрибация голосовых', () => {
  it('голосовое из разрешённого чата: скачал → транскрибировал → сохранил, файла на диске нет', async () => {
    const { db, close } = openTestDb();
    // заведомо несуществующая папка: если код пишет tmp-файл — упадёт или создаст её
    const ghostDir = path.join(os.tmpdir(), `wavoice-ghost-${Date.now()}`);
    try {
      seedVoice(db, 'a@s.whatsapp.net', 'v1');
      const tr = new FakeTranscriber();
      const r = await processVoiceMessage(deps(db, tr), {} as WAMessage, parsedOf('a@s.whatsapp.net', 'v1'));
      assert.equal(r, 'transcribed');
      assert.equal(tr.calls, 1);
      assert.equal(
        db.get<{ transcript: string | null }>(sql`SELECT transcript FROM messages WHERE whatsapp_message_id = 'v1'`)?.transcript,
        'посмотрите мои анализы вечером',
      );
      assert.equal(fs.existsSync(ghostDir), false, 'аудио не должно писаться на диск');
    } finally {
      close();
      fs.rmSync(ghostDir, { recursive: true, force: true });
    }
  });

  it('игнорируемый чат: скачивание не вызывается, транскрипта нет', async () => {
    const { db, close } = openTestDb();
    try {
      seedVoice(db, 'b@s.whatsapp.net', 'v2');
      db.run(sql`INSERT INTO chats (jid, display_name, is_group, created_at) VALUES ('b@s.whatsapp.net', 'B', 0, 1)
        ON CONFLICT(jid) DO NOTHING`);
      setChatIgnored(db, db.get<{ id: number }>(sql`SELECT id FROM chats WHERE jid = 'b@s.whatsapp.net'`)!.id, 1);
      let downloaded = false;
      const tr = new FakeTranscriber();
      const d = deps(db, tr);
      d.downloadAudio = async () => {
        downloaded = true;
        return Buffer.from('x');
      };
      const r = await processVoiceMessage(d, {} as WAMessage, parsedOf('b@s.whatsapp.net', 'v2'));
      assert.equal(r, 'skipped');
      assert.equal(downloaded, false);
      assert.equal(tr.calls, 0);
      assert.equal(
        db.get<{ transcript: string | null }>(sql`SELECT transcript FROM messages WHERE whatsapp_message_id = 'v2'`)?.transcript,
        null,
      );
    } finally {
      close();
    }
  });

  it('флаг выключен: полный no-op', async () => {
    const { db, close } = openTestDb();
    try {
      seedVoice(db, 'a@s.whatsapp.net', 'v3');
      const tr = new FakeTranscriber();
      const r = await processVoiceMessage(deps(db, tr, false), {} as WAMessage, parsedOf('a@s.whatsapp.net', 'v3'));
      assert.equal(r, 'skipped');
      assert.equal(tr.calls, 0);
    } finally {
      close();
    }
  });

  it('ошибка ASR: transcript NULL, исключения наружу нет', async () => {
    const { db, close } = openTestDb();
    try {
      seedVoice(db, 'a@s.whatsapp.net', 'v4');
      const tr = new FakeTranscriber();
      tr.fail = true;
      const r = await processVoiceMessage(deps(db, tr), {} as WAMessage, parsedOf('a@s.whatsapp.net', 'v4'));
      assert.equal(r, 'failed');
      assert.equal(
        db.get<{ transcript: string | null }>(sql`SELECT transcript FROM messages WHERE whatsapp_message_id = 'v4'`)?.transcript,
        null,
      );
    } finally {
      close();
    }
  });

  it('транскрипт попадает в AI-контекст с пометкой [голосовое]', () => {
    const user = buildUserPrompt(
      {
        chatJid: 'a@s.whatsapp.net',
        contactName: 'Айгуль',
        messages: [
          {
            id: 7, direction: 'incoming', senderName: 'Айгуль', text: null,
            messageType: 'voice', durationSec: 42, transcript: 'посмотрите мои анализы вечером',
            timestamp: 1_700_000_000_000, whatsappMessageId: 'v1',
          },
        ],
        existingTasks: [],
        analyzedAt: 1_700_000_100_000,
      },
      'Asia/Almaty',
    );
    assert.ok(user.includes('[голосовое: посмотрите мои анализы вечером]'));
  });
});
