import { getContentType, type WAMessage } from '@whiskeysockets/baileys';
import { normalizeJid } from '../utils/jid.js';

export type ParsedMessage = {
  whatsappMessageId: string;
  chatJid: string;
  senderJid: string;
  senderName: string | null;
  direction: 'incoming' | 'outgoing';
  messageType: string;
  text: string | null;
  timestampMs: number;
  isFromMe: boolean;
  pushName: string | null;
};

/**
 * Extract a storable shape from a raw Baileys WAMessage.
 * READ-ONLY: never downloads media, never decrypts beyond what Baileys gives us.
 * Non-text payloads keep metadata only (message_type + optional caption).
 */
export function parseWAMessage(msg: WAMessage): ParsedMessage | null {
  const key = msg.key;
  const remoteJidRaw = key.remoteJid;
  const messageId = key.id;
  if (!remoteJidRaw || !messageId) return null;

  const chatJid = normalizeJid(remoteJidRaw);
  // In groups the author is key.participant; in DMs it is remoteJid (or us when fromMe).
  const senderJid = normalizeJid(key.participant ?? remoteJidRaw);
  const isFromMe = key.fromMe === true;
  const direction = isFromMe ? 'outgoing' : 'incoming';
  const pushName = msg.pushName ?? null;

  let messageType = 'unknown';
  try {
    messageType = getContentType(msg.message ?? undefined) ?? 'unknown';
  } catch {
    messageType = 'unknown';
  }

  const text = extractText(msg, messageType);
  const timestampMs = toMs(msg.messageTimestamp);

  return {
    whatsappMessageId: messageId,
    chatJid,
    senderJid,
    senderName: pushName,
    direction,
    messageType: normalizeMessageType(messageType),
    text,
    timestampMs,
    isFromMe,
    pushName,
  };
}

function toMs(ts: unknown): number {
  if (typeof ts === 'number') return Math.floor(ts * 1000);
  if (typeof ts === 'bigint') return Number(ts) * 1000;
  if (ts !== null && typeof ts === 'object') {
    const o = ts as { low?: number; high?: number };
    if (typeof o.low === 'number') {
      // protobuf Long {low, high}
      const high = typeof o.high === 'number' ? o.high : 0;
      return (high * 0x1_0000_0000 + (o.low >>> 0)) * 1000;
    }
  }
  return Date.now();
}

/** Map Baileys content types to the small set we store. */
function normalizeMessageType(raw: string | undefined | null): string {
  switch (raw) {
    case 'conversation':
    case 'extendedTextMessage':
      return 'text';
    case 'imageMessage':
      return 'image';
    case 'videoMessage':
      return 'video';
    case 'audioMessage':
      return 'audio';
    case 'documentMessage':
      return 'document';
    case 'stickerMessage':
      return 'sticker';
    case 'locationMessage':
    case 'liveLocationMessage':
      return 'location';
    case 'contactMessage':
    case 'contactsArrayMessage':
      return 'contact';
    case 'pollCreationMessage':
    case 'pollUpdateMessage':
      return 'poll';
    case 'reactionMessage':
      return 'reaction';
    case 'protocolMessage':
      return 'protocol';
    case undefined:
    case null:
      return 'unknown';
    default:
      return raw.replace(/Message$/, '').toLowerCase() || 'unknown';
  }
}

/** Plain text or caption; null for media without caption and for non-text types. */
function extractText(msg: WAMessage, contentType: string | undefined | null): string | null {
  const m = msg.message;
  if (!m) return null;
  if (typeof m.conversation === 'string' && m.conversation.length > 0) return m.conversation;
  const ext = m.extendedTextMessage?.text;
  if (typeof ext === 'string' && ext.length > 0) return ext;
  // captions for media — metadata only, no media download
  const caption =
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    undefined;
  if (typeof caption === 'string' && caption.length > 0) return caption;
  // document file name is useful metadata when there is no caption
  const fileName = m.documentMessage?.fileName;
  if (contentType === 'documentMessage' && typeof fileName === 'string' && fileName.length > 0) {
    return `[document: ${fileName}]`;
  }
  return null;
}
