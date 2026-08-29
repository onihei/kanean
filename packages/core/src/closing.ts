import { type Yen, yen } from '@kanean/shared'
import type { Side } from './ledger.js'

/**
 * 個人事業特有の期末処理（accounting-spec §1.3）。
 *
 * 事業主貸／事業主借／控除前所得金額を期末に **元入金** へ振り替えた結果としての
 * 「翌期首の元入金」を算出する純関数。
 *
 *   翌期首元入金 = 前期末元入金 + 当期所得 + 事業主借 − 事業主貸
 *
 * すべて円整数入力なので丸めは発生しない（中間で非整数が生じれば yen() が弾く）。
 *
 * 注意（legalRisk:high）: 本算出は **翌期 opening_balances の元入金を決める計算** であり、
 * 当年度の仕訳起票は行わない（決算書・貸借の期末表示＝事業主貸借／控除前所得の連結を
 * 壊さないため）。税理士サインオフを経るまで確定値として扱わない。
 */
export interface CapitalRollforwardInput {
  /** 前期末元入金（＝当年度期首の元入金 opening balance）。 */
  priorMotoire: Yen
  /** 当期所得（控除前所得金額 ㊸ ＝ 損益計算書の当期所得）。負値可。 */
  incomeBeforeDeduction: Yen
  /** 事業主借 期末残高（貸方正の残高）。 */
  ownerLoan: Yen
  /** 事業主貸 期末残高（借方正の残高）。 */
  ownerDraw: Yen
}

export interface CapitalRollforwardResult {
  /** 翌期首の元入金。 */
  nextMotoire: Yen
  /** 当期の元入金増減（＝ 当期所得 + 事業主借 − 事業主貸）。 */
  netChange: Yen
  /** 入力の内訳（表示・検算用にそのまま返す）。 */
  priorMotoire: Yen
  incomeBeforeDeduction: Yen
  ownerLoan: Yen
  ownerDraw: Yen
}

/** §1.3 元入金振替の翌期首残高を算出する（純関数）。 */
export function ownerCapitalRollforward(input: CapitalRollforwardInput): CapitalRollforwardResult {
  const { priorMotoire, incomeBeforeDeduction, ownerLoan, ownerDraw } = input
  const netChange = yen(incomeBeforeDeduction + ownerLoan - ownerDraw)
  const nextMotoire = yen(priorMotoire + netChange)
  return { nextMotoire, netChange, priorMotoire, incomeBeforeDeduction, ownerLoan, ownerDraw }
}

/**
 * 青色申告特別控除（㊹）と所得金額（㊺）の判定（青色決算書 損益・form-mapping §1.1）。
 *
 *   ㊸ 控除前所得金額 → ㊹ 青色申告特別控除額 → ㊺ 所得金額 = ㊸ − ㊹
 *
 * 控除限度額の要件（個人・事業所得）:
 *   - 白色（filingType='white'）            → 0（青色申告特別控除は青色のみ）
 *   - 青色 + 複式簿記 + e-Tax/優良電子帳簿  → 650,000
 *   - 青色 + 複式簿記（電子要件なし）       → 550,000
 *   - 青色 + 簡易簿記 / 現金主義            → 100,000
 *   - 控除額 = min(限度額, max(0, 控除前所得))（赤字なら0・控除は所得を超えない）
 *
 * ⚠️ legalRisk:high — 65/55/10万の判定根拠（複式簿記・貸借対照表添付・e-Tax提出・優良電子帳簿）は
 *    税理士サインオフ対象。本関数は与えられた要件フラグから機械的に算出するだけで、要件充足の
 *    事実認定は呼び出し側／申告者の責任。複数所得（不動産＋事業）の合算・順序は対象外（事業所得単独前提）。
 */
export type BookkeepingMethod = 'double_entry' | 'simple' | 'cash'

export interface BlueDeductionInput {
  /** ㊸ 控除前所得金額（損益計算書の当期所得。負値＝赤字可）。 */
  incomeBeforeDeduction: Yen
  /** 申告区分（青色/白色）。 */
  filingType: 'blue' | 'white'
  /** 記帳方法（複式簿記=double_entry で 55/65万、簡易/現金主義は10万）。 */
  bookkeeping: BookkeepingMethod
  /** e-Tax電子申告 または 優良な電子帳簿の保存により 65万円控除の要件を満たすか。 */
  qualifiesFor65: boolean
}

export interface BlueDeductionResult {
  /** 控除限度額（650,000 / 550,000 / 100,000 / 0）。 */
  limit: Yen
  /** ㊹ 青色申告特別控除額（= min(限度額, max(0, ㊸))）。 */
  deduction: Yen
  /** ㊺ 所得金額（= ㊸ − ㊹）。 */
  incomeAfter: Yen
  /** 判定根拠（表示用）。 */
  basis: string
}

/**
 * 年度繰越（year-end rollover）の純関数（accounting-spec §1.3 / §5.2）。
 *
 * 当期の資産・負債科目の期末残高を翌期 opening_balances へ繰越し、資本は元入金1本に集約する
 * （事業主貸・事業主借・控除前所得は元入金へ振替済み＝翌期は繰越さない）。
 * 翌期首BSの貸借一致は nextMotoire（§1.3）が貸借差を吸収して成立する。
 */

export interface OpeningSide {
  side: Side
  amount: Yen
}

/**
 * normal_balance 方向の符号付き残高を opening_balances の (side, amount) に変換する。
 * balance>=0 は normal 側、balance<0 は反対側（評価勘定・マイナス残高も正しく変換）。
 */
export function toOpeningSide(normalBalance: Side, balance: Yen): OpeningSide {
  const onNormalSide = balance >= 0
  const side: Side = onNormalSide ? normalBalance : normalBalance === 'debit' ? 'credit' : 'debit'
  return { side, amount: yen(Math.abs(balance)) }
}

export interface RolloverAccountRow {
  accountId: number
  /** 補助科目ID（補助科目なしの残高は null）。補助科目別の内訳行として渡す。 */
  subAccountId?: number | null
  normalBalance: Side
  /** 期末残高（normal_balance 方向・符号付き）。 */
  balance: Yen
}

export interface RolloverOpeningBalance {
  accountId: number
  subAccountId: number | null
  side: Side
  amount: Yen
}

export interface RolloverInput {
  /** 当期の資産・負債科目の期末残高（資本科目は渡さない）。 */
  assetLiabilityRows: RolloverAccountRow[]
  /** 元入金の勘定科目ID。 */
  motoireAccountId: number
  /** 翌期首の元入金（ownerCapitalRollforward の結果＝§1.3）。 */
  nextMotoire: Yen
}

/**
 * 翌期 opening_balances 候補を生成する。資産・負債は期末残高をそのまま繰越（残高0は省略）、
 * 元入金は nextMotoire で1行（0なら省略）。事業主貸/事業主借は呼び出し側が assetLiabilityRows に
 * 含めない（＝翌期リセット）。
 * 補助科目レベルの繰越は呼び出し側が (勘定科目, 補助科目) 粒度の内訳行を渡すことで表現する
 * （補助元帳の期首繰越が翌期に引き継がれる）。
 */
export function rolloverOpeningBalances(input: RolloverInput): RolloverOpeningBalance[] {
  const out: RolloverOpeningBalance[] = []
  for (const r of input.assetLiabilityRows) {
    if (r.balance === 0) continue
    const { side, amount } = toOpeningSide(r.normalBalance, r.balance)
    out.push({ accountId: r.accountId, subAccountId: r.subAccountId ?? null, side, amount })
  }
  if (input.nextMotoire !== 0) {
    const { side, amount } = toOpeningSide('credit', input.nextMotoire)
    out.push({ accountId: input.motoireAccountId, subAccountId: null, side, amount })
  }
  return out
}

export function blueSpecialDeduction(input: BlueDeductionInput): BlueDeductionResult {
  const { incomeBeforeDeduction, filingType, bookkeeping, qualifiesFor65 } = input

  let limit = 0
  let basis: string
  if (filingType !== 'blue') {
    limit = 0
    basis = '白色申告（青色申告特別控除なし）'
  } else if (bookkeeping !== 'double_entry') {
    limit = 100_000
    basis = '青色・簡易簿記/現金主義（10万円）'
  } else if (qualifiesFor65) {
    limit = 650_000
    basis = '青色・複式簿記・e-Tax提出または優良な電子帳簿（65万円）'
  } else {
    limit = 550_000
    basis = '青色・複式簿記（55万円。e-Tax提出または優良な電子帳簿で65万円）'
  }

  const deduction = Math.min(limit, Math.max(0, incomeBeforeDeduction))
  return {
    limit: yen(limit),
    deduction: yen(deduction),
    incomeAfter: yen(incomeBeforeDeduction - deduction),
    basis,
  }
}
