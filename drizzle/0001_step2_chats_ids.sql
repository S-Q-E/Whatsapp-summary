CREATE TABLE `chats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jid` text NOT NULL,
	`display_name` text,
	`is_group` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chats_jid_unique` ON `chats` (`jid`);
--> statement-breakpoint
INSERT INTO `chats` (`jid`, `display_name`, `is_group`, `created_at`)
SELECT
	m.`chat_jid`,
	(SELECT COALESCE(c.`push_name`, c.`name`) FROM `contacts` c WHERE c.`jid` = m.`chat_jid`),
	CASE WHEN m.`chat_jid` LIKE '%@g.us' THEN 1 ELSE 0 END,
	COALESCE((SELECT MIN(m2.`timestamp`) FROM `messages` m2 WHERE m2.`chat_jid` = m.`chat_jid`), 0)
FROM `messages` m GROUP BY m.`chat_jid`;
--> statement-breakpoint
INSERT INTO `chats` (`jid`, `display_name`, `is_group`, `created_at`)
SELECT DISTINCT t.`chat_jid`, NULL,
	CASE WHEN t.`chat_jid` LIKE '%@g.us' THEN 1 ELSE 0 END, t.`created_at`
FROM `tasks` t WHERE NOT EXISTS (SELECT 1 FROM `chats` h WHERE h.`jid` = t.`chat_jid`);
--> statement-breakpoint
ALTER TABLE `messages` ADD `chat_id` integer;
--> statement-breakpoint
ALTER TABLE `messages` ADD `processed_at` integer;
--> statement-breakpoint
ALTER TABLE `messages` ADD `edited_at` integer;
--> statement-breakpoint
ALTER TABLE `messages` ADD `deleted_at` integer;
--> statement-breakpoint
UPDATE `messages` SET `chat_id` = (SELECT `id` FROM `chats` WHERE `chats`.`jid` = `messages`.`chat_jid`);
--> statement-breakpoint
CREATE TABLE `tasks_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL REFERENCES `chats`(`id`),
	`title` text NOT NULL,
	`description` text,
	`contact_id` integer,
	`chat_jid` text NOT NULL,
	`source_message_id` integer REFERENCES `messages`(`id`),
	`closed_by_message_id` integer REFERENCES `messages`(`id`),
	`status` text DEFAULT 'open' NOT NULL,
	`due_at` integer,
	`due_text` text,
	`confidence` real,
	`model` text,
	`prompt_version` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
INSERT INTO `tasks_new` (`id`, `chat_id`, `title`, `description`, `contact_id`, `chat_jid`, `source_message_id`, `closed_by_message_id`, `status`, `due_at`, `due_text`, `confidence`, `model`, `prompt_version`, `created_at`, `updated_at`, `closed_at`)
SELECT
	t.`id`,
	(SELECT h.`id` FROM `chats` h WHERE h.`jid` = t.`chat_jid`),
	t.`title`, t.`description`, t.`contact_id`, t.`chat_jid`,
	(SELECT m.`id` FROM `messages` m WHERE m.`whatsapp_message_id` = t.`source_message_id` AND m.`chat_jid` = t.`chat_jid`),
	NULL,
	CASE t.`status` WHEN 'pending' THEN 'open' WHEN 'completed' THEN 'done' WHEN 'uncertain' THEN 'needs_review' ELSE 'cancelled' END,
	t.`deadline`, t.`deadline_text`, t.`confidence`, t.`model`, t.`prompt_version`, t.`created_at`, t.`updated_at`, t.`completed_at`
FROM `tasks` t;
--> statement-breakpoint
DROP TABLE `tasks`;
--> statement-breakpoint
ALTER TABLE `tasks_new` RENAME TO `tasks`;
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_source_uidx` ON `tasks` (`source_message_id`);
--> statement-breakpoint
CREATE INDEX `tasks_chat_idx` ON `tasks` (`chat_id`);
--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);
