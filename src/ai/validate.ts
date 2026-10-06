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
 * - AIValidationError — только если JSON вообще не разобрался или нет
 *   массива actions (повод для единственного retry);
 * - ошибки структуры ОТДЕЛЬНЫХ действий (плохой type/title/confidence/
 *   dueAt/status, кривой формат ключей) — действие отбрасывается с причиной
 *   в dropped, остальные применяются;
 * - ссылки на несуществующие taskId/evidenceMessageId — тоже дроп;
 * - confidence 1..100 нормализуется в 0..1.
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

  arr.forEach((item, i) => {
    const where = `actions[${i}]`;
    if (!isRecord(item)) {
      dropped.push(`${where}: must be an object`);
      return;
    }
    const type = item['type'] as TaskAction | unknown;
    if (type !== 'create' && type !== 'complete' && type !== 'cancel') {
      dropped.push(`${where}.type must be "create", "complete" or "cancel"`);
      return;
    }
    let taskId: number | null = null;
    if (type === 'create') {
      if (item['taskId'] !== null && item['taskId'] !== undefined) {
        dropped.push(`${where}.taskId is forbidden for "create"`);
        return;
      }
    } else {
      if (item['taskId'] === null || item['taskId'] === undefined) {
        dropped.push(`${where}.taskId is required for "${type}"`);
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
      dropped.push(`${where}.title must be a non-empty string`);
      return;
    }
    const confidence = normalizeConfidence(item['confidence']);
    if (confidence === null) {
      dropped.push(`${where}.confidence must be a number 0..1 or 1..100`);
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
        dropped.push(`${where}.dueAt must be ISO 8601 date/datetime or null`);
        return;
      }
      const status = optString(item['status'], 32) ?? 'open';
      if (status !== 'open' && status !== 'needs_review') {
        dropped.push(`${where}.status must be "open" or "needs_review" for "create"`);
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

  return { actions, dropped };
}

/**
 * Нормализация уверенности: 0..1 как есть, 1..100 (проценты) → /100,
 * остальное (NaN, строки, >100, <0) → null = дроп действия.
 */
export function normalizeConfidence(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  if (v <= 1) return v;
  if (v <= 100) return v / 100;
  return null;
}

/** Статус для отображения: какие ключи известны (для логов без текста). */
export function knownKeys(input: ConversationInput): { tasks: string[]; messages: string[] } {
  return {
    tasks: input.existingTasks.map((t) => taskKey(t.id)),
    messages: input.messages.map((m) => msgKey(m.id)),
  };
}
