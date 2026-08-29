ALTER TABLE `attachments` ADD `sha256` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `file_size` integer;--> statement-breakpoint
CREATE INDEX `attachments_target_idx` ON `attachments` (`target_type`,`target_id`);