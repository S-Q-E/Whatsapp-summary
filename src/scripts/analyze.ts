import { logger } from '../config/logger.js';
import { closeDatabase, openDatabase } from '../database/db.js';
import { analyzeChat, loadDayBundles } from '../ai/taskService.js';
import { createProvider } from '../ai/providerFactory.js';

/**
 * npm run analyze [--provider=auto|openrouter|ollama|heuristic|mock] [--date=YYYY-MM-DD] [--chat=<подстрока-jid>]
 *
 * 1. берёт сообщения за день (по умолчанию сегодня, локальный день);
 * 2. группирует по chat_jid;
 * 3. каждый чат отдаёт AI целиком как контекст;
 * 4. создаёт/обновляет tasks (идемпотентно);
 * 5. печатает найденное в терминал.
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

  const dateStr = (args['date'] as string | undefined) ?? 'today';
  const day = dateStr === 'today' ? new Date() : new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(day.getTime())) {
    console.error('Bad --date, expected YYYY-MM-DD or "today"');
    process.exit(1);
  }

  const provider = createProvider(args['provider'] as string | undefined);
  const chatFilter = args['chat'] as string | undefined;
  logger.info(
    { provider: provider.name, model: provider.model, promptVersion: provider.promptVersion, date: dateStr },
    'starting analysis',
  );

  const db = openDatabase(logger);
  const analyzedAt = Date.now();
  try {
    const all = loadDayBundles(db, day);
    const bundles = chatFilter ? all.filter((b) => b.chatJid.includes(chatFilter)) : all;
    if (bundles.length === 0) {
      console.log('No chats with text messages for this day. Nothing to analyze.');
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
      console.log(`\n=== ${who} [${b.chatJid}] — сообщений: ${b.messages.length} ===`);
      if (result.created.length === 0 && result.updated.length === 0) {
        console.log('  (задач не найдено — благодарности/вопросы задачами не считаются)');
      }
      for (const t of [...result.created, ...result.updated]) {
        const isNew = result.created.includes(t);
        console.log(
          `  ${isNew ? '[NEW]' : '[UPD]'} #${t.id} ${t.title} | status=${t.status} ` +
            `| conf=${t.confidence} | deadline=${t.deadlineText ?? (t.deadline ? new Date(t.deadline).toISOString() : '—')} ` +
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
