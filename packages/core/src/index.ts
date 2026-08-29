/**
 * packages/core — 純関数の会計ドメイン（I/Oなし・ゴールデンテスト対象）。
 * architecture §6 / accounting-spec / depreciation-spec を実装する。
 *
 * 実装済: depreciation（定額法）, tax（簡易課税）, ledger（貸借・normal_balance・残高）,
 *        closing（期末元入金振替 §1.3）
 * 予定: proration（家事按分）, statements（帳票組成） … 増分3以降
 */
export * from './depreciation.js'
export * from './tax.js'
export * from './ledger.js'
export * from './closing.js'
export * from './incomeTax.js'
export * from './forecast.js'
export * from './filing.js'
