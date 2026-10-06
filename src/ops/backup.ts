import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';

const PREFIX = 'whatsapp-';

/**
 * Ежедневный бэкап SQLite через backup API (шаг 9): консистентная копия
 * работающей WAL-базы в data/backups. Auth-папка НЕ копируется никогда —
 * здесь только один sqlite-файл.
 */
export async function runBackup(
  sqliteFile: string,
  backupDir: string,
  keepN: number,
  log: Logger,
): Promise<string> {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
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
