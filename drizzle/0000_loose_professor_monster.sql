CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jid` text NOT NULL,
	`phone` text,
	`name` text,
	`push_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_jid_unique` ON `contacts` (`jid`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`whatsapp_message_id` text NOT NULL,
	`chat_jid` text NOT NULL,
	`sender_jid` text,
	`sender_name` text,
	`direction` text NOT NULL,
	`message_type` text NOT NULL,
	`text` text,
	`timestamp` integer NOT NULL,
	`is_from_me` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_wamid_chat_uidx` ON `messages` (`whatsapp_message_id`,`chat_jid`);--> statement-breakpoint
CREATE INDEX `messages_chat_idx` ON `messages` (`chat_jid`);--> statement-breakpoint
CREATE INDEX `messages_timestamp_idx` ON `messages` (`timestamp`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_jid` text NOT NULL,
	`contact_id` integer,
	`title` text NOT NULL,
	`description` text,
	`source_message_id` text,
	`deadline` integer,
	`deadline_text` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`confidence` real,
	`model` text,
	`prompt_version` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `tasks_chat_idx` ON `tasks` (`chat_jid`);--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);