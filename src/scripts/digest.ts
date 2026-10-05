import { logger } from '../config/logger.js';
import { closeDatabase, openDatabase } from '../database/db.js';
import { buildDigest } from '../digest/builder.js';
import { parseDayArg } from '../digest/date.js';
import { PlainTextDigestRenderer } from '../digest/renderer.js';

/**
 * npm run digest [--date=YYYY-MM-DD]
 *
 * Дневной отчёт: задачи + статистика за день. Только чтение локального
 * SQLite, только метаданные задач — текст переписок в отчёт не попадает.
 * Ничего никуда не отправляет: вывод — в терминал через
 * PlainTextDigestRenderer (тот же render() позже используют Telegram/WhatsApp).
 */
async function main(): Promise<void> {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = /^--([^=]+)=(.*)$/.exec(a);
      return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
    }),
  );

  let day: Date;
  try {
    day = parseDayArg(args['date'] as string | undefined);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const db = openDatabase(logger);
  try {
    const digest = buildDigest(db, day);
    console.log(new PlainTextDigestRenderer().render(digest));
  } finally {
    closeDatabase();
  }
}

main().catch((err) => {
  logger.error({ err }, 'digest failed');
  process.exit(1);
});
