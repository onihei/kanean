import type { ReconcileGap, AccountReconcile, ReconcileReport } from '@kanean/shared'
export type { ReconcileGap, AccountReconcile, ReconcileReport }
import { asc, isNotNull } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { rawTransactions } from '../db/data/schema.js'

/**
 * 残高同期・突合（csv-format C-10 / roadmap Phase3・Exit基準3）。
 *
 * 銀行 CSV の差引残高（running balance）は口座の正本。各行は「取引後残高(post=balance)」と
 * 「符号付き金額（入金:+ / 出金:−）」を持つので、その行の「取引前残高(pre=balance−符号付き金額)」が
 * 確定する。完全な明細では、ある行の pre は必ず別の行の post（直前取引の残高）に一致する
 * （口座の期首＝最初の取引の pre を除く）。
 *
 * そこで post を「供給」・pre を「需要」とし、需要を供給に結びつける（チェーン連結）。需要が
 * どの供給にも結べない行は、その直前に**未取込の取引（取りこぼし）**がある疑い。結べない行は
 * 口座あたり1件（期首）だけが正当で、それ以上は差異として報告する。
 *
 * この方式は**取込順・CSVの並び順（昇順/逆時系列）に依存しない**。銀行CSVが同日内を
 * 新しい順に並べても、複数バッチで同日取引が分かれても、残高そのものでチェーンを辿るため
 * 正常データを誤検知しない。dedup の残余（同日同額同摘要の別取引が再取込と区別できずスキップ）も
 * 残高の不連続として独立に検知する安全網になる。残高列を持たない明細（カード等 balance=null）は対象外。
 *
 * 限界:
 * - 区間の欠落取引の符号付き合計が0（例: +500 と −500 が両方未取込）の場合、残高は連続するため
 *   検知できない（残高差分照合の本質的限界）。
 * - 取りこぼし有無（balanced）と件数の検出は正しいが、同一取引日に未連結行が複数ある場合に
 *   「どの同日行を期首/ギャップとして表示するか」は (date,id) 順のヒューリスティック（同日内は順序
 *   非依存のため）。検出は正しく、表示行の帰属のみ前後し得る＝レビュアーは同日クラスタを疑い窓として見る。
 */

/** 口座残高に対する符号付き増減（入金=+ / 出金=−）。 */
const signedDelta = (direction: string, amount: number): number => (direction === 'in' ? amount : -amount)

export function reconcileBalances(db: DataDb): ReconcileReport {
  const rows = db
    .select({
      id: rawTransactions.id,
      accountRef: rawTransactions.accountRef,
      txnDate: rawTransactions.txnDate,
      amount: rawTransactions.amount,
      direction: rawTransactions.direction,
      balance: rawTransactions.balance,
      description: rawTransactions.description,
    })
    .from(rawTransactions)
    .where(isNotNull(rawTransactions.balance))
    // (date,id) 昇順は期首の決定とギャップ報告順の安定化のためだけに使う（連結判定は順序非依存）。
    .orderBy(asc(rawTransactions.accountRef), asc(rawTransactions.txnDate), asc(rawTransactions.id))
    .all()

  const byAccount = new Map<string, typeof rows>()
  for (const r of rows) {
    const list = byAccount.get(r.accountRef)
    if (list) list.push(r)
    else byAccount.set(r.accountRef, [r])
  }

  const accounts: AccountReconcile[] = []
  for (const [accountRef, list] of byAccount) {
    // 供給（直前取引の候補＝post 残高の多重集合）を**取引日昇順で逐次積み上げ**る。各取引日の行を
    // 突合する前にその日の post を供給へ加えることで、「日付的に後の取引を予測元にしない」を保証しつつ
    // 同日内は順序非依存（CSVの並び順・複数バッチに依存しない）に保つ。list は (date,id) 昇順。
    const supply = new Map<number, number>()
    const unrooted: typeof list = []
    let i = 0
    while (i < list.length) {
      const date = list[i].txnDate
      const groupStart = i
      // 同一取引日の post をまとめて供給へ（同日内は相互に直前取引になり得る）。
      while (i < list.length && list[i].txnDate === date) {
        const post = list[i].balance as number
        supply.set(post, (supply.get(post) ?? 0) + 1)
        i++
      }
      // 同一取引日の各行の pre を供給（=当日まで）へ結びつける。結べなければ未連結＝取りこぼしの疑い。
      for (let j = groupStart; j < i; j++) {
        const r = list[j]
        const pre = (r.balance as number) - signedDelta(r.direction, r.amount)
        const avail = supply.get(pre) ?? 0
        if (avail > 0) supply.set(pre, avail - 1) // 直前取引が存在＝連結
        else unrooted.push(r)
      }
    }
    // unrooted は (date,id) 昇順。先頭1件は口座期首として正当、残りが取りこぼしの疑い。
    const gaps: ReconcileGap[] = unrooted.slice(1).map((r) => {
      const delta = signedDelta(r.direction, r.amount)
      return { date: r.txnDate, description: r.description, expectedPrevBalance: (r.balance as number) - delta, balance: r.balance as number, delta }
    })
    accounts.push({
      accountRef,
      rowCount: list.length,
      lastBalance: list.length > 0 ? (list[list.length - 1].balance as number) : null,
      gaps,
      balanced: gaps.length === 0,
    })
  }
  accounts.sort((a, b) => a.accountRef.localeCompare(b.accountRef))
  return { accounts }
}
