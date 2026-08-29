CREATE TABLE `tax_return_inputs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fiscal_year_id` integer NOT NULL,
	`basic_deduction` integer DEFAULT 480000 NOT NULL,
	`social_insurance` integer DEFAULT 0 NOT NULL,
	`life_insurance` integer DEFAULT 0 NOT NULL,
	`medical` integer DEFAULT 0 NOT NULL,
	`spouse_dependents` integer DEFAULT 0 NOT NULL,
	`other_deductions` integer DEFAULT 0 NOT NULL,
	`estimated_prepaid` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`fiscal_year_id`) REFERENCES `fiscal_years`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_return_inputs_fy_uq` ON `tax_return_inputs` (`fiscal_year_id`);