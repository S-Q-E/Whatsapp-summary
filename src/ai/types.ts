import type { TASK_STATUSES } from '../database/schema.js';

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Одно сообщение переписки в том виде, в каком его видит AI. */
export type ConversationMessage = {
  direction: 'incoming' | 'outgoing';
  senderName: string | null;
  /** null для медиа без подписи — AI видит только [image]/[audio]/... */
  text: string | null;
  messageType: string;
  /** ms epoch, для понимания «сегодня/завтра» */
  timestamp: number;
  whatsappMessageId: string;
};

/** Уже известные открытые задачи чата — чтобы AI обновлял, а не дублировал. */
export type ExistingTaskSummary = {
  id: number;
  title: string;
  status: TaskStatus;
};

export type ConversationInput = {
  chatJid: string;
  contactName: string | null;
  /** отсортированы по времени, старые -> новые */
  messages: ConversationMessage[];
  existingTasks: ExistingTaskSummary[];
  /** ms epoch момента анализа — точка отсчёта для «сегодня/завтра/вечером» */
  analyzedAt: number;
};

/**
 * Одна задача в ответе AI.
 * - create: новое обязательство врача.
 * - update: изменение уже известной задачи (matchTitle — её название);
 *   главный кейс — врач выполнил обещанное -> status completed.
 */
export type ExtractedTask = {
  action: 'create' | 'update';
  matchTitle: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  /** ISO 8601 дата/время срока; null если срок не назван */
  deadline: string | null;
  /** исходная фраза срока из переписки («сегодня вечером»), null если нет */
  deadlineText: string | null;
  /** 0..1 */
  confidence: number;
  /** whatsapp_message_id сообщения-источника (обещания или отчёта) */
  sourceMessageId: string | null;
};

export type AnalyzeOutput = {
  tasks: ExtractedTask[];
};

/**
 * Абстракция AI-провайдера. Бизнес-логика (taskService) зависит только
 * от этого интерфейса — конкретную модель можно менять через .env
 * без touching кода сервиса: Ollama, OpenRouter, Gemini, Claude...
 */
export interface AIProvider {
  /** человекочитаемое имя провайдера, пишется в tasks.model */
  readonly name: string;
  /** идентификатор модели, пишется в tasks.model */
  readonly model: string;
  /** версия промпта, пишется в tasks.prompt_version */
  readonly promptVersion: string;
  analyzeConversation(input: ConversationInput): Promise<AnalyzeOutput>;
}
