import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../database/db.js';

export type RetentionOptions = {
  /** хранить тексты N дней; 0/отрицательное = выключено */
  days: number;
  now: number;
};

/**
 * Ретеншн текстов (шаг 9): сообщения старше срока теряют text (NULL),
 * всё остальное — метаданные, задачи, ссылки source/closed_by — остаётся.
 * Идемпотентно: повтор ничего не меняет. days<=0 = выключено.
 */
export function runRetention(db: Db, log: Logger, opts: RetentionOptions): number {
  if (!opts.days || opts.days <= 0) return 0;
  const cutoff = opts.now - opts.days * 86_400_000;
  const res = db.run(sql`
    UPDATE messages SET text = NULL
    WHERE timestamp < ${cutoff} AND text IS NOT NULL
  `);
  const n = Number(res.changes ?? 0);
  if (n > 0) log.info({ nulled: n, days: opts.days }, 'retention: old message texts nulled');
  return n;
}
