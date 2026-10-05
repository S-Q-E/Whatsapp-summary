import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { Db } from '../src/database/db.js';
import { BOOTSTRAP_SQL } from '../src/database/db.js';

/** Изолированная in-memory БД для тестов (ingestion-код не трогаем). */
export function openTestDb(): { db: Db; close: () => void } {
  const sqlite = new Database(':memory:');
  sqlite.exec(BOOTSTRAP_SQL);
  const db = drizzle(sqlite) as unknown as Db;
  return { db, close: () => sqlite.close() };
}
