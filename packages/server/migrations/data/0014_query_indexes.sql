CREATE INDEX `audit_logs_target_idx` ON `audit_logs` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `journal_entries_fy_date_idx` ON `journal_entries` (`fiscal_year_id`,`entry_date`);--> statement-breakpoint
CREATE INDEX `journal_lines_entry_idx` ON `journal_lines` (`entry_id`,`line_no`);--> statement-breakpoint
CREATE INDEX `journal_lines_account_idx` ON `journal_lines` (`account_id`);--> statement-breakpoint
CREATE INDEX `journal_lines_sub_account_idx` ON `journal_lines` (`sub_account_id`);--> statement-breakpoint
CREATE INDEX `raw_txn_journal_entry_idx` ON `raw_transactions` (`journal_entry_id`);--> statement-breakpoint
CREATE INDEX `raw_txn_status_date_idx` ON `raw_transactions` (`status`,`txn_date`);--> statement-breakpoint
CREATE INDEX `raw_txn_batch_status_idx` ON `raw_transactions` (`batch_id`,`status`);