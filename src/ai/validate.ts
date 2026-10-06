import { msgKey, parseMsgKey, parseTaskKey, taskKey } from './context.js';
import type { AnalyzeOutput, ConversationInput, ExtractedTask, TaskAction, TaskStatus } from './types.js';

export class AIValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`AI output validation failed: ${problems.join('; ')}`);
    this.name = 'AIValidationError';
    this.problems = problems;
  }
}

/** Вытаскивает JSON из ответа модели (срезает ```json-ограждения и лишний текст). */
export function extractJsonObject(raw: string): unknown {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  if (s.startsWith('{')) {
    try {
      return JSON.parse(s);
    } catch {
      // fall through: попробуем найти вложенный объект
    }
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new AIValidationError(['no JSON object found in model output']);
  }
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    throw new AIValidationError(['model output contains malformed JSON']);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optString(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '') return null;
  return t.slice(0, max);
}

export type ParsedActions = {
  actions: ExtractedTask[];
  /** отброшенные действия: только индексы и ключи, без текста */
  dropped: string[];
};

/**
 * Строгая валидация wire-контракта v3 + проверка ссылок.
 * - структурные ошибки (не JSON, нет actions, плохие поля) → AIValidationError
 *   (повод для единственного retry);
 * - ссылки на несуществующие taskId/evidenceMessageId → действие тихо
 *   отбрасывается, причина — в dropped (только id, без текста переписки).
 */
export function parseModelActions(rawText: string, input: ConversationInput): ParsedActions {
  const raw = extractJsonObject(rawText);
  if (!isRecord(raw)) throw new AIValidationError(['root must be a JSON object']);
  const arr = raw['actions'];
  if (!Array.isArray(arr)) throw new AIValidationError(['"actions" must be an array']);

  const knownTasks = new Set(input.existingTasks.map((t) => t.id));
  const knownMessages = new Set(input.messages.map((m) => m.id));

  const actions: ExtractedTask[] = [];
  const dropped: string[] = [];
  const problems: string[] = [];

  arr.forEach((item, i) => {
    const where = `actions[${i}]`;
    if (!isRecord(item)) {
      problems.push(`${where}: must be an object`);
      return;
    }
    const type = item['type'] as TaskAction | unknown;
    if (type !== 'create' && type !== 'complete' && type !== 'cancel') {
      problems.push(`${where}.type must be "create", "complete" or "cancel"`);
      return;
    }
    let taskId: number | null = null;
    if (type === 'create') {
      if (item['taskId'] !== null && item['taskId'] !== undefined) {
        problems.push(`${where}.taskId is forbidden for "create"`);
        return;
      }
    } else {
      if (item['taskId'] === null || item['taskId'] === undefined) {
        problems.push(`${where}.taskId is required for "${type}"`);
        return;
      }
      const parsed = parseTaskKey(item['taskId']);
      if (parsed === null || !knownTasks.has(parsed)) {
        dropped.push(`${where}.taskId: unknown ${JSON.stringify(item['taskId'])}`);
        return;
      }
      taskId = parsed;
    }
    const title = optString(item['title'], 200);
    if (!title) {
      problems.push(`${where}.title must be a non-empty string`);
      return;
    }
    const confidence = item['confidence'];
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      problems.push(`${where}.confidence must be a number 0..1`);
      return;
    }
    const rawEvidence = item['evidenceMessageId'];
    let messageId: number | null = null;
    if (rawEvidence !== null && rawEvidence !== undefined) {
      const parsed = parseMsgKey(rawEvidence);
      if (parsed === null || !knownMessages.has(parsed)) {
        dropped.push(`${where}.evidenceMessageId: unknown ${JSON.stringify(rawEvidence)}`);
        return;
      }
      messageId = parsed;
    }
    if (type === 'create') {
      const dueAt = optString(item['dueAt'], 64);
      if (dueAt !== null && Number.isNaN(Date.parse(dueAt))) {
        problems.push(`${where}.dueAt must be ISO 8601 date/datetime or null`);
        return;
      }
      const status = optString(item['status'], 32) ?? 'open';
      if (status !== 'open' && status !== 'needs_review') {
        problems.push(`${where}.status must be "open" or "needs_review" for "create"`);
        return;
      }
      actions.push({
        action: type,
        taskId,
        title,
        description: optString(item['description'], 2000),
        status: status as TaskStatus,
        dueAt,
        dueText: optString(item['dueText'], 200),
        confidence,
        messageId,
      });
    } else {
      actions.push({
        action: type,
        taskId,
        title,
        description: optString(item['description'], 2000),
        status: (type === 'complete' ? 'done' : 'cancelled') as TaskStatus,
        dueAt: null,
        dueText: null,
        confidence,
        messageId,
      });
    }
  });

  if (problems.length > 0) throw new AIValidationError(problems);
  return { actions, dropped };
}

/** Статус для отображения: какие ключи известны (для логов без текста). */
export function knownKeys(input: ConversationInput): { tasks: string[]; messages: string[] } {
  return {
    tasks: input.existingTasks.map((t) => taskKey(t.id)),
    messages: input.messages.map((m) => msgKey(m.id)),
  };
}
