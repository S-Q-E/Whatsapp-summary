import type {
  ClosedTaskSummary,
  ConversationInput,
  ConversationMessage,
  ExistingTaskSummary,
} from './types.js';

/**
 * Ключи сущностей в промпте (шаг 3):
 * - сообщение с messages.id=34 → "m34" (коротко, стабильно, число = id);
 * - открытая задача с tasks.id=12 → "t12".
 * Формат в одном месте: используют prompts (рендер) и validate (разбор).
 */
export function msgKey(id: number): string {
  return `m${id}`;
}

export function taskKey(id: number): string {
  return `t${id}`;
}

/** "m34" -> 34, иначе null. Строго цифры, без ведущих нулей-хвостов. */
export function parseMsgKey(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^m(\d+)$/.exec(raw.trim());
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** "t12" -> 12, иначе null. */
export function parseTaskKey(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^t(\d+)$/.exec(raw.trim());
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export type ChatBundleLike = {
  chatJid: string;
  contactName: string | null;
  messages: ConversationMessage[];
};

export type PromptContext = {
  input: ConversationInput;
  knownTaskIds: Set<number>;
  knownMessageIds: Set<number>;
  timezone: string;
};

/**
 * Собирает контекст чата для модели: сообщения окна (уже отобранные
 * вызывающим: последние N или следующее окно) + все открытые задачи чата
 * + недавно закрытые (чтобы модель их не воскрешала).
 * Здесь же фиксируются множества известных id для проверки ссылок.
 */
export function buildPromptContext(
  bundle: ChatBundleLike,
  openTasks: ExistingTaskSummary[],
  analyzedAt: number,
  timezone: string,
  recentlyClosed: ClosedTaskSummary[] = [],
): PromptContext {
  const input: ConversationInput = {
    chatJid: bundle.chatJid,
    contactName: bundle.contactName,
    messages: bundle.messages,
    existingTasks: openTasks,
    recentlyClosed,
    analyzedAt,
  };
  return {
    input,
    knownTaskIds: new Set([...openTasks, ...recentlyClosed].map((t) => t.id)),
    knownMessageIds: new Set(bundle.messages.map((m) => m.id)),
    timezone,
  };
}
