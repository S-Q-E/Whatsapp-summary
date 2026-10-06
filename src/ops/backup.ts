import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { env } from '../config/env.js';
import { formatLocal, toLocalDateString } from '../utils/time.js';

const PREFIX = 'whatsapp-';

/** Имя бэкапа -> локальная дата YYYY-MM-DD (или null, если имя чужое). */
function backupFileDate(name: string): string | null {
  const m = /^whatsapp-(\d{4}-\d{2}-\d{2})T/.exec(name);
  return m ? m[1]! : null;
}

/** Метка времени бэкапа в той же зоне, что и проверка суток. */
function backupStamp(nowMs: number, timezone: string): string {
  return formatLocal(nowMs, timezone).slice(0, 19).replace(/:/g, '-');
}

/**
 * Ежедневный бэкап SQLite через backup API (шаг 9): консистентная копия
 * работающей WAL-базы в data/backups. Auth-папка НЕ копируется никогда —
 * здесь только один sqlite-файл. Не чаще раза в календарные сутки:
 * если сегодняшний бэкап уже есть — пропуск (возвращает null).
 */
export async function runBackup(
  sqliteFile: string,
  backupDir: string,
  keepN: number,
  log: Logger,
  opts: { timezone?: string } = {},
): Promise<string | null> {
  fs.mkdirSync(backupDir, { recursive: true });
  const tz = opts.timezone ?? env.timezone;
  const today = toLocalDateString(Date.now(), tz);
  let existing: string[] = [];
  try {
    existing = fs.readdirSync(backupDir).filter((f) => f.startsWith(PREFIX) && f.endsWith('.db'));
  } catch {
    existing = [];
  }
  if (existing.some((f) => backupFileDate(f) === today)) {
    log.info({ backupDir }, 'backup already done today, skipping');
    return null;
  }
  const stamp = backupStamp(Date.now(), tz);
  const dest = path.join(backupDir, `${PREFIX}${stamp}.db`);
  const src = new Database(sqliteFile, { readonly: true });
  try {
    await src.backup(dest);
  } finally {
    src.close();
  }
  log.info({ dest }, 'sqlite backup done');
  rotateBackups(backupDir, keepN, log);
  return dest;
}

/** Ротация: оставляет последние keepN бэкапов, возвращает их число. */
export function rotateBackups(backupDir: string, keepN: number, log?: Logger): number {
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith(PREFIX) && f.endsWith('.db'))
      .sort()
      .reverse();
  } catch {
    return 0;
  }
  const stale = files.slice(Math.max(0, keepN));
  for (const f of stale) {
    try {
      fs.unlinkSync(path.join(backupDir, f));
    } catch (err) {
      log?.warn({ err, file: f }, 'backup rotation: cannot delete');
    }
  }
  return files.length - stale.length;
}
