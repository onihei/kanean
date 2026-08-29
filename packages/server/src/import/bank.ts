import { SUSPENSE_ACCOUNT } from './precondition.js'
export { SUSPENSE_ACCOUNT }
import { toHankaku } from './normalize.js'
import type { ParsedRowDraft } from './types.js'

/**
 * 銀行（普通預金）スキルトラックの正規化取引＋AI仕訳候補（[bank-import-api.md] / [classification-policy.md] §5）の純粋マッピング。I/Oなし。
 * EC（[import/ec.ts]）の銀行版。取得スキルが POST する1取引＝1行を raw_transactions 投入用 ParsedRow へ落とす。
 *
 * ECとの構造差（[csv-format §4.3] の注）:
 * - EC は貸方が必ず「未払金チャネル（クリアリング連鎖）」。銀行は **普通預金が一脚**で、direction で貸借が決まる（journalize 側）。
 * - treatment は EC の expense/owner_draw/unresolved に加え owner_contribution（受取利息＝事業主借）/revenue（売上回収）/settlement（未払金決済）を持つ。
 * - 冪等キーは出現インデックス方式（[import/types.ts] withDedupHashes）＝UI手動CSV取込（[import/parsers/bankUfj.ts]）と互換。
 */

/** 摘要→相手科目の意味分類（[classification-policy.md] §5）。普通預金でない側の性格を表す。 */
export type BankTreatment = 'expense' | 'owner_draw' | 'owner_contribution' | 'revenue' | 'settlement' | 'unresolved'

const TREATMENTS: readonly BankTreatment[] = ['expense', 'owner_draw', 'owner_contribution', 'revenue', 'settlement', 'unresolved']

/** [bank-import-api.md] 銀行取引1行（取得層 → importer の契約）。 */
export interface BankTxn {
  txnDate: string // ISO YYYY-MM-DD（発生日＝取引日）
  amount: number // 円整数・非負（方向は direction で持つ）
  direction: 'in' | 'out' // 入金=普通預金が増える / 出金=減る
  description: string // 摘要（+摘要内容）。半角正規化はサーバでも行う（dedup 互換）
  balance?: number | null // 差引残高（残高チェーン C-10。DOM抽出の金額検証の要）
  /** AIが分類した相手科目名（treatment=expense/revenue/settlement のとき使う）。 */
  proposedAccount?: string
  treatment?: BankTreatment
  reason?: string
  confidence?: 'high' | 'medium' | 'low'
  policyRef?: string
  evidenceRef?: string // 生証跡（任意。銀行は残高チェーンが主たる検証）
  /** settlement 等で相手科目の補助科目（未払金カードチャネル等）を一意に指す linked_account_ref（任意）。 */
  counterSubAccountRef?: string
}

/** 相手科目（普通預金でない側）の特別科目名（[classification-policy.md] §5）。 */
export const OWNER_DRAW_ACCOUNT = '事業主貸' // 利息源泉・私用引出
export const OWNER_CONTRIBUTION_ACCOUNT = '事業主借' // 受取利息（個人の利子所得＝損益に含めない）
// SUSPENSE_ACCOUNT の定義は import/precondition.ts（B4=#117。既存 importer 互換のため再輸出）。

/** raw_payload に刻む銀行スキルトラックの識別子（UI手動CSV取込の raw と区別＝journalize の分岐）。 */
export const BANK_SKILL_TRACK = 'bank_skill'

/**
 * 仕訳候補から相手科目（普通預金でない側）の目標勘定科目名を決める。
 * - owner_draw → 事業主貸 / owner_contribution → 事業主借（決定的・[classification-policy.md] §5.1）
 * - expense / revenue / settlement → proposed_account（空なら安全側で未確定勘定）
 * - unresolved・未指定 → 未確定勘定
 * 返す名前は本体が account_id へ検証し、未知/曖昧は未確定勘定＋flag にする（[bank-import-api.md]）。
 */
export function bankCounterAccountName(t: Pick<BankTxn, 'treatment' | 'proposedAccount'>): string {
  switch (t.treatment) {
    case 'owner_draw':
      return OWNER_DRAW_ACCOUNT
    case 'owner_contribution':
      return OWNER_CONTRIBUTION_ACCOUNT
    case 'expense':
    case 'revenue':
    case 'settlement':
      return t.proposedAccount?.trim() || SUSPENSE_ACCOUNT
    case 'unresolved':
      return SUSPENSE_ACCOUNT
    default:
      // treatment 未指定でも proposed_account があればそれを使う（無ければ未確定）。
      return t.proposedAccount?.trim() || SUSPENSE_ACCOUNT
  }
}

export interface BankProposal {
  proposedAccount?: string
  treatment?: BankTreatment
  counterSubAccountRef?: string
}

/**
 * 銀行取引1行 → raw_transactions 投入用 ParsedRow（dedup_hash は importer の withDedupHashes が一括付与）。
 * raw_payload にAI仕訳候補（reason/confidence/policy_ref 等）と track 識別子を JSON で残す（監査＋journalize 復元）。
 * description は parseBankUfj と同じ toHankaku 正規化（dedup 互換＝UIトラックと同一口座で二重計上しない）。
 */
export function bankRowToParsedRow(txn: BankTxn): ParsedRowDraft {
  const description = toHankaku(txn.description ?? '').trim()
  const payload = {
    track: BANK_SKILL_TRACK,
    description,
    proposedAccount: txn.proposedAccount ?? null,
    treatment: txn.treatment ?? null,
    reason: txn.reason ?? null,
    confidence: txn.confidence ?? null,
    policyRef: txn.policyRef ?? null,
    evidenceRef: txn.evidenceRef ?? null,
    counterSubAccountRef: txn.counterSubAccountRef ?? null,
    balance: txn.balance ?? null,
  }
  return {
    txnDate: txn.txnDate,
    amount: txn.amount,
    direction: txn.direction,
    description,
    balance: txn.balance ?? null,
    rawPayload: JSON.stringify(payload),
  }
}

/** raw_payload からAI仕訳候補を復元（壊れている/別トラックなら空）。journalize の相手科目決定に使う。 */
export function parseBankProposal(rawPayload: string | null): BankProposal {
  if (!rawPayload) return {}
  try {
    const p = JSON.parse(rawPayload) as Record<string, unknown>
    if (p.track !== BANK_SKILL_TRACK) return {}
    return {
      proposedAccount: typeof p.proposedAccount === 'string' ? p.proposedAccount : undefined,
      treatment: TREATMENTS.includes(p.treatment as BankTreatment) ? (p.treatment as BankTreatment) : undefined,
      counterSubAccountRef: typeof p.counterSubAccountRef === 'string' ? p.counterSubAccountRef : undefined,
    }
  } catch {
    return {}
  }
}

/** この raw_payload が銀行スキルトラックか（track==='bank_skill'）。journalize/restore の経路分岐に使う。 */
export function isBankSkillPayload(rawPayload: string | null): boolean {
  if (!rawPayload) return false
  try {
    return (JSON.parse(rawPayload) as { track?: unknown }).track === BANK_SKILL_TRACK
  } catch {
    return false
  }
}
