import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Logger } from 'pino';
import { env } from '../config/env.js';

export type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * Папка версионированных миграций (drizzle-kit generate).
 * Путь от import.meta — работает и из src (tsx), и из dist (node).
 */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

type Journal = { entries: Array<{ when: number; tag: string }> };

function readJournal(migrationsFolder: string): Journal {
  const raw = fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf-8');
  return JSON.parse(raw) as Journal;
}

function readMigrationStatements(migrationsFolder: string, tag: string): string[] {
  const sql = fs.readFileSync(path.join(migrationsFolder, `${tag}.sql`), 'utf-8');
  return sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
}

function maxWhen(journal: Journal): number {
  return Math.max(...journal.entries.map((e) => e.when));
}

function tableExists(sqlite: Database.Database, name: string): boolean {
  const row = sqlite
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { ok: number } | undefined;
  return row !== undefined;
}

function appliedCount(sqlite: Database.Database): number {
  if (!tableExists(sqlite, '__drizzle_migrations')) return 0;
  const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM __drizzle_migrations`).get() as { n: number };
  return row.n;
}

/** Ошибка «объект уже есть» — единственный терпимый исход replay. */
function isAlreadyExists(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already exists|duplicate column name/i.test(msg);
}

/**
 * Baseline-стратегия для БД, созданных старым BOOTSTRAP_SQL:
 * таблицы частично есть, журнала миграций нет.
 * Проигрываем весь журнал толерантно: существующие объекты пропускаем
 * (already exists), недостающие строим, данные мигрируют штатным путём
 * (включая INSERT..SELECT и маппинг статусов). Затем помечаем журнал
 * применённым. Любая другая ошибка — громко наружу.
 * Свежие БД идут обычным путём через migrate().
 */
function baselineLegacyDb(sqlite: Database.Database, migrationsFolder: string, log?: Logger): void {
  if (!tableExists(sqlite, 'contacts')) return; // свежая БД — нечего бейзлайнить
  if (appliedCount(sqlite) > 0) return; // уже под миграциями
  const journal = readJournal(migrationsFolder);
  if (journal.entries.length === 0) throw new Error('пустой журнал миграций');
  let replayed = 0;
  sqlite.exec('BEGIN');
  try {
    for (const entry of journal.entries) {
      for (const stmt of readMigrationStatements(migrationsFolder, entry.tag)) {
        try {
          sqlite.exec(stmt);
          replayed += 1;
        } catch (err) {
          if (isAlreadyExists(err)) continue;
          throw err;
        }
      }
    }
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL,
        created_at NUMERIC
      );
    `);
    sqlite
      .prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`)
      .run('baseline-legacy-bootstrap', maxWhen(journal));
    sqlite.exec('COMMIT');
  } catch (err) {
    try {
      sqlite.exec('ROLLBACK');
    } catch {
      // ignore rollback errors, исходная ошибка важнее
    }
    throw err;
  }
  log?.info({ replayed }, 'legacy DB detected: journal replayed tolerantly, data kept');
}

/**
 * Применяет версионированные миграции. Идемпотентно: повторный прогон
 * ничего не делает. Экспортирована для тестов (изолированные БД).
 */
export function runMigrations(
  db: Db,
  sqlite: Database.Database,
  migrationsFolder: string,
  log?: Logger,
): void {
  baselineLegacyDb(sqlite, migrationsFolder, log);
  migrate(db, { migrationsFolder });
}

let sqlite: Database.Database | null = null;
let db: Db | null = null;

export function openDatabase(log: Logger): Db {
  if (db) return db;
  const file = path.resolve(env.sqlitePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite);
  runMigrations(db, sqlite, MIGRATIONS_DIR, log);
  log.info({ sqlitePath: file }, 'sqlite opened (WAL)');
  return db;
}

export function closeDatabase(): void {
  try {
    sqlite?.close();
  } catch {
    // ignore close errors during shutdown
  }
  sqlite = null;
  db = null;
}
