import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { openTestDb } from './db.js';
import { buildDigest } from '../src/digest/builder.js';
import { parseDayArg, startOfLocalDay } from '../src/digest/date.js';
import { PlainTextDigestRenderer } from '../src/digest/renderer.js';

const DAY = new Date('2026-10-05T12:00:00');
const HOUR = 3_600_000;

function seed(): ReturnType<typeof openTestDb> {
  const { db, close } = openTestDb();
  const s = startOfLocalDay(DAY);

  db.run(sql`INSERT INTO contacts (jid, phone, name, push_name, created_at, updated_at)
    VALUES ('a@s.whatsapp.net', '1', NULL, 'Айгуль', ${s}, ${s})`);

  // Сообщения: 2 входящих сегодня + 1 исходящее сегодня + 1 входящее вчера.
  // Текст с маркером — для проверки, что он НЕ попадает в дайджест.
  const msgs: Array<[string, string, string | null, number]> = [
    ['incoming', 'a@s.whatsapp.net', 'СЕКРЕТНЫЙ-ТЕКСТ-ПЕРЕПИСКИ', s + HOUR],
    ['incoming', 'a@s.whatsapp.net', 'Спасибо!', s + 2 * HOUR],
    ['outgoing', 'a@s.whatsapp.net', 'Да, посмотрю', s + 3 * HOUR],
    ['incoming', 'a@s.whatsapp.net', 'вчерашнее', s - HOUR],
  ];
  msgs.forEach(([dir, chat, text, ts], i) => {
    db.run(sql`INSERT INTO messages
      (whatsapp_message_id, chat_jid, sender_jid, sender_name, direction, message_type, text, timestamp, is_from_me, created_at)
      VALUES (${`m${i}`}, ${chat}, ${chat}, NULL, ${dir}, 'text', ${text}, ${ts}, ${dir === 'outgoing' ? 1 : 0}, ${ts})`);
  });

  // Задачи: id 1..7
  const tasks: Array<[string, string, number | null, string | null, number | null, number, number]> = [
    // title, status, deadline, deadlineText, confidence, createdAt, updatedAt/completedAt
    ['Просроченная', 'pending', s - HOUR, null, 0.9, s - 2 * 24 * HOUR, s - 2 * 24 * HOUR], // attention
    ['Срок сегодня (ms)', 'pending', s + 5 * HOUR, null, 0.6, s, s], // attention
    ['Срок сегодня (текст)', 'pending', null, 'сегодня вечером', 0.6, s, s], // attention
    ['На завтра', 'pending', null, 'завтра утром', 0.6, s, s], // promised
    ['Без срока', 'pending', null, null, 0.3, s, s], // promised, low
    ['Сомнительная', 'uncertain', null, null, null, s, s], // attention (null conf -> medium)
    ['Выполнена сегодня', 'completed', null, null, 0.95, s - 24 * HOUR, s + HOUR], // completed (completedAt=s+HOUR)
  ];
  tasks.forEach(([title, status, deadline, dtext, conf, created, touched], i) => {
    const completed = status === 'completed' ? touched : null;
    db.run(sql`INSERT INTO tasks
      (chat_jid, contact_id, title, description, source_message_id, deadline, deadline_text,
       status, confidence, model, prompt_version, created_at, updated_at, completed_at)
      VALUES ('a@s.whatsapp.net', 1, ${title}, NULL, ${`src${i}`}, ${deadline}, ${dtext},
        ${status}, ${conf}, 'm', 'v1', ${created}, ${touched}, ${completed})`);
  });
  // Выполнена вчера + отменённая — в отчёт попасть не должны
  db.run(sql`INSERT INTO tasks (chat_jid, title, status, confidence, created_at, updated_at, completed_at)
    VALUES ('a@s.whatsapp.net', 'Вчерашняя', 'completed', 1, ${s - 2 * 24 * HOUR}, ${s - 24 * HOUR}, ${s - 24 * HOUR + HOUR})`);
  db.run(sql`INSERT INTO tasks (chat_jid, title, status, created_at, updated_at)
    VALUES ('a@s.whatsapp.net', 'Отменённая', 'cancelled', ${s}, ${s})`);

  return { db, close };
}

describe('buildDigest', () => {
  it('раскладывает задачи по секциям', () => {
    const { db, close } = seed();
    try {
      const d = buildDigest(db, DAY);
      assert.deepEqual(d.sections.attention.map((t) => t.title), ['Просроченная', 'Срок сегодня (ms)', 'Срок сегодня (текст)', 'Сомнительная']);
      assert.deepEqual(d.sections.promised.map((t) => t.title), ['На завтра', 'Без срока']);
      assert.deepEqual(d.sections.completed.map((t) => t.title), ['Выполнена сегодня']);
      assert.equal(d.dateIso, '2026-10-05');
    } finally {
      close();
    }
  });

  it('считает статистику', () => {
    const { db, close } = seed();
    try {
      const s = buildDigest(db, DAY).stats;
      assert.equal(s.incomingMessages, 2);
      assert.equal(s.activeTasks, 6);
      assert.equal(s.completedTasks, 1);
      assert.equal(s.tasksWithoutDeadline, 4); // На завтра, Без срока, Сомнительная, Срок-текст
      assert.equal(s.confidenceHigh, 1); // 0.9
      assert.equal(s.confidenceMedium, 4); // 0.6 x3 + null
      assert.equal(s.confidenceLow, 1); // 0.3
    } finally {
      close();
    }
  });
});

describe('PlainTextDigestRenderer', () => {
  it('порядок секций, сквозная нумерация, сроки, статистика, без текста переписок', () => {
    const { db, close } = seed();
    try {
      const out = new PlainTextDigestRenderer().render(buildDigest(db, DAY));
      const iAtt = out.indexOf('🔴 Требует внимания');
      const iProm = out.indexOf('🟡 Обещано');
      const iDone = out.indexOf('✅ Выполнено');
      const iStat = out.indexOf('📊 Статистика');
      assert.ok(iAtt < iProm && iProm < iDone && iDone < iStat);
      assert.ok(out.includes('📋 Итоги за 5 октября'));
      assert.ok(/1\. Айгуль[\s\S]*2\. Айгуль[\s\S]*5\. Айгуль[\s\S]*6\. Айгуль[\s\S]*7\. Айгуль/.test(out));
      assert.ok(out.includes('Срок: сегодня вечером'));
      assert.ok(out.includes('Срок: не указан'));
      assert.ok(out.includes('Входящих сообщений: 2'));
      assert.ok(out.includes('Активных задач: 6'));
      assert.ok(!out.includes('СЕКРЕТНЫЙ-ТЕКСТ-ПЕРЕПИСКИ'));
      assert.ok(!out.includes('Вчерашняя'));
    } finally {
      close();
    }
  });

  it('пустой день — заглушка вместо секций', () => {
    const { db, close } = openTestDb();
    try {
      const out = new PlainTextDigestRenderer().render(buildDigest(db, DAY));
      assert.ok(out.includes('📋 Итоги за 5 октября'));
      assert.ok(!out.includes('🔴'));
      assert.ok(out.includes('Входящих сообщений: 0'));
    } finally {
      close();
    }
  });
});

describe('parseDayArg', () => {
  it('today и YYYY-MM-DD — ок, мусор — ошибка', () => {
    assert.ok(parseDayArg(undefined) instanceof Date);
    assert.equal(parseDayArg('2026-10-05').getDate(), 5);
    assert.throws(() => parseDayArg('вчера'), /Bad --date/);
    assert.throws(() => parseDayArg('05.10.2026'), /Bad --date/);
  });
});
