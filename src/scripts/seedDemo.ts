import { logger } from '../config/logger.js';
import { closeDatabase, openDatabase } from '../database/db.js';
import { FIXTURES } from '../ai/fixtures.js';
import { env } from '../config/env.js';
import { startOfDay } from '../utils/time.js';
import { storeMessage, upsertContact } from '../whatsapp/store.js';
import type { ParsedMessage } from '../whatsapp/messageParser.js';

/**
 * npm run seed:demo — кладёт синтетические переписки (без ПДн, см. fixtures.ts)
 * в локальную БД сегодняшним днём, чтобы `npm run analyze` можно было
 * прогнать без реальных данных. Повторный запуск безопасен (дедуплика
 * по whatsapp_message_id + chat_jid).
 */
async function main(): Promise<void> {
  const db = openDatabase(logger);
  try {
    const dayStart = startOfDay(new Date(), env.timezone);
    let n = 0;
    for (const f of FIXTURES) {
      upsertContact(db, logger, { jid: f.chatJid, pushName: f.contactPushName });
      f.messages.forEach((m, i) => {
        const p: ParsedMessage = {
          whatsappMessageId: `demo-${f.id}-${i}`,
          chatJid: f.chatJid,
          senderJid: m.direction === 'outgoing' ? 'me-demo@s.whatsapp.net' : f.chatJid,
          senderName: m.direction === 'outgoing' ? null : m.senderName,
          direction: m.direction,
          messageType: m.messageType === 'text' ? 'text' : m.messageType,
          durationSec: null,
          text: m.text,
          timestampMs: dayStart + m.minuteOffset * 60_000,
          isFromMe: m.direction === 'outgoing',
          pushName: m.direction === 'outgoing' ? null : m.senderName,
        };
        const r = storeMessage(db, logger, p);
        if (r.isNew) n += 1;
      });
      console.log(`seeded ${f.id}: ${f.messages.length} messages`);
    }
    console.log(`Done: ${n} new demo messages. Run: npm run analyze`);
  } finally {
    closeDatabase();
  }
}

main().catch((err) => {
  logger.error({ err }, 'seed failed');
  process.exit(1);
});
