import { normalizeJid } from '../utils/jid.js';

export class NotOwnerError extends Error {
  constructor(toJid: string) {
    super(`отправка запрещена: разрешён только OWNER_JID, запрошен ${toJid}`);
    this.name = 'NotOwnerError';
  }
}

export class NoOwnerError extends Error {
  constructor() {
    super('OWNER_JID не задан — отправка невозможна');
    this.name = 'NoOwnerError';
  }
}

/**
 * OWNER_JID из конфига к каноническому JID: голые цифры (возможно,
 * с +, пробелами, дефисами) превращаются в <digits>@s.whatsapp.net.
 */
export function resolveOwnerJid(raw: string): string {
  const t = raw.trim();
  if (t === '') throw new NoOwnerError();
  if (t.includes('@')) return normalizeJid(t);
  const digits = t.replace(/\D/g, '');
  if (!digits) throw new NoOwnerError();
  return `${digits}@s.whatsapp.net`;
}

/**
 * Единственная точка проверки исходящих (шаг 7, жёсткое правило AGENTS.md).
 * Бросает NotOwnerError на любую цель кроме OWNER_JID.
 * Сравнение — по нормализованным JID (без device-суффиксов).
 */
export function assertDigestRecipient(ownerJid: string, toJid: string): void {
  const owner = resolveOwnerJid(ownerJid);
  if (normalizeJid(toJid) !== owner) {
    throw new NotOwnerError(toJid);
  }
}

type SendableSocket = {
  sendMessage: (jid: string, content: { text: string }) => Promise<{ key?: { id?: string } } | unknown>;
};

/**
 * Единственный путь отправки текста в WhatsApp: только владельцу.
 * Возвращает id отправленного сообщения (для логов, не для БД).
 */
export async function sendDigest(
  sock: SendableSocket,
  ownerJid: string,
  toJid: string,
  text: string,
): Promise<string | null> {
  const owner = resolveOwnerJid(ownerJid);
  assertDigestRecipient(owner, toJid);
  const sent = (await sock.sendMessage(owner, { text })) as { key?: { id?: string } };
  return sent?.key?.id ?? null;
}
