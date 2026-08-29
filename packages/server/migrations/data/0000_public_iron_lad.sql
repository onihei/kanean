CREATE TABLE `account_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`report_type` text NOT NULL,
	`section` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`statement_item_id` integer NOT NULL,
	`name` text NOT NULL,
	`default_tax_category_id` integer,
	`search_key` text,
	`normal_balance` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`statement_item_id`) REFERENCES `statement_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_tax_category_id`) REFERENCES `tax_categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_type` text NOT NULL,
	`target_id` integer NOT NULL,
	`file_name` text,
	`storage_path` text,
	`content_type` text,
	`uploaded_at` text
);
--> statement-breakpoint
CREATE TABLE `auto_journal_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`match_field` text NOT NULL,
	`match_op` text NOT NULL,
	`match_value` text NOT NULL,
	`direction` text DEFAULT 'any' NOT NULL,
	`result_account_id` integer,
	`result_sub_account_id` integer,
	`result_tax_category_id` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`result_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_sub_account_id`) REFERENCES `sub_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_tax_category_id`) REFERENCES `tax_categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `business_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`business_name` text,
	`owner_name` text,
	`phone` text,
	`entity_type` text DEFAULT 'individual' NOT NULL,
	`filing_type` text DEFAULT 'blue' NOT NULL,
	`filing_form` text,
	`industry` text,
	`prefecture` text,
	`ebook_storage` integer DEFAULT false NOT NULL,
	`tax_method` text DEFAULT 'simplified' NOT NULL,
	`tax_business_category` text,
	`accounting_method` text DEFAULT 'tax_included' NOT NULL,
	`rounding_sales` text DEFAULT 'floor' NOT NULL,
	`rounding_purchase` text DEFAULT 'floor' NOT NULL,
	`depreciation_record_method` text DEFAULT 'indirect' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `counterparties` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`name_kana` text,
	`honorific` text,
	`customer_code` text,
	`invoice_reg_no` text,
	`peppol_id` text,
	`payment_term_month` text,
	`payment_term_day` text,
	`holiday_adjustment` text,
	`zip` text,
	`prefecture` text,
	`address1` text,
	`address2` text,
	`phone` text,
	`email` text,
	`cc_email` text,
	`contact_name` text,
	`contact_title` text,
	`memo` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `departments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `depreciation_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fixed_asset_id` integer NOT NULL,
	`fiscal_year_id` integer NOT NULL,
	`opening_book_value` integer NOT NULL,
	`depreciation_amount` integer NOT NULL,
	`business_amount` integer NOT NULL,
	`closing_book_value` integer NOT NULL,
	`journal_entry_id` integer,
	FOREIGN KEY (`fixed_asset_id`) REFERENCES `fixed_assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fiscal_year_id`) REFERENCES `fiscal_years`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `document_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` integer NOT NULL,
	`line_no` integer NOT NULL,
	`item_id` integer,
	`description` text,
	`delivery_date` text,
	`unit_price` integer,
	`quantity` real,
	`amount` integer,
	`tax_rate` integer,
	`withholding` integer DEFAULT false NOT NULL,
	`delivery_doc_no` text,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_type` text NOT NULL,
	`doc_no` text,
	`counterparty_id` integer,
	`honorific` text,
	`subject` text,
	`issue_date` text,
	`due_date` text,
	`revenue_recognition_date` text,
	`payment_info` text,
	`remarks` text,
	`memo` text,
	`subtotal` integer,
	`tax_total` integer,
	`withholding_total` integer,
	`total` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`converted_from_id` integer,
	`journal_entry_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`counterparty_id`) REFERENCES `counterparties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `entry_tags` (
	`entry_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`entry_id`, `tag_id`),
	FOREIGN KEY (`entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `fiscal_years` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fixed_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`management_no` text,
	`name` text NOT NULL,
	`reflect_name_to_description` integer DEFAULT false NOT NULL,
	`account_id` integer,
	`acquisition_cost` integer NOT NULL,
	`quantity_or_area` real DEFAULT 1 NOT NULL,
	`acquired_date` text,
	`business_start_date` text,
	`depreciation_method` text NOT NULL,
	`useful_life` integer,
	`depreciation_rate` real,
	`business_use_ratio` real DEFAULT 100 NOT NULL,
	`real_estate_ratio` real,
	`opening_book_value` integer,
	`special_depreciation_amount` integer,
	`retired_date` text,
	`include_in_blue_return` integer DEFAULT true NOT NULL,
	`note` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_type` text NOT NULL,
	`account_ref` text,
	`file_name` text,
	`imported_at` text,
	`row_count` integer,
	`status` text DEFAULT 'done' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`item_code` text,
	`unit_price` integer,
	`default_quantity` integer,
	`unit` text,
	`detail` text,
	`tax_rate` integer,
	`withholding` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fiscal_year_id` integer NOT NULL,
	`entry_date` text NOT NULL,
	`slip_no` text,
	`description` text,
	`memo` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_ref` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`fiscal_year_id`) REFERENCES `fiscal_years`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `journal_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` integer NOT NULL,
	`line_no` integer NOT NULL,
	`side` text NOT NULL,
	`account_id` integer NOT NULL,
	`sub_account_id` integer,
	`department_id` integer,
	`counterparty_id` integer,
	`amount` integer NOT NULL,
	`tax_category_id` integer,
	`tax_amount` integer,
	`is_qualified_invoice` integer,
	`proration_applied` integer DEFAULT false NOT NULL,
	`description` text,
	FOREIGN KEY (`entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sub_account_id`) REFERENCES `sub_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`counterparty_id`) REFERENCES `counterparties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tax_category_id`) REFERENCES `tax_categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `mapping_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_type` text NOT NULL,
	`pattern` text NOT NULL,
	`account_id` integer NOT NULL,
	`sub_account_id` integer,
	`tax_category_id` integer,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sub_account_id`) REFERENCES `sub_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tax_category_id`) REFERENCES `tax_categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `opening_balances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fiscal_year_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`sub_account_id` integer,
	`side` text NOT NULL,
	`amount` integer NOT NULL,
	FOREIGN KEY (`fiscal_year_id`) REFERENCES `fiscal_years`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sub_account_id`) REFERENCES `sub_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `proration_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fiscal_year_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`sub_account_id` integer,
	`business_ratio` real NOT NULL,
	`method` text DEFAULT 'year_end' NOT NULL,
	`note` text,
	FOREIGN KEY (`fiscal_year_id`) REFERENCES `fiscal_years`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sub_account_id`) REFERENCES `sub_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `raw_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`txn_date` text NOT NULL,
	`amount` integer NOT NULL,
	`direction` text NOT NULL,
	`description` text,
	`raw_payload` text,
	`dedup_hash` text NOT NULL,
	`account_ref` text NOT NULL,
	`suggested_account_id` integer,
	`suggested_sub_account_id` integer,
	`suggested_tax_category_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`journal_entry_id` integer,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`suggested_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`suggested_sub_account_id`) REFERENCES `sub_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`suggested_tax_category_id`) REFERENCES `tax_categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `raw_txn_dedup_uq` ON `raw_transactions` (`account_ref`,`dedup_hash`);--> statement-breakpoint
CREATE TABLE `statement_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category_id` integer NOT NULL,
	`name` text NOT NULL,
	`statement_line_code` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `account_categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sub_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`name` text NOT NULL,
	`default_tax_category_id` integer,
	`counterparty_id` integer,
	`linked_account_ref` text,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_tax_category_id`) REFERENCES `tax_categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`counterparty_id`) REFERENCES `counterparties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `tax_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`label` text NOT NULL,
	`taxability` text NOT NULL,
	`direction` text NOT NULL,
	`rate` integer,
	`simplified_category` text,
	`adjustment` text DEFAULT 'none' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_categories_code_unique` ON `tax_categories` (`code`);