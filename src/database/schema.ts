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
  },
  (t) => [
    uniqueIndex('messages_wamid_chat_uidx').on(t.whatsappMessageId, t.chatJid),
    index('messages_chat_idx').on(t.chatJid),
    index('messages_timestamp_idx').on(t.timestamp),
  ],
);

export type ContactRow = typeof contacts.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

export const TASK_STATUSES = ['pending', 'completed', 'cancelled', 'uncertain'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * tasks — обязательства врача, извлечённые AI из контекста переписки.
 * Одна строка = одно обязательство. Повторный анализ той же переписки
 * обновляет строку (reconcile по chat_jid + нормализованному title),
 * а не плодит дубли.
 *
 * model / prompt_version — provenance каждого AI-решения (какая модель,
 * какой версией промпта получен результат). confidence — уверенность 0..1.
 * deadline — конкретный срок в ms epoch или NULL, если срока нет;
 * deadline_text — исходная фраза («сегодня вечером») для вечерней выжимки.
 */
export const tasks = sqliteTable(
  'tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatJid: text('chat_jid').notNull(),
    contactId: integer('contact_id'),
    title: text('title').notNull(),
    description: text('description'),
    sourceMessageId: text('source_message_id'),
    /** срок в ms epoch; NULL = срок не назван */
    deadline: integer('deadline'),
    /** исходная формулировка срока из переписки */
    deadlineText: text('deadline_text'),
    /** pending | completed | cancelled | uncertain */
    status: text('status').notNull().default('pending'),
    /** уверенность AI, 0..1 */
    confidence: real('confidence'),
    /** какая модель приняла решение (ollama-модель, heuristic-ru-v1, ...) */
    model: text('model'),
    /** версия промпта, см. src/ai/prompts.ts */
    promptVersion: text('prompt_version'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => [
    index('tasks_chat_idx').on(t.chatJid),
    index('tasks_status_idx').on(t.status),
  ],
);

export type TaskRow = typeof tasks.$inferSelect;
