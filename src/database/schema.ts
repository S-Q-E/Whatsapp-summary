import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * contacts — one row per chat participant / chat.
 * jid is stored normalized (see utils/jid.ts).
 */
export const contacts = sqliteTable('contacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jid: text('jid').notNull().unique(),
  phone: text('phone'),
  name: text('name'),
  pushName: text('push_name'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * messages — every WhatsApp message exactly once.
 * Deduplication: UNIQUE(whatsapp_message_id, chat_jid).
 */
export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    whatsappMessageId: text('whatsapp_message_id').notNull(),
    chatJid: text('chat_jid').notNull(),
    senderJid: text('sender_jid'),
    senderName: text('sender_name'),
    /** incoming | outgoing */
    direction: text('direction').notNull(),
    /** conversation | extended_text | image | video | audio | document | sticker | location | contact | poll | reaction | ... */
    messageType: text('message_type').notNull(),
    /** plain text / caption, null for non-text payloads */
    text: text('text'),
    /** original WhatsApp timestamp, ms since epoch */
    timestamp: integer('timestamp').notNull(),
    isFromMe: integer('is_from_me', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    /** FK -> chats.id (заполняется при ingest, шаг 2) */
    chatId: integer('chat_id'),
    /** инкрементальность анализа; правки/удаления сообщений */
    processedAt: integer('processed_at'),
    editedAt: integer('edited_at'),
    deletedAt: integer('deleted_at'),
    /** длительность медиа в секундах (голосовые/аудио/видео), шаг 4 */
    durationSec: integer('duration_sec'),
    /** транскрипт голосового (шаг 10); NULL = нет или ещё не распознан */
    transcript: text('transcript'),
  },
  (t) => [
    uniqueIndex('messages_wamid_chat_uidx').on(t.whatsappMessageId, t.chatJid),
    index('messages_chat_idx').on(t.chatJid),
    index('messages_timestamp_idx').on(t.timestamp),
  ],
);

export type ContactRow = typeof contacts.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

/**
 * chats — один ряд на диалог (личка или группа).
 * Канонический идентификатор диалогов: tasks/messages ссылаются на chat_id.
 * chat_jid оставлен в messages/tasks как совместимость (денормализация).
 */
export const chats = sqliteTable('chats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jid: text('jid').notNull().unique(),
  displayName: text('display_name'),
  /** 0/1: группа (@g.us) или личка */
  isGroup: integer('is_group').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export type ChatRow = typeof chats.$inferSelect;

/**
 * jid_aliases — соответствие LID ↔ номер телефона (шаг 4, Baileys 7).
 * alias_jid (обычно @lid) -> canonical_jid (обычно @s.whatsapp.net).
 * Чаты ведутся по canonical JID; при позднем обнаружении алиаса
 * чаты сливаются, сообщения и задачи перепривязываются в транзакции.
 */
export const jidAliases = sqliteTable('jid_aliases', {
  aliasJid: text('alias_jid').primaryKey(),
  canonicalJid: text('canonical_jid').notNull(),
  createdAt: integer('created_at').notNull(),
});

export type JidAliasRow = typeof jidAliases.$inferSelect;

/**
 * chat_analysis_state — бэкофф анализа по чату (очередь, п.2):
 * fail_count подряд идущих ошибок, next_attempt_at — когда пробовать снова.
 * Успешный разбор сбрасывает в 0/NULL. fail_count >= 5 — needs_attention.
 */
export const chatAnalysisState = sqliteTable('chat_analysis_state', {
  chatId: integer('chat_id').primaryKey(),
  failCount: integer('fail_count').notNull().default(0),
  nextAttemptAt: integer('next_attempt_at'),
  updatedAt: integer('updated_at').notNull(),
});

export type ChatAnalysisStateRow = typeof chatAnalysisState.$inferSelect;

export const TASK_STATUSES = ['open', 'done', 'cancelled', 'needs_review'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * tasks — обязательства врача, извлечённые AI из контекста переписки.
 * Одна строка = одно обязательство. Идентификация СТРОГО по id:
 * complete/cancel ссылаются на taskId, создание — всегда новая строка.
 * Антидубль — только по source_message_id (UNIQUE, NULL не конфликтуют):
 * одно сообщение-источник = максимум одна задача.
 * Статусы legacy мапятся в миграции: pending->open, completed->done,
 * uncertain->needs_review, cancelled->cancelled.
 *
 * source_message_id / closed_by_message_id — внутренние messages.id
 * (wamid от модели резолвится в id при сверке, scope — свой чат).
 * model / prompt_version / confidence — provenance каждого AI-решения.
 * due_at — конкретный срок в ms epoch или NULL; due_text — исходная фраза.
 */
export const tasks = sqliteTable(
  'tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: integer('chat_id')
      .notNull()
      .references(() => chats.id),
    title: text('title').notNull(),
    description: text('description'),
    contactId: integer('contact_id'),
    /** legacy-зеркало chat_id, оставлено для совместимости чтения */
    chatJid: text('chat_jid').notNull(),
    sourceMessageId: integer('source_message_id').references(() => messages.id),
    /**
     * Нормализованный хеш названия — ТОЛЬКО для антидубля повторного прогона
     * (UNIQUE(source_message_id, title_hash)), никогда для идентификации.
     * NULL у legacy-строк (до шага с хешем) — NULL не конфликтуют.
     */
    titleHash: integer('title_hash'),
    closedByMessageId: integer('closed_by_message_id').references(() => messages.id),
    /** open | done | cancelled | needs_review */
    status: text('status').notNull().default('open'),
    /** срок в ms epoch; NULL = срок не назван */
    dueAt: integer('due_at'),
    /** исходная формулировка срока из переписки */
    dueText: text('due_text'),
    /** уверенность AI, 0..1 */
    confidence: real('confidence'),
    /** какая модель приняла решение (ollama-модель, heuristic-ru-v1, ...) */
    model: text('model'),
    /** версия промпта, см. src/ai/prompts.ts */
    promptVersion: text('prompt_version'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    closedAt: integer('closed_at'),
    /**
     * Ручное редактирование (шаг 6): 1 = задачу правил человек через API.
     * AI такие задачи не перезаписывает (поля title/description/due),
     * но переходы complete/cancel по taskId работают как обычно.
     */
    manual: integer('manual').notNull().default(0),
  },
  (t) => [
    uniqueIndex('tasks_source_title_uidx').on(t.sourceMessageId, t.titleHash),
    index('tasks_chat_idx').on(t.chatId),
    index('tasks_status_idx').on(t.status),
  ],
);

export type TaskRow = typeof tasks.$inferSelect;

/**
 * settings — key/value хранилище серверных настроек
 * (digest_time, timezone, owner_jid, ...). Значения — строки.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type SettingsRow = typeof settings.$inferSelect;

/**
 * chat_settings — настройки по чатам.
 * Ключ — chat_id (миграция 0008 перенесла со jid): флаг переживает
 * слияние чатов. ignored=1: чат исключён из AI-анализа.
 */
export const chatSettings = sqliteTable('chat_settings', {
  chatId: integer('chat_id').primaryKey(),
  ignored: integer('ignored').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

export type ChatSettingsRow = typeof chatSettings.$inferSelect;

/**
 * digests — отправленные (и несеные) дневные дайджесты (шаг 7).
 * Одна строка на дату (YYYY-MM-DD в TIMEZONE): повторная отправка
 * за тот же день невозможна. sent=1 ставится ТОЛЬКО после успешной
 * отправки; рестарт/офлайн оставляют sent=0 — следующий тик повторит.
 */
export const digests = sqliteTable('digests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull().unique(),
  content: text('content').notNull(),
  sent: integer('sent').notNull().default(0),
  sentAt: integer('sent_at'),
  createdAt: integer('created_at').notNull(),
  /** метка активной отправки для сериализации параллельных sendToday; NULL = никто не шлёт */
  sendingAt: integer('sending_at'),
});

export type DigestRow = typeof digests.$inferSelect;
