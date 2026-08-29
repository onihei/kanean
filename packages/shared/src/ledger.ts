/**
 * 複式簿記の基本語彙（accounting-spec §1）。core の計算と API の DTO（server/web）が共有する。
 * 実装（貸借検証・残高計算）は @kanean/core にある。
 */

/** 借方（debit）/ 貸方（credit）。 */
export type Side = 'debit' | 'credit'
