import type { ConversationInput } from './types.js';

/**
 * Prompt versioning: КАЖДЫЙ результат AI сохраняет prompt_version
 * (см. tasks.prompt_version). Правила:
 * - любое изменение текста промпта или JSON-контракта => новая версия
 *   вида 'task-extract-vN' (v1, v2, ...), старую не удалять из истории git;
 * - провайдеры берут версию отсюда, а не хардкодят свою;
 * - сравнение качества версий — по tasks.confidence + ручной проверке.
 */
export const PROMPT_VERSION = 'task-extract-v1';

const SYSTEM_PROMPT = `Ты — секретарь врача. Анализируешь КОНТЕКСТ переписки врача с пациентом или коллегой и извлекаешь ОБЯЗАТЕЛЬСТВА ВРАЧА — конкретные дела, которые врач пообещал сделать.

КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА:
1. Задача — это только конкретное обязательство ВРАЧА (автор сообщений "ВРАЧ"), подтверждённое врачом: посмотреть анализы, отправить документ/результаты, позвонить, написать, уточнить информацию, напомнить о приёме.
2. НЕ создавай задачу, если:
   - пациент просто благодарит ("Спасибо!"), а врач вежливо отвечает;
   - пациент задаёт вопрос, а врач просто отвечает фактом ("Вы сегодня принимаете?" — "Да, с 9 до 13"). Это ответ, а не обязательство;
   - просьба пациента осталась БЕЗ подтверждения врача;
   - сообщение — smalltalk без конкретных действий.
3. Если врач позже сообщает о выполнении ("Посмотрела ваши анализы, всё в норме", "Отправила результаты") — это НЕ новая задача, а завершение существующей: верни action "update", matchTitle с названием задачи из списка известных задач, status "completed".
4. Если уверенность низкая (намёк без явного обещания) — всё равно верни задачу, но со status "uncertain" и честной confidence.
5. Срок (deadline): только если назван явно ("сегодня вечером", "завтра утром", конкретная дата). Отсчитывай от текущего времени, указанного во входных данных. Формат deadline — ISO 8601. В deadlineText сохрани исходную фразу. Если срока нет — оба поля null.
6. Отвечай СТРОГО одним JSON-объектом без пояснений, markdown и комментариев:
{"tasks": [{"action": "create|update", "matchTitle": string|null, "title": string, "description": string|null, "status": "pending|completed|cancelled|uncertain", "deadline": string|null, "deadlineText": string|null, "confidence": 0..1, "sourceMessageId": string|null}]}
Пустой результат: {"tasks": []}.`;

function formatMessage(
  m: ConversationInput['messages'][number],
  idx: number,
): string {
  const who = m.direction === 'outgoing' ? 'ВРАЧ' : `СОБЕСЕДНИК${m.senderName ? ` (${m.senderName})` : ''}`;
  const time = new Date(m.timestamp).toISOString();
  const body = m.text ?? `[${m.messageType}, без текста]`;
  return `${idx + 1}. [${time}] ${who}: ${body}`;
}

/** Строит user-часть промпта из контекста переписки одного чата. */
export function buildUserPrompt(input: ConversationInput): string {
  const lines = input.messages.map(formatMessage);
  const known =
    input.existingTasks.length > 0
      ? input.existingTasks.map((t) => `- [${t.id}] "${t.title}" (${t.status})`).join('\n')
      : '(нет известных открытых задач)';
  return [
    `Текущее время: ${new Date(input.analyzedAt).toISOString()}`,
    `Чат: ${input.chatJid}${input.contactName ? ` (${input.contactName})` : ''}`,
    '',
    'Известные открытые задачи этого чата:',
    known,
    '',
    'Переписка (по порядку):',
    ...lines,
    '',
    'Верни JSON.',
  ].join('\n');
}

/** Полный промпт для chat-style провайдеров. */
export function buildPrompt(input: ConversationInput): { system: string; user: string } {
  return { system: SYSTEM_PROMPT, user: buildUserPrompt(input) };
}
