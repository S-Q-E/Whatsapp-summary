/**
 * Синтетические тестовые переписки. Все имена/номера вымышлены,
 * персональные данные отсутствуют. Используются для:
 * - `npm run seed:demo` (прогон `npm run analyze` без реальных данных);
 * - automated tests (см. tests/).
 */
export type FixtureMessage = {
  direction: 'incoming' | 'outgoing';
  senderName: string | null;
  text: string | null;
  messageType: string;
  /** смещение от начала дня в минутах — seed-скрипт пересчитает на сегодня */
  minuteOffset: number;
};

export type Fixture = {
  id: string;
  chatJid: string;
  contactPushName: string;
  description: string;
  /** ожидаемый итог эвристики/анализа: сколько задач и с каким статусом */
  expectTasks: number;
  expectStatuses: string[];
  messages: FixtureMessage[];
};

const T = (h: number, m: number): number => h * 60 + m;

export const FIXTURES: Fixture[] = [
  {
    id: 'analyses-evening',
    chatJid: 'patient-demo-1@s.whatsapp.net',
    contactPushName: 'Пациент А',
    description: 'Просьба посмотреть анализы + обещание врача вечером => 1 pending',
    expectTasks: 1,
    expectStatuses: ['pending'],
    messages: [
      { direction: 'incoming', senderName: 'Пациент А', text: 'Добрый день! Посмотрите, пожалуйста, мои анализы?', messageType: 'text', minuteOffset: T(9, 12) },
      { direction: 'outgoing', senderName: null, text: 'Да, конечно. Посмотрю вечером и напишу вам.', messageType: 'text', minuteOffset: T(9, 40) },
    ],
  },
  {
    id: 'send-results',
    chatJid: 'patient-demo-2@s.whatsapp.net',
    contactPushName: 'Пациент Б',
    description: 'Просьба отправить результаты + согласие врача => 1 pending с дедлайном',
    expectTasks: 1,
    expectStatuses: ['pending'],
    messages: [
      { direction: 'incoming', senderName: 'Пациент Б', text: 'Можете завтра отправить мне результаты?', messageType: 'text', minuteOffset: T(10, 5) },
      { direction: 'outgoing', senderName: null, text: 'Да, отправлю завтра утром.', messageType: 'text', minuteOffset: T(10, 20) },
    ],
  },
  {
    id: 'thanks-only',
    chatJid: 'patient-demo-3@s.whatsapp.net',
    contactPushName: 'Пациент В',
    description: 'Благодарность + вежливый ответ => 0 задач',
    expectTasks: 0,
    expectStatuses: [],
    messages: [
      { direction: 'incoming', senderName: 'Пациент В', text: 'Спасибо большое!', messageType: 'text', minuteOffset: T(11, 0) },
      { direction: 'outgoing', senderName: null, text: 'Пожалуйста! Будьте здоровы.', messageType: 'text', minuteOffset: T(11, 2) },
    ],
  },
  {
    id: 'reception-question',
    chatJid: 'patient-demo-4@s.whatsapp.net',
    contactPushName: 'Пациент Г',
    description: 'Вопрос про приём + фактический ответ => 0 задач',
    expectTasks: 0,
    expectStatuses: [],
    messages: [
      { direction: 'incoming', senderName: 'Пациент Г', text: 'Вы сегодня принимаете?', messageType: 'text', minuteOffset: T(12, 15) },
      { direction: 'outgoing', senderName: null, text: 'Да, принимаю с 9 до 13.', messageType: 'text', minuteOffset: T(12, 18) },
    ],
  },
  {
    id: 'completion-report',
    chatJid: 'patient-demo-5@s.whatsapp.net',
    contactPushName: 'Пациент Д',
    description: 'Врач сообщает о выполнении ранее обещанного => update в completed',
    expectTasks: 1,
    expectStatuses: ['completed'],
    messages: [
      { direction: 'incoming', senderName: 'Пациент Д', text: 'Доктор, посмотрели мои анализы?', messageType: 'text', minuteOffset: T(14, 0) },
      { direction: 'outgoing', senderName: null, text: 'Да, посмотрела ваши анализы, всё в норме.', messageType: 'text', minuteOffset: T(14, 30) },
    ],
  },
  {
    id: 'group-colleague',
    chatJid: '123456-789@g.us',
    contactPushName: 'Рабочий чат',
    description: 'Обещание коллеги по работе в группе => 1 pending',
    expectTasks: 1,
    expectStatuses: ['pending'],
    messages: [
      { direction: 'incoming', senderName: 'Коллега', text: 'Кто-нибудь может уточнить расписание дежурств?', messageType: 'text', minuteOffset: T(15, 10) },
      { direction: 'outgoing', senderName: null, text: 'Я уточню у заведующей и напишу сюда.', messageType: 'text', minuteOffset: T(15, 25) },
    ],
  },
];
