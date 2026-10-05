import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.logLevel,
  transport: env.logPretty
    ? {
        target: 'pino-pretty',
        options: { colorize: true, singleLine: false },
      }
    : undefined,
});

export const baileysLogger = logger.child({ module: 'baileys' });

/**
 * Log message metadata WITHOUT full body by default.
 * Full text is never logged at info level. A short preview
 * (<=120 chars) is only logged at debug level when
 * LOG_MESSAGE_CONTENT=true.
 */
export function logStoredMessage(
  log: pino.Logger,
  info: {
    chatJid: string;
    senderJid: string;
    direction: string;
    messageType: string;
    whatsappMessageId: string;
    isNew: boolean;
    textLength: number;
    textPreview?: string | null;
  },
): void {
  const base = {
    chat: info.chatJid,
    sender: info.senderJid,
    direction: info.direction,
    type: info.messageType,
    msgId: info.whatsappMessageId,
    isNew: info.isNew,
    textLen: info.textLength,
  };
  if (env.logMessageContent && info.textPreview) {
    log.debug({ ...base, preview: info.textPreview.slice(0, 120) }, 'message stored');
  } else {
    log.info(base, 'message stored');
  }
}
