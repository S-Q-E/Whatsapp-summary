import { TASK_STATUSES } from '../database/schema.js';
import type { AnalyzeOutput, ExtractedTask, TaskStatus } from './types.js';

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

/**
 * Строгая валидация + нормализация сырого ответа модели.
 * Невалидные элементы целиком отбрасываются (с перечислением причин),
 * валидные возвращаются очищенными от лишних полей.
 */
export function validateAnalyzeOutput(raw: unknown): AnalyzeOutput {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new AIValidationError(['root must be a JSON object']);
  const arr = raw['tasks'];
  if (!Array.isArray(arr)) throw new AIValidationError(['"tasks" must be an array']);

  const tasks: ExtractedTask[] = [];
  arr.forEach((item, i) => {
    const where = `tasks[${i}]`;
    if (!isRecord(item)) {
      problems.push(`${where}: must be an object`);
      return;
    }
    const action = item['action'];
    if (action !== 'create' && action !== 'update') {
      problems.push(`${where}.action must be "create" or "update"`);
      return;
    }
    const title = optString(item['title'], 200);
    if (!title) {
      problems.push(`${where}.title must be a non-empty string`);
      return;
    }
    const status = item['status'];
    if (typeof status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(status)) {
      problems.push(`${where}.status must be one of ${TASK_STATUSES.join('|')}`);
      return;
    }
    const confidence = item['confidence'];
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      problems.push(`${where}.confidence must be a number 0..1`);
      return;
    }
    let deadline: string | null = optString(item['deadline'], 64);
    if (deadline !== null && Number.isNaN(Date.parse(deadline))) {
      problems.push(`${where}.deadline must be ISO 8601 date/datetime or null`);
      return;
    }
    tasks.push({
      action,
      matchTitle: action === 'update' ? optString(item['matchTitle'], 200) : null,
      title,
      description: optString(item['description'], 2000),
      status: status as TaskStatus,
      deadline,
      deadlineText: optString(item['deadlineText'], 200),
      confidence,
      sourceMessageId: optString(item['sourceMessageId'], 128),
    });
  });

  if (problems.length > 0) throw new AIValidationError(problems);
  return { tasks };
}

/** Полный путь: сырой текст модели -> проверенный AnalyzeOutput. */
export function parseModelOutput(rawText: string): AnalyzeOutput {
  return validateAnalyzeOutput(extractJsonObject(rawText));
}
