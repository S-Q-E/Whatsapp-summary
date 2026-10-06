import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../database/db.js';

export type RetentionOptions = {
  /** хранить тексты N дней; 0/отрицательное = выключено */
  days: number;
  now: number;
  /** обезличивать title/description закрытых задач старше N дней; 0/undefined = выключено */
  tasksDays?: number;
};

/**
 * Ретеншн текстов (шаг 9, расширен): сообщения старше срока теряют
 * text, transcript и sender_name (NULL). Удалённые (deleted_at) чистятся
 * сразу, без оглядки на возраст. Задачи и ссылки source/closed_by остаются.
 * Старые digests.content обнуляются по тому же сроку. Закрытые задачи
 * старше tasksDays обезличиваются (title/description -> NULL).
 * В конце — PRAGMA wal_checkpoint(TRUNCATE), чтобы WAL-файл не рос.
 * Идемпотентно. days<=0 = всё выключено.
 */
export function runRetention(db: Db, log: Logger, opts: RetentionOptions): number {
  if (!opts.days || opts.days <= 0) return 0;
  const cutoff = opts.now - opts.days * 86_400_000;
  let total = 0;
  const nulled = db.run(sql`
    UPDATE messages SET text = NULL, transcript = NULL, sender_name = NULL
    WHERE timestamp < ${cutoff} AND (text IS NOT NULL OR transcript IS NOT NULL OR sender_name IS NOT NULL)
  `);
  total += Number(nulled.changes ?? 0);
  const deleted = db.run(sql`
    UPDATE messages SET text = NULL, transcript = NULL, sender_name = NULL
    WHERE deleted_at IS NOT NULL AND (text IS NOT NULL OR transcript IS NOT NULL OR sender_name IS NOT NULL)
  `);
  total += Number(deleted.changes ?? 0);
  const oldDigests = db.run(sql`
    UPDATE digests SET content = '' WHERE created_at < ${cutoff} AND content != ''
  `);
  total += Number(oldDigests.changes ?? 0);
  if (opts.tasksDays && opts.tasksDays > 0) {
    const taskCutoff = opts.now - opts.tasksDays * 86_400_000;
    const anon = db.run(sql`
      UPDATE tasks SET title = '[удалено ретеншном]', description = NULL
      WHERE status IN ('done', 'cancelled') AND closed_at IS NOT NULL AND closed_at < ${taskCutoff}
        AND title != '[удалено ретеншном]'
    `);
    total += Number(anon.changes ?? 0);
  }
  try {
    db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
  } catch (err) {
    log.warn({ err }, 'retention: wal_checkpoint failed');
  }
  if (total > 0) log.info({ nulled: total, days: opts.days }, 'retention done');
  return total;
}
