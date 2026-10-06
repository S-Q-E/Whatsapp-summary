/**
 * Единое время проекта (AGENTS.md, шаг 1, проблема №3).
 * Внутри всегда UTC ms epoch; границы дня и подписи — в явной зоне
 * (TIMEZONE из .env), а не в TZ процесса. Только Intl, без luxon
 * и без ручной арифметики смещений (DST-сдвиги учитываются сами).
 */

export function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
  } catch {
    throw new Error(`неизвестная временная зона: "${tz}"`);
  }
}

type DateParts = { y: number; mo: number; d: number; h: number; mi: number; s: number };

function partsInTz(ms: number, tz: string): DateParts {
  assertTimeZone(tz);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  return {
    y: Number(p['year']),
    mo: Number(p['month']),
    d: Number(p['day']),
    h: Number(p['hour']) % 24, // Intl иногда отдаёт полночь как "24"
    mi: Number(p['minute']),
    s: Number(p['second']),
  };
}

/** Локальные Y/M/D/H/M/S в epoch ms: вычитаем измеренное смещение зоны. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = partsInTz(guess, tz);
  const asUtc = Date.UTC(back.y, back.mo - 1, back.d, back.h, back.mi, back.s);
  return guess - (asUtc - guess);
}

/** 00:00 дня (в зоне tz) даты, на которую указывает `day`. */
export function startOfDay(day: Date, tz: string): number {
  const p = partsInTz(day.getTime(), tz);
  return zonedToUtc(p.y, p.mo, p.d, 0, 0, 0, tz);
}

/** 00:00 следующего дня в той же зоне (корректно при DST-переходах). */
export function endOfDay(day: Date, tz: string): number {
  const p = partsInTz(day.getTime(), tz);
  // Date.UTC сам переносит переполнение дня на месяц/год
  const next = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
  return zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, tz);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO со смещением зоны: 2026-10-05T19:30:00+05:00 (для промпта и UI). */
export function formatLocal(ms: number, tz: string): string {
  const p = partsInTz(ms, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  const offsetMin = Math.round((asUtc - ms) / 60_000);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return (
    `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** YYYY-MM-DD → полдень этого дня в зоне (epoch ms). Строгий формат. */
export function dayFromIso(isoDate: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`плохая дата "${isoDate}", ожидается YYYY-MM-DD`);
  return zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 12, 0, 0, tz);
}

/** YYYY-MM-DD даты в зоне (для dateIso и dayBounds по строке). */
export function toLocalDateString(ms: number, tz: string): string {
  const p = partsInTz(ms, tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}
