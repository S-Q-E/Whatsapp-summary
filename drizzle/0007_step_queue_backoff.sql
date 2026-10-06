CREATE TABLE `chat_analysis_state` (
	`chat_id` integer PRIMARY KEY NOT NULL,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `title_hash` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_source_title_uidx` ON `tasks` (`source_message_id`,`title_hash`);
--> statement-breakpoint
DROP INDEX `tasks_source_uidx`;
