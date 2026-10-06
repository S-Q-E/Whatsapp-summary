import { env } from '../config/env.js';
import { dayFromIso, endOfDay, startOfDay, toLocalDateString } from '../utils/time.js';

/**
 * Дата-хелперы дайджеста. Границы дня — в TIMEZONE из .env
 * (а не в TZ процесса). Сигнатуры сохранены ради builder/скриптов/тестов.
 */

/** Начало локального дня (TIMEZONE) в ms epoch. */
export function startOfLocalDay(d: Date): number {
  return startOfDay(d, env.timezone);
}

/** 'YYYY-MM-DD' в TIMEZONE. */
export function toIsoLocalDate(d: Date): string {
  return toLocalDateString(d.getTime(), env.timezone);
}

/** '5 октября' — заголовок отчёта (русский, зона TIMEZONE). */
export function formatDayLabel(d: Date): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: env.timezone }).format(d);
}

/** '6 октября' — срок не на сегодня. */
export function formatDeadlineDate(ms: number): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: env.timezone }).format(
    new Date(ms),
  );
}

/**
 * Разбирает --date CLI-аргумента. 'today' — сейчас;
 * 'YYYY-MM-DD' — полдень указанного дня в TIMEZONE (полдень, чтобы
 * границы точно попали в тот же день). Бросает русскую ошибку на плохом вводе.
 */
export function parseDayArg(dateStr: string | undefined): Date {
  const raw = dateStr ?? 'today';
  try {
    if (raw === 'today') return new Date();
    return new Date(dayFromIso(raw, env.timezone));
  } catch {
    throw new Error(`Плохой --date "${raw}", ожидается YYYY-MM-DD или "today"`);
  }
}

export function dayBounds(day: Date): { start: number; end: number } {
  const start = startOfDay(day, env.timezone);
  return { start, end: endOfDay(day, env.timezone) };
}
