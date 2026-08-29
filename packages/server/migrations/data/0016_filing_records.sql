CREATE TABLE `filing_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fiscal_year_id` integer NOT NULL,
	`tax_kind` text NOT NULL,
	`method` text NOT NULL,
	`submitted_on` text NOT NULL,
	`receipt_number` text,
	`memo` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`fiscal_year_id`) REFERENCES `fiscal_years`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `filing_records_fy_idx` ON `filing_records` (`fiscal_year_id`);