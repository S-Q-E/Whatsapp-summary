import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Logger } from 'pino';
import { env } from '../config/env.js';

export type Db = BetterSQLite3Database<Record<string, never>>;

let sqlite: Database.Database | null = null;
let db: Db | null = null;

/**
 * DDL kept in code so the FIRST run works without a separate
 * `drizzle-kit migrate` step. drizzle-kit (drizzle.config.ts + ./drizzle)
 * is used for future versioned migrations; this is an idempotent bootstrap.
 * Exported for tests (in-memory DB setup).
 */
export const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL UNIQUE,
  phone TEXT,
  name TEXT,
  push_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_message_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  sender_jid TEXT,
  sender_name TEXT,
  direction TEXT NOT NULL,
  message_type TEXT NOT NULL,
  text TEXT,
  timestamp INTEGER NOT NULL,
  is_from_me INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_wamid_chat_uidx
  ON messages (whatsapp_message_id, chat_jid);
CREATE INDEX IF NOT EXISTS messages_chat_idx ON messages (chat_jid);
CREATE INDEX IF NOT EXISTS messages_timestamp_idx ON messages (timestamp);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  contact_id INTEGER,
  title TEXT NOT NULL,
  description TEXT,
  source_message_id TEXT,
  deadline INTEGER,
  deadline_text TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  confidence REAL,
  model TEXT,
  prompt_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_chat_idx ON tasks (chat_jid);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export function openDatabase(log: Logger): Db {
  if (db) return db;
  const file = path.resolve(env.sqlitePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(BOOTSTRAP_SQL);
  db = drizzle(sqlite);
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
