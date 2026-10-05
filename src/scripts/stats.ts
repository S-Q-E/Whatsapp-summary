import { sql } from 'drizzle-orm';
import { logger } from '../config/logger.js';
import { closeDatabase, openDatabase } from '../database/db.js';

/** Quick check that ingestion works: counts + last messages (metadata only). */
async function main(): Promise<void> {
  const db = openDatabase(logger);

  const contacts = db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM contacts`);
  const total = db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM messages`);
  const incoming = db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM messages WHERE direction = 'incoming'`,
  );
  const outgoing = db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM messages WHERE direction = 'outgoing'`,
  );
  const byType = db.all<{ message_type: string; n: number }>(
    sql`SELECT message_type, COUNT(*) AS n FROM messages GROUP BY message_type ORDER BY n DESC`,
  );
  const last = db.all<{
    chat_jid: string;
    direction: string;
    message_type: string;
    timestamp: number;
    text_len: number;
  }>(
    sql`SELECT chat_jid, direction, message_type, timestamp, LENGTH(COALESCE(text,'')) AS text_len
        FROM messages ORDER BY timestamp DESC LIMIT 5`,
  );

  console.log('contacts:', contacts?.n ?? 0);
  console.log('messages total:', total?.n ?? 0);
  console.log('incoming:', incoming?.n ?? 0, '| outgoing:', outgoing?.n ?? 0);
  console.log('by type:', byType);
  console.log('last 5 (metadata only):', last);

  closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
