/**
 * Eval-набор шага 8: 25+ синтетических диалогов для измерения качества
 * извлечения ( НЕ для seed:demo — там свои 6 фикстур).
 * Все имена вымышлены, ПДн нет, стиль разговорный, местами опечатки.
 *
 * Каждый кейс: сообщения + ожидаемые actions.
 * - creates: индексы сообщений, из которых должен получиться create
 *   (повторы индекса = несколько обещаний в одном сообщении);
 * - completes/cancels: индексы сообщений-отчётов, закрывающих known open task;
 * - needsReview: подмножество creates, ожидаемых со статусом needs_review;
 * - dueDated: подмножество creates, где должен быть заполнен dueAt;
 * - knownGap: кейс вне метрик (контракт не умеет; честно показываем отдельно).
 */
export type EvalMsg = {
  from: 'patient' | 'doctor' | 'other';
  name?: string;
  text: string | null;
  messageType?: string;
  /** смещение дня от analyzedAt (0 = тот же день, -1 = вчера, +7 = через неделю) */
  dayOffset?: number;
  hour: number;
  minute: number;
};

export type EvalExpect = {
  creates: number[];
  completes: number[];
  cancels: number[];
  needsReview?: number[];
  dueDated?: number[];
  knownGap?: string;
};

export type EvalCase = {
  id: string;
  kind: 'direct' | 'group';
  description: string;
  /** известная открытая задача в контексте (id 41 в input) */
  openTask?: { title: string };
  messages: EvalMsg[];
  expect: EvalExpect;
};

export const EVAL_CASES: EvalCase[] = [
  {
    id: 'promise-basic',
    kind: 'direct',
    description: 'Просьба посмотреть анализы + обещание вечером',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Доктор, гляньте пожалуйста мои анализы, там что-то с гемоглобином', hour: 9, minute: 12 },
      { from: 'doctor', text: 'Да, посмотрю вечером и напишу вам', hour: 9, minute: 40 },
    ],
    expect: { creates: [1], completes: [], cancels: [] },
  },
  {
    id: 'fulfill-report',
    kind: 'direct',
    description: 'Отчёт о выполнении закрывает известную задачу',
    openTask: { title: 'Посмотреть анализы' },
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Доктор, вы посмотрели?', hour: 14, minute: 0 },
      { from: 'doctor', text: 'Да, посмотрела ваши анализы, всё в норме', hour: 14, minute: 30 },
    ],
    expect: { creates: [], completes: [1], cancels: [] },
  },
  {
    id: 'repeat-week',
    kind: 'direct',
    description: 'То же обещание через неделю — новая задача, не закрытие',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Доктор, а анализы новые пришли, посмотрите?', hour: 9, minute: 5, dayOffset: 7 },
      { from: 'doctor', text: 'Конечно, посмотрю сегодня вечером', hour: 9, minute: 20, dayOffset: 7 },
    ],
    expect: { creates: [1], completes: [], cancels: [] },
  },
  {
    id: 'two-in-one',
    kind: 'direct',
    description: 'Два обещания в одном сообщении',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'А анализы гляните и рецепт выпишите?', hour: 10, minute: 0 },
      { from: 'doctor', text: 'Анализы посмотрю вечером, а рецепт отправлю завтра утром', hour: 10, minute: 15 },
    ],
    expect: { creates: [1, 1], completes: [], cancels: [], dueDated: [1] },
  },
  {
    id: 'ask-boss',
    kind: 'direct',
    description: '«Спрошу у заведующей» — обязательство уточнить',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'А можно направление в областной центр?', hour: 11, minute: 0 },
      { from: 'doctor', text: 'Спрошу у заведующей завтра и вам напишу', hour: 11, minute: 30 },
    ],
    expect: { creates: [1], completes: [], cancels: [] },
  },
  {
    id: 'ignored-request',
    kind: 'direct',
    description: 'Пациент просит, врач не отвечает по существу',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Отправьте пожалуйста результаты!', hour: 12, minute: 0 },
      { from: 'doctor', text: 'Добрый день! Приём завтра с 9 до 13', hour: 12, minute: 5 },
    ],
    expect: { creates: [], completes: [], cancels: [] },
  },
  {
    id: 'cancel',
    kind: 'direct',
    description: 'Врач отменяет обещанное',
    openTask: { title: 'Перезвонить пациенту' },
    messages: [
      { from: 'doctor', text: 'Извините, сегодня позвонить не смогу, давайте перенесём на четверг', hour: 15, minute: 0 },
    ],
    expect: { creates: [], completes: [], cancels: [0] },
  },
  {
    id: 'reschedule',
    kind: 'direct',
    description: 'Перенос срока (контракт не умеет менять due — честный гэп)',
    openTask: { title: 'Отправить результаты' },
    messages: [
      { from: 'patient', name: 'Пациент', text: 'А можно не сегодня, а в пятницу?', hour: 10, minute: 0 },
      { from: 'doctor', text: 'Хорошо, отправлю в пятницу утром', hour: 10, minute: 10 },
    ],
    expect: { creates: [], completes: [], cancels: [], knownGap: 'нет action для смены срока' },
  },
  {
    id: 'thanks-noise',
    kind: 'direct',
    description: 'Шум: спасибо / ок / понял',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Спасибо большое!', hour: 11, minute: 0 },
      { from: 'doctor', text: 'Пожалуйста! Будьте здоровы', hour: 11, minute: 2 },
      { from: 'patient', name: 'Пациент', text: 'Ок, понял', hour: 11, minute: 3 },
    ],
    expect: { creates: [], completes: [], cancels: [] },
  },
  {
    id: 'group-multi',
    kind: 'group',
    description: 'Группа: два автора, обещает врач',
    messages: [
      { from: 'other', name: 'Коллега', text: 'Девочки, кто дежурит в субботу?', hour: 13, minute: 0 },
      { from: 'other', name: 'Медсестра', text: 'Я не могу, у меня смена в поликлинике', hour: 13, minute: 5 },
      { from: 'doctor', text: 'Я уточню график у старшей и напишу сюда', hour: 13, minute: 20 },
    ],
    expect: { creates: [2], completes: [], cancels: [] },
  },
  {
    id: 'prev-day-promise',
    kind: 'direct',
    description: 'Обещание вчера, выполнение сегодня',
    openTask: { title: 'Отправить направление' },
    messages: [
      { from: 'doctor', text: 'Направление отправлю завтра утром', hour: 18, minute: 0, dayOffset: -1 },
      { from: 'patient', name: 'Пациент', text: 'Доброе утро! Направили?', hour: 8, minute: 30 },
      { from: 'doctor', text: 'Да, уже отправила, проверяйте почту', hour: 8, minute: 45 },
    ],
    expect: { creates: [], completes: [2], cancels: [] },
  },
  {
    id: 'ambiguous',
    kind: 'direct',
    description: 'Неоднозначное «может гляну» — needs_review, не игнор и не уверенная задача',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'А давление моё гляните?', hour: 9, minute: 0 },
      { from: 'doctor', text: 'Может гляну вечером, если время будет', hour: 9, minute: 10 },
    ],
    expect: { creates: [1], completes: [], cancels: [], needsReview: [1] },
  },
  {
    id: 'question-fact',
    kind: 'direct',
    description: 'Вопрос + фактический ответ — не задача',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Вы сегодня принимаете?', hour: 12, minute: 15 },
      { from: 'doctor', text: 'Да, принимаю с 9 до 13', hour: 12, minute: 18 },
    ],
    expect: { creates: [], completes: [], cancels: [] },
  },
  {
    id: 'typo-heavy',
    kind: 'direct',
    description: 'Опечатки: «пасматрю анализы вечиром»',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Когда анализы пасмотрите?', hour: 10, minute: 0 },
      { from: 'doctor', text: 'Пасматрю анализы вечиром и напишу', hour: 10, minute: 5 },
    ],
    expect: { creates: [1], completes: [], cancels: [] },
  },
  {
    id: 'no-confirmation',
    kind: 'direct',
    description: 'Двойная просьба, врач отвечает смайликом — подтверждения нет',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Позвоните мне пожалуйста!', hour: 16, minute: 0 },
      { from: 'patient', name: 'Пациент', text: 'Очень жду звонка', hour: 18, minute: 0 },
      { from: 'doctor', text: '👍', hour: 18, minute: 5 },
    ],
    expect: { creates: [], completes: [], cancels: [] },
  },
  {
    id: 'call-promise-done',
    kind: 'direct',
    description: 'Обещание позвонить и отчёт в одном контексте',
    openTask: { title: 'Перезвонить пациенту' },
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Не дозвонилась до регистратуры', hour: 9, minute: 0 },
      { from: 'doctor', text: 'Я сама вам перезвоню после обеда', hour: 9, minute: 10 },
      { from: 'patient', name: 'Пациент', text: 'Спасибо, жду!', hour: 9, minute: 11 },
      { from: 'doctor', text: 'Позвонила, всё решили, приходите в четверг', hour: 15, minute: 0 },
    ],
    expect: { creates: [1], completes: [3], cancels: [] },
  },
  {
    id: 'document-send',
    kind: 'direct',
    description: '«Скину завтра» с явным сроком',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Скиньте пожалуйста выписку', hour: 17, minute: 0 },
      { from: 'doctor', text: 'Скину завтра до обеда', hour: 17, minute: 10 },
    ],
    expect: { creates: [1], completes: [], cancels: [], dueDated: [1] },
  },
  {
    id: 'vague-no-action',
    kind: 'direct',
    description: '«Приходите на приём» — не обязательство врача',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'А что делать с давлением, оно скачет', hour: 10, minute: 0 },
      { from: 'doctor', text: 'Приходите на приём в четверг, разберёмся', hour: 10, minute: 20 },
    ],
    expect: { creates: [], completes: [], cancels: [] },
  },
  {
    id: 'reminder',
    kind: 'direct',
    description: '«Напомню накануне» — обязательство напомнить',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Напомните мне про приём пожалуйста, я забываю', hour: 12, minute: 0 },
      { from: 'doctor', text: 'Хорошо, напомню вам накануне вечером', hour: 12, minute: 5 },
    ],
    expect: { creates: [1], completes: [], cancels: [] },
  },
  {
    id: 'prescription',
    kind: 'direct',
    description: '«Выпишу сегодня» — обязательство выписать рецепт',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Выпишите мне рецепт на давление?', hour: 9, minute: 30 },
      { from: 'doctor', text: 'Выпишу сегодня, заберёте в регистратуре', hour: 9, minute: 35 },
    ],
    expect: { creates: [1], completes: [], cancels: [] },
  },
  {
    id: 'group-noise',
    kind: 'group',
    description: 'Групповой шум без просьб к врачу',
    messages: [
      { from: 'other', name: 'Коллега', text: 'Всех с праздником!', hour: 9, minute: 0 },
      { from: 'other', name: 'Медсестра', text: 'Спасибо! 🎉', hour: 9, minute: 2 },
      { from: 'doctor', text: 'И вас с праздником!', hour: 9, minute: 5 },
    ],
    expect: { creates: [], completes: [], cancels: [] },
  },
  {
    id: 'schedule-confirm',
    kind: 'direct',
    description: '«Уточню расписание» — обязательство + подтверждение записи',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Можно записаться к вам на понедельник?', hour: 14, minute: 0 },
      { from: 'doctor', text: 'Да, сейчас уточню расписание и подтвержу запись', hour: 14, minute: 10 },
    ],
    expect: { creates: [1], completes: [], cancels: [] },
  },
  {
    id: 'wrong-task-report',
    kind: 'direct',
    description: 'Отчёт не про известную задачу — выдумывать id нельзя',
    openTask: { title: 'Перезвонить пациенту' },
    messages: [
      { from: 'doctor', text: 'Анализы ваши посмотрела, всё хорошо', hour: 10, minute: 0 },
    ],
    expect: { creates: [], completes: [], cancels: [] },
  },
  {
    id: 'explicit-date',
    kind: 'direct',
    description: '«К понедельнику» — срок датой',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Когда будет готово заключение?', hour: 9, minute: 0 },
      { from: 'doctor', text: 'Подготовлю заключение к понедельнику', hour: 9, minute: 10 },
    ],
    expect: { creates: [1], completes: [], cancels: [], dueDated: [1] },
  },
  {
    id: 'voice-note',
    kind: 'direct',
    description: 'Голосовое без текста — содержание неизвестно, задач нет',
    messages: [
      { from: 'patient', name: 'Пациент', text: null, messageType: 'audio', hour: 10, minute: 0 },
      { from: 'doctor', text: 'Прослушаю чуть позже', hour: 10, minute: 30 },
    ],
    expect: { creates: [], completes: [], cancels: [] },
  },
  {
    id: 'thanks-after-task',
    kind: 'direct',
    description: 'Спасибо при открытой задаче — не закрытие',
    openTask: { title: 'Посмотреть анализы' },
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Спасибо вам большое!', hour: 18, minute: 0 },
    ],
    expect: { creates: [], completes: [], cancels: [] },
  },
  {
    id: 'short-ok-doctor',
    kind: 'direct',
    description: 'Короткое «ок» врача без обязательства',
    messages: [
      { from: 'patient', name: 'Пациент', text: 'Я тогда в четверг подойду', hour: 11, minute: 0 },
      { from: 'doctor', text: 'Ок', hour: 11, minute: 1 },
    ],
    expect: { creates: [], completes: [], cancels: [] },
  },
];
