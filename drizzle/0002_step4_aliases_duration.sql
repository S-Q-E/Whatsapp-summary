CREATE TABLE `jid_aliases` (
	`alias_jid` text PRIMARY KEY NOT NULL,
	`canonical_jid` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `duration_sec` integer;
