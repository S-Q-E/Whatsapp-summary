import { formatLocal } from '../utils/time.js';
import { msgKey, taskKey } from './context.js';
import type { ConversationInput } from './types.js';

/**
 * История версий (v1/v2 живут в git-истории, не удалять):
 * - v1: контракт create|update + matchTitle (сопоставление по названию);
 * - v2: контракт create|complete|cancel + taskId числом, источник — wamid;
 * - v3: ссылки ключами промпта (t<id>/m<id>), время в TIMEZONE со смещением.
 * - v4: окно = prior-контекст (isContext, пометка «[контекст, уже разобрано]»)
 *   + новые; задачи create — только из новых, контекст — для смысла и как
 *   evidence для complete/cancel.
 */
export const PROMPT_VERSION = 'task-extract-v4';

const SYSTEM_PROMPT = `Ты — секретарь врача. Анализируешь КОНТЕКСТ переписки врача с пациентом или коллегой и извлекаешь ОБЯЗАТЕЛЬСТВА ВРАЧА — конкретные дела, которые врач пообещал сделать.

КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА:
1. Задача — это только конкретное обязательство ВРАЧА (автор сообщений "ВРАЧ") или принятая врачом просьба: посмотреть анализы, отправить документ/результаты, позвонить, написать, уточнить информацию, напомнить о приёме.
2. НЕ создавай задачу, если:
   - пациент просто благодарит ("Спасибо!"), а врач вежливо отвечает;
   - пациент задаёт вопрос, а врач просто отвечает фактом ("Вы сегодня принимаете?" — "Да, с 9 до 13"). Это ответ, а не обязательство;
   - просьба пациента осталась БЕЗ принятия врачом;
   - сообщение — smalltalk без конкретных действий.
3. Если врач сообщает о выполнении известной задачи ("Посмотрела ваши анализы, всё в норме", "Отправила результаты") — это НЕ новая задача: верни action "complete" с taskId этой задачи. taskId бери ТОЛЬКО из списка известных задач ниже ("t12" — taskId "t12"). Не выдумывай id. Если похожей задачи в списке нет — ничего не возвращай по этому поводу.
4. Если врач отменяет обещанное ("Не смогу позвонить, давайте перенесём") — верни action "cancel" с taskId из списка.
5. Если уверенность низкая (намёк без явного обещания) — всё равно верни задачу action "create", но со status "needs_review" и честной низкой confidence.
6. Срок (dueAt): только если назван явно ("сегодня вечером", "завтра утром", конкретная дата). Считай от текущего локального времени, указанного во входных данных (время уже с часовым поясом). Формат dueAt — ISO 8601 со смещением. В dueText сохрани исходную фразу. Если срока нет — оба поля null.
7. evidenceMessageId — ключ [m..] того сообщения, где врач пообещал (create) или отчитался/отменил (complete/cancel). Только реально существующий ключ из переписки ниже.
8. Сообщения с пометкой «[контекст, уже разобрано]» — это уже разобранный контекст: задачи create создавай ТОЛЬКО из новых сообщений (без пометки). Контекстные используй для понимания смысла реплик («Да, вечером посмотрю» — о чём речь) и как evidenceMessageId для complete/cancel.
9. Отвечай СТРОГО одним JSON-объектом без пояснений, markdown и комментариев:
{"actions": [{"type": "create", "taskId": null, "title": string, "description": string|null, "status": "open|needs_review", "dueAt": string|null, "dueText": string|null, "evidenceMessageId": "m34"|null, "confidence": 0..1}, {"type": "complete|cancel", "taskId": "t12", "title": string, "description": string|null, "evidenceMessageId": "m34"|null, "confidence": 0..1}]}
Пустой результат: {"actions": []}. (status только для create; по умолчанию "open").`;

function formatMessage(
  m: ConversationInput['messages'][number],
  timezone: string,
): string {
  // Автор всегда подписан именем (шаг 4.4): в группах реплики разных людей
  // различимы, а не «СОБЕСЕДНИК» для всех.
  const who =
    m.direction === 'outgoing' ? `ВРАЧ${m.senderName ? ` (${m.senderName})` : ''}` : (m.senderName ?? 'Собеседник');
  const time = formatLocal(m.timestamp, timezone);
  const body = messageBody(m);
  const hasTask = m.existingTaskId ? ` [уже есть задача #${m.existingTaskId}]` : '';
  const ctxMark = m.isContext ? ' [контекст, уже разобрано]' : '';
  return `[${msgKey(m.id)}] [${time}] ${who}: ${body}${hasTask}${ctxMark}`;
}

/** Текст или честный плейсхолдер типа (шаг 4.5: голосовые — с длительностью). */
function messageBody(m: ConversationInput['messages'][number]): string {
  if (m.text && m.text.length > 0) return m.text;
  // Шаг 10: распознанное голосовое идёт в контекст как обычный текст с пометкой
  if (m.messageType === 'voice' && m.transcript && m.transcript.length > 0) {
    return `[голосовое: ${m.transcript}]`;
  }
  if (m.messageType === 'voice') {
    return m.durationSec !== null && m.durationSec !== undefined
      ? `[голосовое сообщение, ${m.durationSec} сек]`
      : '[голосовое сообщение]';
  }
  return `[${m.messageType}, без текста]`;
}

/** Строит user-часть промпта из контекста переписки одного чата. */
export function buildUserPrompt(input: ConversationInput, timezone: string): string {
  const lines = input.messages.map((m) => formatMessage(m, timezone));
  const known =
    input.existingTasks.length > 0
      ? input.existingTasks
          .map((t) => `- [${taskKey(t.id)}] "${t.title}" (${t.status})`)
          .join('\n')
      : '(нет известных открытых задач)';
  const closed = (input.recentlyClosed ?? [])
    .map((t) => `- [${taskKey(t.id)}] "${t.title}" (${t.status})`)
    .join('\n');
  const closedBlock =
    closed.length > 0
      ? ['Уже обработанные задачи (закрыты, НЕ создавай заново, ссылайся только для complete/cancel):', closed, '']
      : [];
  return [
    `Текущее время: ${formatLocal(input.analyzedAt, timezone)}`,
    `Чат: ${input.chatJid}${input.contactName ? ` (${input.contactName})` : ''}`,
    '',
    'Известные открытые задачи этого чата (ссылайся taskId вида "t12"):',
    known,
    '',
    ...closedBlock,
    'Переписка (по порядку, у каждого сообщения ключ вида [m34]):',
    ...lines,
    '',
    'Верни JSON.',
  ].join('\n');
}

/** Полный промпт для chat-style провайдеров. */
export function buildPrompt(input: ConversationInput, timezone: string): { system: string; user: string } {
  return { system: SYSTEM_PROMPT, user: buildUserPrompt(input, timezone) };
}
