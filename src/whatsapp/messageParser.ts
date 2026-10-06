import {
  getContentType,
  normalizeMessageContent,
  proto,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { normalizeJid } from '../utils/jid.js';

export type ParsedMessage = {
  whatsappMessageId: string;
  chatJid: string;
  senderJid: string;
  senderName: string | null;
  direction: 'incoming' | 'outgoing';
  messageType: string;
  text: string | null;
  /** длительность медиа в секундах (voice/audio/video), иначе null */
  durationSec: number | null;
  timestampMs: number;
  isFromMe: boolean;
  pushName: string | null;
};

/**
 * События правок/удалений (шаг 4.2). Baileys присылает их и в messages.upsert
 * (protocolMessage), и нормализованно в messages.update — оба пути
 * идемпотентны (applyEdit/applyRevoke по chat+targetId).
 */
export type ProtocolEvent =
  | { kind: 'edit'; chatJid: string; targetId: string; text: string | null; timestampMs: number }
  | { kind: 'revoke'; chatJid: string; targetId: string; timestampMs: number };

type MessageContent = NonNullable<ReturnType<typeof normalizeMessageContent>>;

/**
 * Extract a storable shape from a raw Baileys WAMessage.
 * READ-ONLY: never downloads media, never decrypts beyond what Baileys gives us.
 * Non-text payloads keep metadata only (message_type + optional caption).
 *
 * Контент сначала прогоняется через normalizeMessageContent: ephemeral,
 * viewOnce (+V2), documentWithCaption разворачиваются до внутреннего
 * сообщения, иначе их текст теряется (шаг 4.1).
 */
export function parseWAMessage(msg: WAMessage): ParsedMessage | ProtocolEvent | null {
  const key = msg.key;
  const remoteJidRaw = key.remoteJid;
  const messageId = key.id;
  if (!remoteJidRaw || !messageId) return null;

  const chatJid = normalizeJid(remoteJidRaw);
  const timestampMs = toMs(msg.messageTimestamp);

  // protocol-обёртки — до normalize (иначе стирается тип события)
  const protoMsg = msg.message?.protocolMessage;
  if (protoMsg) {
    const event = parseProtocolMessage(protoMsg, chatJid, timestampMs);
    if (event) return event;
    // прочие protocolMessage (настройки ephemeral и т.п.) — храним как system
  }

  const senderJid = normalizeJid(key.participant ?? remoteJidRaw);
  const isFromMe = key.fromMe === true;
  const direction = isFromMe ? 'outgoing' : 'incoming';
  const pushName = msg.pushName ?? null;

  const normalized = normalizeMessageContent(msg.message ?? undefined);
  let rawType: string | undefined;
  try {
    rawType = getContentType(normalized) ?? undefined;
  } catch {
    rawType = undefined;
  }

  const isVoice = rawType === 'audioMessage' && normalized?.audioMessage?.ptt === true;
  const text = extractText(normalized, rawType);

  return {
    whatsappMessageId: messageId,
    chatJid,
    senderJid,
    senderName: pushName,
    direction,
    messageType: isVoice ? 'voice' : normalizeMessageType(rawType),
    text,
    durationSec: extractDurationSec(normalized, rawType),
    timestampMs,
    isFromMe,
    pushName,
  };
}

function parseProtocolMessage(
  protoMsg: NonNullable<NonNullable<WAMessage['message']>['protocolMessage']>,
  chatJid: string,
  timestampMs: number,
): ProtocolEvent | null {
  const Edit = proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;
  const Revoke = proto.Message.ProtocolMessage.Type.REVOKE;
  if (protoMsg.type === Revoke) {
    const targetId = protoMsg.key?.id;
    if (!targetId) return null;
    return { kind: 'revoke', chatJid, targetId, timestampMs };
  }
  if (protoMsg.type === Edit) {
    const targetId = protoMsg.key?.id;
    if (!targetId) return null;
    const edited = normalizeMessageContent(protoMsg.editedMessage ?? undefined);
    let rawType: string | undefined;
    try {
      rawType = getContentType(edited) ?? undefined;
    } catch {
      rawType = undefined;
    }
    return { kind: 'edit', chatJid, targetId, text: extractText(edited, rawType), timestampMs };
  }
  return null;
}

/** Разбирает update.message.editedMessage из messages.update → текст правки. */
export function extractEditText(edited: unknown): string | null {
  const normalized = normalizeMessageContent(
    edited as Parameters<typeof normalizeMessageContent>[0],
  );
  let rawType: string | undefined;
  try {
    rawType = getContentType(normalized) ?? undefined;
  } catch {
    rawType = undefined;
  }
  return extractText(normalized, rawType);
}

export function toMs(ts: unknown): number {
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

function toSeconds(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === 'bigint') return Number(v);
  if (v !== null && typeof v === 'object') {
    const o = v as { low?: number };
    if (typeof o.low === 'number') return o.low >>> 0;
  }
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Math.floor(Number(v));
  return null;
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
function extractText(
  m: MessageContent | null | undefined,
  contentType: string | undefined | null,
): string | null {
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

/** Длительность для audio/voice/video из поля seconds (Long-safe). */
function extractDurationSec(
  m: MessageContent | null | undefined,
  contentType: string | undefined | null,
): number | null {
  if (!m) return null;
  if (contentType === 'audioMessage') return toSeconds(m.audioMessage?.seconds);
  if (contentType === 'videoMessage') return toSeconds(m.videoMessage?.seconds);
  return null;
}
