import { jidNormalizedUser } from '@whiskeysockets/baileys';

/** Normalize any JID (strip device suffix :NN, lowercase). Never split on '@' manually. */
export function normalizeJid(jid: string | null | undefined): string {
  if (!jid) return '';
  try {
    return jidNormalizedUser(jid);
  } catch {
    return jid.toLowerCase();
  }
}

/** Extract E.164 digits from a phone-number JID (xxx@s.whatsapp.net). Returns null for groups/LIDs. */
export function phoneFromJid(normalizedJid: string): string | null {
  const m = /^(\d+)@s\.whatsapp\.net$/.exec(normalizedJid);
  return m ? m[1]! : null;
}

export function isGroupJid(normalizedJid: string): boolean {
  return normalizedJid.endsWith('@g.us');
}
