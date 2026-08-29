/**
 * 金融機関特有取引の既定自動仕訳（roadmap Phase3 / csv-format §3.2・§5）。純関数。
 *
 * 取込明細 → 仕訳の相手科目を、ユーザールール（auto_journal_rules）・履歴学習（mapping_history）が
 * 当たらなかった時の「既定」として、金融機関固有の意味から決める。journalize の2行モデルに乗る
 * （source 口座の反対側＝相手科目だけが決まればよい）。生成物は draft のままで、確認画面での承認を要する。
 *
 * 法的ゲート（legalRisk:medium）: 既定マッピングの妥当性（特に源泉20.315%・消費税納付区分）は
 * 税理士サインオフ対象。本モジュールは「黙って確定」せず draft 候補を出すに留める。
 *
 * 対象（source_type 別。摘要は半角正規化済み・description に連結済みを前提）:
 * - 新生(bank_shinsei) 入金「税引前利息」      → 受取利息。借)普通預金 / 貸)事業主借
 *     個人の預金利息は利子所得で事業所得に含めない（受取利息勘定は使わない・§3.2）。
 * - 新生(bank_shinsei) 出金「国税」「地方税」   → 利息の源泉（同日に税引前利息がある時のみ）。
 *     借)事業主貸 / 貸)普通預金。源泉(国税15.315%＋地方税5%＝20.315%)も損益外（§3.2）。
 *     ⚠ 同日の税引前利息と対になっているもののみ。予定納税等の国税/地方税は対象外（誤分類回避）。
 * - UFJ(bank_ufj) 出金「シヨウヒゼイ」          → 消費税の納付。借)租税公課 / 貸)普通預金（税込経理）。
 *     ⚠ UFJ の国税/地方税は対象にしない（新生の利息源泉と取り違えない・§5）。
 */

export interface InstitutionRawLike {
  description: string
  direction: 'in' | 'out'
  txnDate: string // ISO YYYY-MM-DD
}

export interface InstitutionContext {
  sourceType: string
  /** 同日・同口座に「税引前利息」入金があるか（利息源泉の判定用）。 */
  hasSameDayInterest: (txnDate: string) => boolean
}

/** 既定自動仕訳の相手科目（account 名で返す。journalize が id 解決し、無ければ未確定勘定にフォールバック）。 */
export interface InstitutionMatch {
  /** 相手勘定科目名（seed のチャート名）。 */
  accountName: string
  /** 分類理由（監査・テスト・将来の表示用）。 */
  reason: 'interest_income' | 'interest_withholding' | 'consumption_tax_payment'
}

const INTEREST = '税引前利息'

/**
 * 取込明細を金融機関固有の既定仕訳へ分類する。該当なしは null。
 * 純関数（DB 非依存）。同日利息の有無は ctx.hasSameDayInterest に外出しする。
 */
export function classifyInstitutionEntry(raw: InstitutionRawLike, ctx: InstitutionContext): InstitutionMatch | null {
  // 照合時のみ NFKC 正規化する。邦銀(UFJ 等)の Shift_JIS 明細は半角カナ（ｼﾖｳﾋｾﾞｲ）で出力されるが、
  // toHankaku は半角カナ→全角を行わない。保存値（description・dedup_hash・履歴 pattern）は不変のまま、
  // 照合だけ全角同等に揃える（NFKC は半角カナ＋濁点を合成: ｼﾖｳﾋｾﾞｲ→シヨウヒゼイ）。
  const desc = (raw.description ?? '').normalize('NFKC').trim()

  if (ctx.sourceType === 'bank_shinsei') {
    // 受取利息（入金）。
    if (raw.direction === 'in' && desc.includes(INTEREST)) {
      return { accountName: '事業主借', reason: 'interest_income' }
    }
    // 利息の源泉（出金・国税/地方税）。同日に税引前利息がある時のみ＝利息に対する源泉と確証できる場合に限る。
    // 厳密一致（外国税額控除・国税還付など「国税」を包含する別摘要を源泉と誤らない。新生サンプルの摘要は裸の「国税」/「地方税」）。
    if (raw.direction === 'out' && (desc === '国税' || desc === '地方税') && ctx.hasSameDayInterest(raw.txnDate)) {
      return { accountName: '事業主貸', reason: 'interest_withholding' }
    }
    return null
  }

  if (ctx.sourceType === 'bank_ufj') {
    // 消費税の納付（出金・摘要にシヨウヒゼイ）。UFJ の国税/地方税は対象にしない。
    if (raw.direction === 'out' && desc.includes('シヨウヒゼイ')) {
      return { accountName: '租税公課', reason: 'consumption_tax_payment' }
    }
    return null
  }

  return null
}
