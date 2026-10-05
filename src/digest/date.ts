/** Начало локального дня в ms epoch. */
export function startOfLocalDay(d: Date): number {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

/** 'YYYY-MM-DD' локальной даты. */
export function toIsoLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** '5 октября' — заголовок отчёта. */
export function formatDayLabel(d: Date): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(d);
}

/** '6 октября' — срок не на сегодня. */
export function formatDeadlineDate(ms: number): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date(ms));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Разбирает --date CLI-аргумента. Возвращает Date на полдень указанного
 * локального дня (полдень — чтобы startOfLocalDay точно попал в тот же день
 * при любых TZ-сдвигах). Бросает Error на плохом вводе.
 */
export function parseDayArg(dateStr: string | undefined): Date {
  const raw = dateStr ?? 'today';
  const day = raw === 'today' ? new Date() : new Date(`${raw}T12:00:00`);
  if (Number.isNaN(day.getTime()) || (raw !== 'today' && !/^\d{4}-\d{2}-\d{2}$/.test(raw))) {
    throw new Error(`Bad --date "${raw}", expected YYYY-MM-DD or "today"`);
  }
  return day;
}

export function dayBounds(day: Date): { start: number; end: number } {
  const start = startOfLocalDay(day);
  return { start, end: start + DAY_MS };
}
