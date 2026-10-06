import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { Db } from '../database/db.js';
import type { Transcriber } from '../ai/transcriber.js';

export type VoiceDeps = {
  db: Db;
  log: Logger;
  transcriber: Transcriber;
  /** скачивание аудио из WhatsApp (в проде — Baileys downloadMediaMessage) */
  downloadAudio: (waMsg: WAMessage) => Promise<Buffer>;
  tmpDir: string;
  enabled: boolean;
};

export type VoiceResult = 'transcribed' | 'skipped' | 'failed';

function isChatIgnored(db: Db, chatJid: string): boolean {
  try {
    const row = db.get<{ ignored: number }>(
      sql`SELECT ignored FROM chat_settings WHERE chat_jid = ${chatJid}`,
    );
    return (row?.ignored ?? 0) === 1;
  } catch {
    return false;
  }
}

/**
 * Транскрибация одного голосового (шаг 10): только realtime audio/voice
 * из разрешённых чатов. Аудиофайл пишется во временную папку и удаляется
 * сразу после распознавания (успех и ошибка — в finally). В БД остаётся
 * только текст. Ошибки наружу не пробрасываются — только warn с id.
 */
export async function processVoiceMessage(
  deps: VoiceDeps,
  waMsg: WAMessage,
  parsed: { chatJid: string; whatsappMessageId: string; messageType: string },
): Promise<VoiceResult> {
  const { db, log } = deps;
  if (!deps.enabled) return 'skipped';
  if (parsed.messageType !== 'voice' && parsed.messageType !== 'audio') return 'skipped';
  if (isChatIgnored(db, parsed.chatJid)) {
    log.info({ chat: parsed.chatJid }, 'voice in ignored chat, transcription skipped');
    return 'skipped';
  }
  let tmpFile: string | null = null;
  try {
    const audio = await deps.downloadAudio(waMsg);
    fs.mkdirSync(deps.tmpDir, { recursive: true });
    tmpFile = path.join(deps.tmpDir, `${randomUUID()}.ogg`);
    fs.writeFileSync(tmpFile, audio);
    const text = await deps.transcriber.transcribe(audio, 'audio/ogg');
    db.run(sql`
      UPDATE messages SET transcript = ${text}
      WHERE chat_jid = ${parsed.chatJid} AND whatsapp_message_id = ${parsed.whatsappMessageId}
    `);
    log.info(
      { chat: parsed.chatJid, msgId: parsed.whatsappMessageId, chars: text.length },
      'voice transcribed (audio file removed)',
    );
    return 'transcribed';
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), chat: parsed.chatJid, msgId: parsed.whatsappMessageId },
      'voice transcription failed',
    );
    return 'failed';
  } finally {
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
