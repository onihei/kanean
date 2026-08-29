-- Custom SQL migration file, put your code below! --
-- 既存ユーザーDBへの statement_line_code バックフィル（青色申告決算書 損益ページ AOIRO.PL.*）。
-- seed.ts の LINE_CODE_BY_ITEM と同一対応。新規DBはseedで投入済みのため `IS NULL` ガードで再適用安全。
-- 決算書科目名は accountsChart.ts の決算書科目（CSV第3列）と一致。
-- ⚠️ 丸数字・官製欄番号は令和6年分公式様式で要突合（form-mapping §0注記）。本SQLは内部 line_code のみで官製番号に依存しない。
-- 空欄行候補（固定資産除却損・車両費・リース料・支払手数料・研修採用費・新聞図書費・会議費・繰延資産償却）は
-- NULL のままにし、集計側で空欄行へ動的割当する（意図的に UPDATE 対象外）。
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.SALES' WHERE name = '売上（収入）金額' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.OPEN_STOCK' WHERE name = '期首商品（製品）棚卸高' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.PURCHASE' WHERE name = '仕入金額' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.CLOSE_STOCK' WHERE name = '期末商品（製品）棚卸高' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_TAX' WHERE name = '租税公課' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_PACK' WHERE name = '荷造運賃' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_UTIL' WHERE name = '水道光熱費' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_TRAVEL' WHERE name = '旅費交通費' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_COMM' WHERE name = '通信費' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_AD' WHERE name = '広告宣伝費' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_ENT' WHERE name = '接待交際費' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_INS' WHERE name = '損害保険料' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_REPAIR' WHERE name = '修繕費' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_SUPPLY' WHERE name = '消耗品費' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_DEP' WHERE name = '減価償却費' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_WELFARE' WHERE name = '福利厚生費' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_SALARY' WHERE name = '給料賃金' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_OUTSRC' WHERE name = '外注工賃' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_INTEREST' WHERE name = '利子割引料' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_RENT' WHERE name = '地代家賃' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_BADDEBT' WHERE name = '貸倒金' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.EXP_MISC' WHERE name = '雑費' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.RESERVE_BACK' WHERE name = '貸倒引当金戻入' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.SENJU' WHERE name = '専従者給与' AND statement_line_code IS NULL;
--> statement-breakpoint
UPDATE statement_items SET statement_line_code = 'AOIRO.PL.RESERVE_IN' WHERE name = '貸倒引当金繰入' AND statement_line_code IS NULL;
