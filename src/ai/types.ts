import type { TASK_STATUSES } from '../database/schema.js';

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Одно сообщение переписки в том виде, в каком его видит AI. */
export type ConversationMessage = {
  /** внутренний messages.id — в промпте фигурирует как ключ m<id> */
  id: number;
  direction: 'incoming' | 'outgoing';
  senderName: string | null;
  /** null для медиа без подписи — AI видит только [image]/[audio]/... */
  text: string | null;
  messageType: string;
  /** секунды для voice/audio/video, иначе null */
  durationSec: number | null;
  /** ms epoch, для понимания «сегодня/завтра» */
  timestamp: number;
  whatsappMessageId: string;
};

/** Уже известные открытые задачи чата — AI закрывает их по id. */
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

export type TaskAction = 'create' | 'complete' | 'cancel';

/**
 * Сырое действие из ответа модели (wire-контракт, см. промпт v3).
 * Ссылки — ключами промпта: taskId "t12" (известная открытая задача),
 * evidenceMessageId "m34" (сообщение из контекста). Проверяются
 * в validate по известным множествам id; битые ссылки отбрасываются.
 */
export type WireAction = {
  type: TaskAction;
  taskId: string | null;
  title: string;
  description: string | null;
  dueAt: string | null;
  dueText: string | null;
  evidenceMessageId: string | null;
  confidence: number;
};

/**
 * Проверенное внутреннее действие для reconcile.
 * - create: новое обязательство врача → всегда НОВАЯ строка в БД.
 * - complete/cancel: переход известной задачи по taskId (числу).
 * - messageId: внутренний messages.id доказательства (обещания/отчёта).
 */
export type ExtractedTask = {
  action: TaskAction;
  /** обязателен для complete/cancel, запрещён для create */
  taskId: number | null;
  title: string;
  description: string | null;
  /** для create: 'open' | 'needs_review' */
  status: TaskStatus;
  /** ISO 8601 со смещением; null если срок не назван */
  dueAt: string | null;
  /** исходная фраза срока из переписки («сегодня вечером»), null если нет */
  dueText: string | null;
  /** 0..1 */
  confidence: number;
  /** внутренний messages.id сообщения-доказательства */
  messageId: number | null;
};

export type AnalyzeOutput = {
  tasks: ExtractedTask[];
  /** отброшенные действия (битые ссылки): только индексы и ключи, без текста */
  dropped?: string[];
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
