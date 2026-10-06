import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { endOfDay, formatLocal, startOfDay, toLocalDateString } from '../src/utils/time.js';

const TZ = 'Asia/Almaty'; // +05:00, без DST

describe('utils/time (процесс в UTC, зона Asia/Almaty)', () => {
  it('startOfDay режет в 00:00 по Алматы, а не по UTC', () => {
    // 12:00 UTC = 17:00 в Алматы того же дня
    const got = startOfDay(new Date('2026-10-05T12:00:00Z'), TZ);
    // 00:00+05:00 = 19:00Z предыдущих суток
    assert.equal(got, Date.UTC(2026, 9, 4, 19, 0, 0));
  });

  it('endOfDay — начало следующего дня в той же зоне', () => {
    const start = startOfDay(new Date('2026-10-05T12:00:00Z'), TZ);
    const end = endOfDay(new Date('2026-10-05T12:00:00Z'), TZ);
    assert.equal(end, Date.UTC(2026, 9, 5, 19, 0, 0));
    assert.equal(end - start, 24 * 3_600_000);
  });

  it('без ручной арифметики: день с DST-переходом короче 24ч (America/New_York, 8 марта 2026)', () => {
    const ny = 'America/New_York';
    const start = startOfDay(new Date('2026-03-08T12:00:00Z'), ny);
    const end = endOfDay(new Date('2026-03-08T12:00:00Z'), ny);
    // 00:00 EST (-05) .. 00:00 EDT (-04) следующего дня = 23 часа
    assert.equal(start, Date.UTC(2026, 2, 8, 5, 0, 0));
    assert.equal(end, Date.UTC(2026, 2, 9, 4, 0, 0));
    assert.equal(end - start, 23 * 3_600_000);
  });

  it('formatLocal — ISO со смещением зоны', () => {
    assert.equal(formatLocal(Date.UTC(2026, 9, 5, 14, 30, 0), TZ), '2026-10-05T19:30:00+05:00');
    assert.equal(formatLocal(Date.UTC(2026, 9, 5, 14, 30, 0), 'UTC'), '2026-10-05T14:30:00+00:00');
  });

  it('toLocalDateString — дата в зоне, а не в UTC', () => {
    // 20:00Z 4 окт = уже 01:00 5 окт в Алматы
    assert.equal(toLocalDateString(Date.UTC(2026, 9, 4, 20, 0, 0), TZ), '2026-10-05');
    assert.equal(toLocalDateString(Date.UTC(2026, 9, 4, 20, 0, 0), 'UTC'), '2026-10-04');
  });

  it('невалидная зона — понятная ошибка', () => {
    assert.throws(() => startOfDay(new Date(), 'Mars/Olympus'), /неизвестная временная зона/);
  });
});
