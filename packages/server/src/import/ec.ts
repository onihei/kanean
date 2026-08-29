import { SUSPENSE_ACCOUNT } from './precondition.js'
export { SUSPENSE_ACCOUNT }
import { dedupHash } from './types.js'
import type { ParsedRow } from './types.js'

/**
 * EC（Amazon/楽天）正規化明細＋AI仕訳候補（csv-format §4.2）の純粋マッピング。I/Oなし。
 * 取得スキルが POST する1注文＝複数明細を、raw_transactions 投入用の ParsedRow へ落とす。
 * - 借方(費用側)の目標科目は treatment / proposed_account から決める（解決・検証は呼び出し側のDB層）。
 * - 冪等キーは source + order_id + line_no（出現インデックス方式の銀行/カードとは別系統）。
 * - direction は常に out（最上流で費用が発生。貸方=未払金チャネルは journalize 側で機械適用・§4.3）。
 */

export type EcTreatment = 'expense' | 'owner_draw' | 'unresolved'

/** §4.2 EC明細1行（取得層 → importer の契約）。 */
export interface EcLine {
  lineNo: number
  itemName: string
  quantity: number
  lineAmount: number // 税込・円整数。**その商品の値引き反映後の純額**（適格請求書PDFの商品別小計。csv-format §4.3）
  /** AIが分類した科目名（treatment=expense のとき使う）。 */
  proposedAccount?: string
  treatment?: EcTreatment
  reason?: string
  confidence?: 'high' | 'medium' | 'low'
  policyRef?: string
  evidenceRef: string // 生証跡（必須・監査/電帳法）
}

/** §4.2 1注文。 */
export interface EcOrder {
  orderId: string
  orderDate: string // ISO YYYY-MM-DD（発生日）
  orderTotal: number // 税込合計＝ご請求額（カード突合キー）。Σ(純額 lineAmount) + shipping − pointsUsed と一致するべき
  paymentHint?: string
  currency?: string
  lines: EcLine[]
  /**
   * 注文レベル調整（電帳法・突合。csv-format §4.3）。非負円整数・省略=0。
   * 割引は **lineAmount を純額化**（適格請求書PDFの商品別小計）して取り込むため、ここには持たない。
   */
  shipping?: number // 送料・手数料 → 借)雑費（未払金を増やす）
  pointsUsed?: number // ポイント利用 → 貸)事業主借（個人ポイントで肩代わり・未払金を減らす）
  pointsEarned?: number // ポイント付与 → 借)事業主貸/貸)雑収入（任意・請求額に無影響）
}

/** 私用＝事業主貸 / 判別不能＝未確定勘定（[classification-policy.md] と一致）。 */
export const OWNER_DRAW_ACCOUNT = '事業主貸'
// SUSPENSE_ACCOUNT の定義は import/precondition.ts（B4=#117。既存 importer 互換のため再輸出）。
/** 注文レベル調整の置き先（方式B・[csv-format §4.3]）。 */
export const OWNER_LOAN_ACCOUNT = '事業主借' // ポイント利用＝個人→事業
export const SHIPPING_ACCOUNT = '雑費' // 送料・手数料（仕入諸掛）
export const MISC_INCOME_ACCOUNT = '雑収入' // ポイント付与の受け

export type EcAdjustmentKind = 'shipping' | 'pointsUsed' | 'pointsEarned'

/** order の有効な調整（額>0）を列挙。discount は line 純額化するのでここには出さない。 */
export function orderAdjustments(order: EcOrder): { kind: EcAdjustmentKind; amount: number }[] {
  const out: { kind: EcAdjustmentKind; amount: number }[] = []
  if ((order.shipping ?? 0) > 0) out.push({ kind: 'shipping', amount: order.shipping as number })
  if ((order.pointsUsed ?? 0) > 0) out.push({ kind: 'pointsUsed', amount: order.pointsUsed as number })
  if ((order.pointsEarned ?? 0) > 0) out.push({ kind: 'pointsEarned', amount: order.pointsEarned as number })
  return out
}

/**
 * 仕訳候補から借方(費用側)の目標勘定科目名を決める。
 * - owner_draw → 事業主貸 / unresolved（または未指定）→ 未確定勘定
 * - expense → proposed_account（空なら安全側で未確定勘定）
 * 返す名前は本体が account_id へ検証し、未知/曖昧は未確定勘定＋flag にする（[ec-import-api.md §3]）。
 */
export function targetAccountName(line: Pick<EcLine, 'treatment' | 'proposedAccount'>): string {
  switch (line.treatment) {
    case 'owner_draw':
      return OWNER_DRAW_ACCOUNT
    case 'expense':
      return line.proposedAccount?.trim() || SUSPENSE_ACCOUNT
    case 'unresolved':
      return SUSPENSE_ACCOUNT
    default:
      // treatment 未指定でも proposed_account があればそれを使う（無ければ未確定）。
      return line.proposedAccount?.trim() || SUSPENSE_ACCOUNT
  }
}

/** EC の冪等キー（csv-format §4.2）: source + order_id + line_no。 */
export function ecDedupHash(source: string, orderId: string, lineNo: number): string {
  return dedupHash([source, orderId, lineNo])
}

/** 調整行の冪等キー（明細 line_no と衝突しない予約キー `adj:<kind>`）。 */
export function ecAdjustmentDedupHash(source: string, orderId: string, kind: EcAdjustmentKind): string {
  return dedupHash([source, orderId, `adj:${kind}`])
}

/**
 * EC スキルトラックの payload マーカー（bank.ts の BANK_SKILL_TRACK と対称・issue #126 = B14）。
 * これより前に取り込まれた既存行は track を持たない＝判定側（isEcRaw / extractOrigin）は
 * orderId / batch.sourceType のフォールバックを必ず残す（マイグレーションはしない）。
 */
export const EC_SKILL_TRACK = 'ec_skill'

/**
 * EC明細1行 → raw_transactions 投入用 ParsedRow。
 * raw_payload に注文文脈とAI仕訳候補（reason/confidence/policy_ref 等）を JSON で残す（監査用）。
 * lineAmount は **その商品の値引き反映後の税込純額**（適格請求書PDFの商品別小計）をそのまま起票する。
 */
export function ecLineToParsedRow(source: string, order: EcOrder, line: EcLine): ParsedRow {
  const amount = line.lineAmount
  const payload = {
    track: EC_SKILL_TRACK,
    source,
    orderId: order.orderId,
    orderDate: order.orderDate,
    orderTotal: order.orderTotal,
    lineNo: line.lineNo,
    itemName: line.itemName,
    quantity: line.quantity,
    lineAmount: amount, // 税込純額（値引き反映後）
    proposedAccount: line.proposedAccount ?? null,
    treatment: line.treatment ?? null,
    reason: line.reason ?? null,
    confidence: line.confidence ?? null,
    policyRef: line.policyRef ?? null,
    paymentHint: order.paymentHint ?? null,
    evidenceRef: line.evidenceRef,
    currency: order.currency ?? 'JPY',
  }
  return {
    txnDate: order.orderDate,
    amount,
    direction: 'out',
    description: line.itemName,
    rawPayload: JSON.stringify(payload),
    dedupHash: ecDedupHash(source, order.orderId, line.lineNo),
  }
}

const ADJ_LABEL: Record<EcAdjustmentKind, string> = { shipping: '送料・手数料', pointsUsed: 'ポイント利用', pointsEarned: 'ポイント付与' }

/** 注文レベル調整 → raw_transactions 投入用 ParsedRow（rawPayload.adjustment で journalize が分岐）。 */
export function ecAdjustmentToParsedRow(source: string, order: EcOrder, kind: EcAdjustmentKind, amount: number): ParsedRow {
  const payload = { track: EC_SKILL_TRACK, source, orderId: order.orderId, orderDate: order.orderDate, orderTotal: order.orderTotal, adjustment: kind, amount }
  return {
    txnDate: order.orderDate,
    amount,
    direction: 'out',
    description: `${ADJ_LABEL[kind]}（注文 ${order.orderId}）`,
    rawPayload: JSON.stringify(payload),
    dedupHash: ecAdjustmentDedupHash(source, order.orderId, kind),
  }
}

/** この raw_payload が EC スキルトラックか（track==='ec_skill'）。isBankSkillPayload と対称。 */
export function isEcSkillPayload(rawPayload: string | null): boolean {
  if (!rawPayload) return false
  try {
    return (JSON.parse(rawPayload) as { track?: unknown }).track === EC_SKILL_TRACK
  } catch {
    return false
  }
}

/** rawPayload から調整種別を復元（明細行なら null）。journalize の分岐に使う。 */
export function parseAdjustmentKind(rawPayload: string | null): EcAdjustmentKind | null {
  if (!rawPayload) return null
  try {
    const k = (JSON.parse(rawPayload) as { adjustment?: unknown }).adjustment
    return k === 'shipping' || k === 'pointsUsed' || k === 'pointsEarned' ? k : null
  } catch {
    return null
  }
}

/**
 * 突合差（[csv-format §4.3]）: (Σ 純額 line_amount + shipping − pointsUsed) − order_total。
 * lineAmount は値引き反映後ゆえ割引項は無い。0=請求額（未払金）と一致。非0は抽出ミスの可能性＝警告に積む。
 */
export function orderTotalMismatch(order: EcOrder): number {
  const sum = order.lines.reduce((acc, l) => acc + l.lineAmount, 0)
  return sum + (order.shipping ?? 0) - (order.pointsUsed ?? 0) - order.orderTotal
}
