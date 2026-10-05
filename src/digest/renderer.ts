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

    return lines.join('\n');
  }
}
