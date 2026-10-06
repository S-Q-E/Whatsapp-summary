import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { openTestDb } from './db.js';
import { MIGRATIONS_DIR, runMigrations } from '../src/database/db.js';

function tables(db: ReturnType<typeof openTestDb>['db']): string[] {
  return db
    .all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    )
    .map((r) => r.name);
}

describe('версионированные миграции', () => {
  it('чистая БД: создаются contacts/messages/tasks/settings + журнал', () => {
    const { db, close } = openTestDb();
    try {
      const t = tables(db);
      for (const name of ['contacts', 'messages', 'tasks', 'settings', '__drizzle_migrations']) {
        assert.ok(t.includes(name), `нет таблицы ${name}`);
      }
      const n = db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM __drizzle_migrations`);
      assert.ok((n?.n ?? 0) >= 1, 'миграция не записана в журнал');
    } finally {
      close();
    }
  });

  it('повторный прогон идемпотентен', () => {
    const sqlite = new Database(':memory:');
    try {
      const db = drizzle(sqlite) as unknown as Parameters<typeof runMigrations>[0];
      runMigrations(db, sqlite, MIGRATIONS_DIR);
      runMigrations(db, sqlite, MIGRATIONS_DIR); // не должно упасть
      assert.ok(true);
    } finally {
      sqlite.close();
    }
  });

  it('legacy-БД (таблицы без журнала) обновляется без потери данных', () => {
    const sqlite = new Database(':memory:');
    try {
      // Имитация старой БД, созданной BOOTSTRAP_SQL: таблицы есть, журнала нет.
      sqlite.exec(`
        CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, jid TEXT NOT NULL UNIQUE,
          phone TEXT, name TEXT, push_name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, whatsapp_message_id TEXT NOT NULL,
          chat_jid TEXT NOT NULL, sender_jid TEXT, sender_name TEXT, direction TEXT NOT NULL,
          message_type TEXT NOT NULL, text TEXT, timestamp INTEGER NOT NULL,
          is_from_me INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
        INSERT INTO contacts (jid, phone, push_name, created_at, updated_at)
          VALUES ('legacy@s.whatsapp.net', '1', 'Старожил', 1000, 1000);
      `);
      const db = drizzle(sqlite) as unknown as Parameters<typeof runMigrations>[0];
      runMigrations(db, sqlite, MIGRATIONS_DIR);
      // Данные на месте, недостающие таблицы (tasks, settings) достроены
      const row = sqlite.prepare(`SELECT push_name FROM contacts WHERE jid = 'legacy@s.whatsapp.net'`).get() as { push_name: string };
      assert.equal(row.push_name, 'Старожил');
      const t = db
        .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .map((r) => r.name);
      assert.ok(t.includes('tasks') && t.includes('settings'));
    } finally {
      sqlite.close();
    }
  });
});
