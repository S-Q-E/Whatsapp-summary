CREATE TABLE `chat_settings` (
	`chat_jid` text PRIMARY KEY NOT NULL,
	`ignored` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
