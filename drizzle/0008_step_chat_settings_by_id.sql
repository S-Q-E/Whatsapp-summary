CREATE TABLE `chat_settings_new` (
	`chat_id` integer PRIMARY KEY NOT NULL,
	`ignored` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `chat_settings_new` (`chat_id`, `ignored`, `updated_at`)
	SELECT c.`id`, s.`ignored`, s.`updated_at`
	FROM `chat_settings` s JOIN `chats` c ON c.`jid` = s.`chat_jid`;
--> statement-breakpoint
DROP TABLE `chat_settings`;
--> statement-breakpoint
ALTER TABLE `chat_settings_new` RENAME TO `chat_settings`;
