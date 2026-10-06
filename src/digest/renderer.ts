import { endOfDay, startOfDay, dayFromIso } from '../utils/time.js';
import type { DailyDigest, DigestRenderer, DigestTaskItem } from './types.js';

/**
 * Plain-text рендер: только текст, эмодзи и переносы строк.
 * Без markdown-разметки — такой формат одинаково уходит и в Telegram,
 * и в WhatsApp без изменений бизнес-логики (builder отдаёт DailyDigest,
 * доставка потом просто вызовет render()).
 */
export class PlainTextDigestRenderer implements DigestRenderer {
  render(d: DailyDigest): string {
    const lines: string[] = [`📋 Итоги за ${d.dateLabel}`, ''];
    let n = 0;

    const section = (emoji: string, title: string, items: DigestTaskItem[]): void => {
      if (items.length === 0) return;
      lines.push(`${emoji} ${title}`, '');
      for (const t of items) {
        n += 1;
        lines.push(`${n}. ${t.contactName}`);
        lines.push(`   ${t.title}`);
        lines.push(`   Срок: ${t.deadlineLabel ?? 'не указан'}`);
        lines.push('');
      }
    };

    section('🔴', 'Требует внимания', d.sections.attention);
    section('🟡', 'Обещано', d.sections.promised);
    section('✅', 'Выполнено', d.sections.completed);

    if (n === 0) {
      lines.push('Задач за день нет — так держать.', '');
    }

    const s = d.stats;
    lines.push('📊 Статистика');
    lines.push(`Входящих сообщений: ${s.incomingMessages}`);
    lines.push(`Активных задач: ${s.activeTasks}`);
    lines.push(`Выполнено за день: ${s.completedTasks}`);
    lines.push(`Без срока: ${s.tasksWithoutDeadline}`);
    lines.push(
      `Уверенность: высокая — ${s.confidenceHigh}, средняя — ${s.confidenceMedium}, низкая — ${s.confidenceLow}`,
    );
    lines.push(`🎙 Непрослушанных голосовых: ${s.unheardVoice}`);

    return lines.join('\n');
  }
}

/** Имя для дайджеста: JID без имени → «Неизвестный контакт». */
function displayName(item: DigestTaskItem): string {
  return item.contactName.includes('@') ? 'Неизвестный контакт' : item.contactName;
}

/** Срок относительно даты дайджеста (шаг 7): сегодня/завтра/пн, 12 октября. */
function relativeDue(dueAt: number | null, dayStart: number, dayEnd: number, timezone: string): string {
  if (dueAt === null) return 'не указан';
  if (dueAt < dayStart) return 'просрочено';
  if (dueAt < dayEnd) return 'сегодня';
  if (dueAt < dayEnd + 86_400_000) return 'завтра';
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    timeZone: timezone,
  }).format(new Date(dueAt));
}

/**
 * Формат для отправки в WhatsApp владельцу (шаг 7): короче CLI-версии —
 * без блока уверенности и статистики, сроки относительные, needs_review
 * одной строкой. Только метаданные задач, текстов переписок нет.
 */
export function renderWhatsAppDigest(d: DailyDigest, timezone: string): string {
  const noon = dayFromIso(d.dateIso, timezone);
  const ref = new Date(noon);
  const dayStart = startOfDay(ref, timezone);
  const dayEnd = endOfDay(ref, timezone);

  const lines: string[] = ['📋 Итоги дня', ''];
  let n = 0;
  let remaining = 0;

  /** Карточка задачи; у выполненных срока нет — только факт. */
  const item = (t: DigestTaskItem, showDue: boolean): void => {
    n += 1;
    lines.push(`${n}. ${displayName(t)}`);
    lines.push(t.title);
    if (showDue) lines.push(`Срок: ${relativeDue(t.dueAt, dayStart, dayEnd, timezone)}`);
    lines.push('');
  };

  /** Топ-15 секции + хвост «…и ещё N». */
  const TOP = 15;
  const cap = (items: DigestTaskItem[]): { head: DigestTaskItem[]; rest: number } =>
    items.length > TOP ? { head: items.slice(0, TOP), rest: items.length - TOP } : { head: items, rest: 0 };

  const open = (items: DigestTaskItem[]): DigestTaskItem[] =>
    items.filter((t) => t.status === 'open');
  const review = (items: DigestTaskItem[]): DigestTaskItem[] =>
    items.filter((t) => t.status === 'needs_review');

  const attention = open(d.sections.attention);
  const promised = open(d.sections.promised);
  // needs_review со всех открытых секций — одной короткой строкой
  const reviews = [...review(d.sections.attention), ...review(d.sections.promised)];
  remaining = attention.length + promised.length + reviews.length;

  if (attention.length > 0) {
    // сначала просроченные, потом остальные
    const sorted = [...attention].sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
    lines.push('🔴 Нужно сделать', '');
    const { head, rest } = cap(sorted);
    for (const t of head) item(t, true);
    if (rest > 0) lines.push(`…и ещё ${rest}`, '');
  }
  if (promised.length > 0) {
    lines.push('🟡 Обещано', '');
    const { head, rest } = cap(promised);
    for (const t of head) item(t, true);
    if (rest > 0) lines.push(`…и ещё ${rest}`, '');
  }
  if (d.sections.completed.length > 0) {
    lines.push('✅ Выполнено сегодня', '');
    const { head, rest } = cap(d.sections.completed);
    for (const t of head) item(t, false);
    if (rest > 0) lines.push(`…и ещё ${rest}`, '');
  }
  if (reviews.length > 0) {
    lines.push(`❓ Проверьте (${reviews.length}): ${reviews.map((t) => t.title).join('; ')}`, '');
  }
  if (n === 0 && reviews.length === 0) {
    lines.push('Задач за день нет — так держать.', '');
  }

  const done = d.sections.completed.length;
  lines.push(`Всего задач: ${remaining + done}`);
  lines.push(`Выполнено: ${done}`);
  lines.push(`Осталось: ${remaining}`);

  return lines.join('\n');
}
