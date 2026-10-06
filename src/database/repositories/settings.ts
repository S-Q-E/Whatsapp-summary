import { sql } from 'drizzle-orm';
import type { Db } from '../db.js';

/**
 * settings — key/value хранилище серверных настроек.
 * Ключи будущих фаз: digest_time, timezone, owner_jid, digest_test_mode,
 * ai_provider, ai_model. Значения — строки; парсинг на стороне читателя.
 */
export function getSetting(db: Db, key: string): string | null {
  const row = db.get<{ value: string }>(sql`SELECT value FROM settings WHERE key = ${key}`);
  return row?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  const now = Date.now();
  db.run(sql`
    INSERT INTO settings (key, value, updated_at)
    VALUES (${key}, ${value}, ${now})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
}

export function getAllSettings(db: Db): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of db.all<{ key: string; value: string }>(sql`SELECT key, value FROM settings`)) {
    out[r.key] = r.value;
  }
  return out;
}
