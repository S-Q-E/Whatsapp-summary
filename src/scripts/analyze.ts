import { logger } from '../config/logger.js';
import { closeDatabase, openDatabase } from '../database/db.js';
import { analyzeChat, loadPendingBundles } from '../ai/taskService.js';
import { createProvider } from '../ai/providerFactory.js';
import { parseDayArg } from '../digest/date.js';

/**
 * npm run analyze [--provider=auto|openrouter|ollama|heuristic|mock] [--date=YYYY-MM-DD] [--chat=<подстрока-jid>]
 *
 * Инкрементально (шаг 3): разбираются только чаты с сообщениями
 * processed_at IS NULL. Без --date — все необработанные; с --date —
 * только этот день. После УСПЕШНОГО анализа сообщения помечаются
 * processed_at; при ошибке провайдера остаются и попадут в следующий прогон.
 * Повторный прогон дублей не создаёт (UNIQUE по источнику).
 *
 * READ-ONLY относительно WhatsApp: сокет здесь вообще не открывается,
 * работа идёт только с локальным SQLite. Ничего никому не отправляется.
 */
async function main(): Promise<void> {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = /^--([^=]+)=(.*)$/.exec(a);
      return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
    }),
  );

  let day: Date | undefined;
  const dateStr = args['date'] as string | undefined;
  if (dateStr !== undefined) {
    try {
      day = parseDayArg(dateStr);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  }

  const provider = createProvider(args['provider'] as string | undefined);
  const chatFilter = args['chat'] as string | undefined;
  logger.info(
    { provider: provider.name, model: provider.model, promptVersion: provider.promptVersion, date: dateStr ?? 'pending' },
    'starting analysis',
  );

  const db = openDatabase(logger);
  const analyzedAt = Date.now();
  try {
    const bundles = loadPendingBundles(db, { day, chatFilter });
    if (bundles.length === 0) {
      console.log('No unprocessed chats. Nothing to analyze.');
      console.log('Tip: run `npm run seed:demo` to load synthetic demo conversations, then re-run.');
      return;
    }

    let totalCreated = 0;
    let totalUpdated = 0;
    for (const b of bundles) {
      let result;
      try {
        result = await analyzeChat(db, logger, provider, b, analyzedAt);
      } catch (err) {
        logger.error({ err, chat: b.chatJid }, 'analysis failed for chat, skipping');
        continue;
      }
      totalCreated += result.created.length;
      totalUpdated += result.updated.length;

      const who = b.contactName ?? b.chatJid;
      console.log(`\n=== ${who} [${b.chatJid}] — в контексте: ${b.messages.length}, новых: ${b.newMessageIds.length} ===`);
      if (result.created.length === 0 && result.updated.length === 0) {
        console.log(`  (новых задач нет${result.skipped > 0 ? `, пропущено ссылок: ${result.skipped}` : ' — благодарности/вопросы задачами не считаются'})`);
      }
      for (const t of [...result.created, ...result.updated]) {
        const isNew = result.created.includes(t);
        console.log(
          `  ${isNew ? '[NEW]' : '[UPD]'} #${t.id} ${t.title} | status=${t.status} ` +
            `| conf=${t.confidence} | deadline=${t.dueText ?? (t.dueAt ? new Date(t.dueAt).toISOString() : '—')} ` +
            `| model=${t.model} | prompt=${t.promptVersion}`,
        );
        if (t.description) console.log(`        ${t.description}`);
      }
    }
    console.log(`\nDone: chats=${bundles.length}, created=${totalCreated}, updated=${totalUpdated}`);
  } finally {
    closeDatabase();
  }
}

main().catch((err) => {
  logger.error({ err }, 'analyze failed');
  process.exit(1);
});
