import type { TaskStatus } from '../database/schema.js';

/** Секции дайджеста. Порядок фиксирован: attention -> promised -> completed. */
export type DigestSection = 'attention' | 'promised' | 'completed';

export type DigestTaskItem = {
  id: number;
  chatJid: string;
  contactName: string;
  title: string;
  status: TaskStatus;
  /** человекочитаемый срок: deadline_text, «сегодня» или дата; null = не указан */
  deadlineLabel: string | null;
  confidence: number | null;
};

export type DigestStats = {
  /** входящих сообщений за день */
  incomingMessages: number;
  /** открытых задач сейчас (pending + uncertain, за всё время) */
  activeTasks: number;
  /** выполненных за день */
  completedTasks: number;
  /** из активных — без срока */
  tasksWithoutDeadline: number;
  /** разбивка активных по уверенности: high >= 0.8, medium 0.5–0.8, low < 0.5 (null = medium) */
  confidenceHigh: number;
  confidenceMedium: number;
  confidenceLow: number;
  /** голосовых без processed_at (ещё не разобраны) — транскрибации пока нет */
  unheardVoice: number;
};

export type DailyDigest = {
  /** '2026-10-05' */
  dateIso: string;
  /** '5 октября' */
  dateLabel: string;
  sections: Record<DigestSection, DigestTaskItem[]>;
  stats: DigestStats;
};

/**
 * Форматтер дайджеста. Бизнес-логика (builder) отдаёт DailyDigest,
 * а доставка (терминал сейчас, Telegram/WhatsApp позже) — дело рендера.
 * Новый канал = новый класс, без изменений builder и CLI.
 */
export interface DigestRenderer {
  render(digest: DailyDigest): string;
}
