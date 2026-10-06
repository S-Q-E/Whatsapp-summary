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
  enabled: boolean;
};

export type VoiceResult = 'transcribed' | 'skipped' | 'failed';

function isChatIgnored(db: Db, chatJid: string): boolean {
  try {
    const row = db.get<{ ignored: number }>(sql`
      SELECT s.ignored FROM chat_settings s
      JOIN chats c ON c.id = s.chat_id
      WHERE c.jid = ${chatJid}
    `);
    return (row?.ignored ?? 0) === 1;
  } catch {
    return false;
  }
}

/**
 * Транскрибация одного голосового (шаг 10): только realtime audio/voice
 * из разрешённых чатов. Аудио никуда не пишется — транскриберу уходит
 * Buffer из памяти. В БД остаётся только текст; заодно сбрасываем
 * processed_at, чтобы сообщение с новым транскриптом попало в анализ.
 * Ошибки наружу не пробрасываются — только warn с id.
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
  try {
    const audio = await deps.downloadAudio(waMsg);
    const text = await deps.transcriber.transcribe(audio, 'audio/ogg');
    db.run(sql`
      UPDATE messages SET transcript = ${text}, processed_at = NULL
      WHERE chat_jid = ${parsed.chatJid} AND whatsapp_message_id = ${parsed.whatsappMessageId}
    `);
    log.info(
      { chat: parsed.chatJid, msgId: parsed.whatsappMessageId, chars: text.length },
      'voice transcribed',
    );
    return 'transcribed';
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), chat: parsed.chatJid, msgId: parsed.whatsappMessageId },
      'voice transcription failed',
    );
    return 'failed';
  }
}
