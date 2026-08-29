// 銀行明細テーブルの列同定・正規化・検算。純関数＝殻（Playwright / Electron）によらず同一の結果になる。
//
// mufg / shinsei の normalize-verify はほぼ同文の二重実装だった（差分は「年ヒント引き継ぎ」
// 「メモ列連結」「reverse の方針」の3点だけ）。金額に直結する処理なのでここへ抽出し、
// サイト側は SEL とその3点の宣言だけを書く。挙動（エラーの step/message/hint・警告文言）は
// 抽出前と同一に保っている。
import { ScrapeError } from './errors.mjs'
import { yen, isoDate } from './normalize.mjs'
import { colIndex } from './page.mjs'
import { verifyBalanceChain } from './verify.mjs'

/**
 * 明細テーブルのヘッダから列インデックスを同定する。
 *
 * @param {string[]} header 実ヘッダ
 * @param {{colDate:string, colOut:string, colIn:string, colBalance:string, colDesc:string, colMemo?:string}} sel
 * @param {{memo?: boolean, requireBoth?: boolean}} [opts]
 *   memo: メモ列も同定する（shinsei。無ければ -1 のまま＝連結しない）
 *   requireBoth: 出金・入金の両列を必須にする（shinsei。mufg はどちらか一方で可）
 * @returns {{date:number, out:number, in:number, balance:number, desc:number, memo?:number}}
 * @throws {ScrapeError} 必須列が同定できないとき（step='extract-table'）
 */
export function bankColumns(header, sel, { memo = false, requireBoth = false } = {}) {
  const ci = {
    date: colIndex(header, sel.colDate),
    out: colIndex(header, sel.colOut),
    in: colIndex(header, sel.colIn),
    balance: colIndex(header, sel.colBalance),
    desc: colIndex(header, sel.colDesc),
  }
  if (memo) ci.memo = colIndex(header, sel.colMemo)
  const missing = requireBoth ? ci.out < 0 || ci.in < 0 : ci.out < 0 && ci.in < 0
  if (ci.date < 0 || ci.balance < 0 || missing)
    throw new ScrapeError(
      'extract-table',
      `カラム同定失敗: ${JSON.stringify(header)}`,
      'SEL.col* の正規表現を実ヘッダに合わせる'
    )
  return ci
}

/**
 * 生の行（セル配列＋列同定）を取引へ正規化する。見出し・合計行（日付/残高/金額が読めない行）は捨てる。
 *
 * @param {{cells: string[], ci: ReturnType<typeof bankColumns>}[]} rawRows
 * @param {{yearHint?: boolean}} [opts]
 *   yearHint: 「YYYY年」見出し行から年を引き継ぐ（mufg 新サイトは日付が "4/10" 形式）
 * @returns {{txnDate:string, amount:number, direction:'out'|'in', description:string, balance:number}[]}
 */
export function buildBankTxns(rawRows, { yearHint = false } = {}) {
  let hint = null
  const txns = []
  for (const { cells, ci } of rawRows) {
    if (yearHint) {
      const ym = /(20\d\d)年/.exec(cells.join(' '))
      if (ym) hint = parseInt(ym[1], 10)
    }
    const txnDate = isoDate(cells[ci.date], hint)
    const outAmt = ci.out >= 0 ? yen(cells[ci.out]) : null
    const inAmt = ci.in >= 0 ? yen(cells[ci.in]) : null
    const balance = yen(cells[ci.balance])
    if (!txnDate || balance == null || (!outAmt && !inAmt)) continue // 見出し・合計行
    const memo = ci.memo != null && ci.memo >= 0 ? (cells[ci.memo] ?? '').trim() : ''
    txns.push({
      txnDate,
      amount: outAmt || inAmt,
      direction: outAmt ? 'out' : 'in',
      description: ((cells[ci.desc] ?? '').trim() + (memo ? ` ${memo}` : '')).trim(),
      balance,
    })
  }
  return txns
}

/**
 * 古い順へ整え、残高チェーンを検算し、期間で絞る。**合わなければ投入しない**（銀行トラックの生命線）。
 *
 * ⚠ 日付ソートはしない（同日内順序が失われ、チェーン検算が偽陽性で壊れる）。
 *   並びは DOM 順の反転だけで整える。
 *
 * @param {ReturnType<typeof buildBankTxns>} txns
 * @param {{since: string, until: string}} args
 * @param {string[]} warnings 期間クランプの警告を積む先
 * @param {{reverse?: 'auto'|'always', chainHint: string, clampSuffix: string}} opts
 *   reverse 'auto': 先頭が末尾より新しいときだけ反転（mufg）
 *   reverse 'always': 常に反転し、それでも新しい順なら「表示順の前提が変わった」として失敗（shinsei）
 *   chainHint: 残高チェーン不連続時のヒント（サイトごとの疑いどころ）
 *   clampSuffix: 期間クランプ警告の末尾（サイトごとの補完手段）
 * @returns {{txns: object[], allCount: number}} 期間内の取引と、検算対象の全件数
 * @throws {ScrapeError} 0件・表示順の前提崩れ・残高チェーン不連続（step='normalize-verify'）
 */
export function verifyAndClamp(txns, args, warnings, { reverse = 'auto', chainHint, clampSuffix }) {
  if (!txns.length)
    throw new ScrapeError(
      'normalize-verify',
      '明細0件（期間内に取引なし or 抽出失敗）',
      '0件が正なら問題なし。スクショで確認'
    )
  if (reverse === 'always') {
    txns.reverse()
    if (txns[0].txnDate > txns[txns.length - 1].txnDate)
      throw new ScrapeError(
        'normalize-verify',
        'DOM反転後も新しい順 → 表示順の前提が変わった',
        '表示順を確認して reverse の要否を較正する'
      )
  } else if (txns[0].txnDate > txns[txns.length - 1].txnDate) {
    txns.reverse()
  }
  const chain = verifyBalanceChain(txns)
  if (!chain.ok)
    throw new ScrapeError(
      'normalize-verify',
      `残高チェーン不連続 row=${chain.index} expected=${chain.expected} actual=${chain.actual} (${JSON.stringify(chain.row)})`,
      chainHint
    )
  const inRange = txns.filter((t) => t.txnDate >= args.since && t.txnDate <= args.until)
  // 期間クランプ検証: 返ってきた最古 > 要求開始日なら取りこぼしの可能性
  if (txns[0].txnDate > args.since)
    warnings.push(
      `期間クランプの可能性: 要求開始 ${args.since} に対し最古表示 ${txns[0].txnDate}${clampSuffix}`
    )
  return { txns: inRange, allCount: txns.length }
}
