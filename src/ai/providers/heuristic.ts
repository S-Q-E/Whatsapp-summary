import type {
  AIProvider,
  AnalyzeOutput,
  ConversationInput,
  ExtractedTask,
} from '../types.js';

/**
 * Детерминированный rule-based провайдер (русский язык).
 * НЕ искусственный интеллект: ищет явные глаголы обещания врача
 * в исходящих сообщениях и фразы отчёта о выполнении.
 * Назначение — офлайн-демо и fallback, когда Ollama недоступна.
 * Честно помечает результаты model='heuristic-ru-v1' и умеренной
 * confidence, чтобы их было видно в БД и не путать с LLM.
 */
export class HeuristicProvider implements AIProvider {
  readonly name = 'heuristic';
  readonly model = 'heuristic-ru-v1';
  readonly promptVersion = 'n/a-heuristic';

  async analyzeConversation(input: ConversationInput): Promise<AnalyzeOutput> {
    const tasks: ExtractedTask[] = [];
    const seen = new Set<string>(); // не дублировать одно обещание дважды

    for (const m of input.messages) {
      if (m.direction !== 'outgoing' || !m.text) continue;
      const text = m.text.toLowerCase();

      const completion = matchCompletion(text);
      if (completion) {
        // Закрытие — только по id из известных задач (свои названия детерминированы,
        // поэтому точное совпадение надёжно). Нет известной — молчим, не выдумываем.
        const known = input.existingTasks.find((t) => t.title === completion);
        const key = `done:${completion}`;
        if (known && !seen.has(key)) {
          seen.add(key);
          tasks.push({
            action: 'complete',
            taskId: known.id,
            title: completion,
            description: `Врач сообщил о выполнении: «${truncate(m.text)}»`,
            status: 'done',
            dueAt: null,
            dueText: null,
            confidence: 0.65,
            messageId: m.id,
          });
        }
        continue;
      }

      const promise = matchPromise(text);
      if (promise) {
        const key = `new:${promise.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tasks.push({
          action: 'create',
          taskId: null,
          title: promise.title,
          description: `Обещание врача: «${truncate(m.text)}»`,
          status: 'open',
          dueAt: null,
          dueText: extractDeadlineText(text),
          confidence: 0.6,
          messageId: m.id,
        });
      }
    }
    return { tasks };
  }
}

type PromiseHit = { title: string };

/** глагол обещания -> тема обязательства.
 * G (guard) требует, чтобы после формы 1-го лица не шла буква:
 * иначе инфинитив «скинуть» ложно мачтчит «скину». */
const G = '(?![а-яёa-z])';
const PROMISE_PATTERNS: Array<{ re: RegExp; topic: string }> = [
  { re: new RegExp(`посмотрю${G}|гляну${G}`, 'i'), topic: 'анализы' },
  { re: new RegExp(`отправлю${G}|скину${G}|передам${G}|пришлю${G}|вышлю${G}`, 'i'), topic: 'результаты' },
  { re: new RegExp(`позвоню${G}|наберу${G}|перезвоню${G}`, 'i'), topic: 'звонок' },
  { re: new RegExp(`напишу${G}|отпишу${G}|сообщу${G}`, 'i'), topic: 'сообщение' },
  { re: new RegExp(`уточню${G}|узнаю${G}|выясню${G}`, 'i'), topic: 'уточнение' },
  { re: new RegExp(`проверю${G}`, 'i'), topic: 'проверка' },
  { re: new RegExp(`подготовлю${G}`, 'i'), topic: 'подготовка' },
  { re: new RegExp(`напомню${G}`, 'i'), topic: 'напоминание' },
  { re: new RegExp(`запишу${G}`, 'i'), topic: 'запись' },
];

const TOPIC_TITLES: Record<string, string> = {
  'анализы': 'Посмотреть анализы',
  'результаты': 'Отправить результаты',
  'звонок': 'Перезвонить',
  'сообщение': 'Написать сообщение',
  'уточнение': 'Уточнить информацию',
  'проверка': 'Проверить',
  'подготовка': 'Подготовить документы',
  'напоминание': 'Напомнить о приёме',
  'запись': 'Записать на приём',
};

function matchPromise(text: string): PromiseHit | null {
  // Вопрос без обещания ("Да, принимаю с 9 до 13") — не задача.
  for (const p of PROMISE_PATTERNS) {
    if (p.re.test(text)) return { title: TOPIC_TITLES[p.topic] ?? 'Выполнить обещание' };
  }
  return null;
}

/** фраза отчёта -> название задачи, которую она закрывает */
const COMPLETION_PATTERNS: Array<{ re: RegExp; title: string }> = [
  { re: /посмотрела|посмотрел/i, title: 'Посмотреть анализы' },
  { re: /отправила|отправил|отправлено/i, title: 'Отправить результаты' },
  { re: /позвонила|позвонил/i, title: 'Перезвонить' },
  { re: /написала|написал/i, title: 'Написать сообщение' },
  { re: /уточнила|уточнил/i, title: 'Уточнить информацию' },
  { re: /вс[её] (норма|в норме|хорошо|в порядке)|вс[её] нормально/i, title: 'Посмотреть анализы' },
];

function matchCompletion(text: string): string | null {
  for (const p of COMPLETION_PATTERNS) {
    if (p.re.test(text)) return p.title;
  }
  return null;
}

function extractDeadlineText(text: string): string | null {
  if (/сегодня вечером|вечером/i.test(text)) return 'сегодня вечером';
  if (/завтра утром/i.test(text)) return 'завтра утром';
  if (/завтра/i.test(text)) return 'завтра';
  if (/сегодня/i.test(text)) return 'сегодня';
  if (/утром/i.test(text)) return 'утром';
  return null;
}

function truncate(s: string, max = 160): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
