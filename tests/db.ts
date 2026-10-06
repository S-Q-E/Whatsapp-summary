import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { Db } from '../src/database/db.js';
import { MIGRATIONS_DIR, runMigrations } from '../src/database/db.js';
import { logger } from '../src/config/logger.js';

/** Изолированная in-memory БД для тестов — та же миграция, что в проде. */
export function openTestDb(): { db: Db; close: () => void } {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite) as unknown as Db;
  runMigrations(db, sqlite, MIGRATIONS_DIR, logger);
  return { db, close: () => sqlite.close() };
}
