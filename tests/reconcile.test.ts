import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { openTestDb } from './db.js';
import { MockProvider } from '../src/ai/providers/mock.js';
import { reconcileTasks, type ChatBundle } from '../src/ai/taskService.js';
import type { ExtractedTask } from '../src/ai/types.js';

const log = pino({ level: 'silent' });
const bundle: ChatBundle = { chatJid: 'demo@s.whatsapp.net', contactName: 'Пациент', contactId: 7, messages: [] };
const provider = new MockProvider();

function task(db: ReturnType<typeof openTestDb>['db'], id: number) {
  return db.get<{ status: string; completed_at: number | null; confidence: number | null; model: string | null; prompt_version: string | null }>(
    sql`SELECT status, completed_at, confidence, model, prompt_version FROM tasks WHERE id = ${id}`,
  );
}

const created = (title = 'Посмотреть анализы'): ExtractedTask[] => [
  { action: 'create', matchTitle: null, title, description: 'd', status: 'pending', deadline: null, deadlineText: 'сегодня вечером', confidence: 0.9, sourceMessageId: 'M1' },
];

describe('reconcileTasks — идемпотентная сверка с БД', () => {
  it('создаёт задачу с provenance (model/prompt_version/confidence)', () => {
    const { db, close } = openTestDb();
    try {
      const r = reconcileTasks(db, log, bundle, created(), provider, 1000);
      assert.equal(r.created.length, 1);
      assert.equal(r.updated.length, 0);
      const t = task(db, r.created[0]!.id);
      assert.equal(t?.status, 'pending');
      assert.equal(t?.model, 'mock:mock-test-v1');
      assert.equal(t?.prompt_version, provider.promptVersion);
      assert.equal(t?.confidence, 0.9);
      assert.equal(t?.completed_at, null);
    } finally {
      close();
    }
  });

  it('повторный прогон не дублирует (create по тому же названию -> update)', () => {
    const { db, close } = openTestDb();
    try {
      reconcileTasks(db, log, bundle, created(), provider, 1000);
      const r2 = reconcileTasks(db, log, bundle, created(), provider, 2000);
      assert.equal(r2.created.length, 0);
      assert.equal(r2.updated.length, 1);
      const n = db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tasks`);
      assert.equal(n?.n, 1);
    } finally {
      close();
    }
  });

  it('update с matchTitle переводит pending -> completed и ставит completed_at', () => {
    const { db, close } = openTestDb();
    try {
      reconcileTasks(db, log, bundle, created(), provider, 1000);
      const r = reconcileTasks(db, log, bundle, [
        { action: 'update', matchTitle: 'посмотреть анализы', title: 'Посмотреть анализы', description: 'врач отчиталась', status: 'completed', deadline: null, deadlineText: null, confidence: 0.95, sourceMessageId: 'M9' },
      ], provider, 5000);
      assert.equal(r.updated.length, 1);
      assert.equal(r.created.length, 0);
      const t = task(db, r.updated[0]!.id);
      assert.equal(t?.status, 'completed');
      assert.equal(t?.completed_at, 5000);
    } finally {
      close();
    }
  });

  it('закрытые задачи не воскрешаются новым create', () => {
    const { db, close } = openTestDb();
    try {
      reconcileTasks(db, log, bundle, created(), provider, 1000);
      reconcileTasks(db, log, bundle, [
        { action: 'update', matchTitle: 'Посмотреть анализы', title: 'Посмотреть анализы', description: null, status: 'completed', deadline: null, deadlineText: null, confidence: 1, sourceMessageId: 'M9' },
      ], provider, 2000);
      const r = reconcileTasks(db, log, bundle, created(), provider, 3000);
      assert.equal(r.created.length, 0);
      const n = db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tasks`);
      assert.equal(n?.n, 1);
    } finally {
      close();
    }
  });

  it('повторный отчёт о выполнении не дублирует completed (идемпотентность репрогона)', () => {
    const { db, close } = openTestDb();
    try {
      const done: ExtractedTask[] = [
        { action: 'update', matchTitle: 'Посмотреть анализы', title: 'Посмотреть анализы', description: null, status: 'completed', deadline: null, deadlineText: null, confidence: 0.95, sourceMessageId: 'M9' },
      ];
      reconcileTasks(db, log, bundle, created(), provider, 1000);
      reconcileTasks(db, log, bundle, done, provider, 2000);
      const r = reconcileTasks(db, log, bundle, done, provider, 3000);
      assert.equal(r.created.length, 0);
      assert.equal(r.updated.length, 0);
      const n = db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tasks`);
      assert.equal(n?.n, 1);
    } finally {
      close();
    }
  });

  it('uncertain сохраняется для ручной проверки', () => {
    const { db, close } = openTestDb();
    try {
      const r = reconcileTasks(db, log, bundle, [
        { action: 'create', matchTitle: null, title: 'Возможно уточнить у кардиолога', description: null, status: 'uncertain', deadline: null, deadlineText: null, confidence: 0.35, sourceMessageId: 'M3' },
      ], provider, 1000);
      assert.equal(r.created.length, 1);
      assert.equal(r.created[0]?.status, 'uncertain');
    } finally {
      close();
    }
  });
});
