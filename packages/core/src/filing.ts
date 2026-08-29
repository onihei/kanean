import { yen } from '@kanean/shared'
import type {
  Yen,
  BlueStatementReport,
  IncomeTaxReturn,
  ConsumptionTaxReturn,
  FilingInstructionSheet,
  FilingSheetGroup,
  FilingSheetItem,
  FilingItemKind,
} from '@kanean/shared'
import { BS_ASSET_ROW_LABELS, BS_LIAB_ROW_LABELS } from '@kanean/shared'

/**
 * 入力指示書の射影（filing spec / docs/filing-corner-mapping.md）。
 *
 * tax-return の組成済み organ（青色決算書・所得税・消費税）を、確定申告書等作成コーナーの
 * 画面順（A 決算書 → B 所得税 → C 消費税）の転記項目列へ写す。**新しい計算はしない**——
 * 金額はすべて入力 organ の値そのままで、合成すら行わない（同一組成なら申告書 PDF と必ず一致する）。
 *
 * 項目種別: input=転記する / select=選ぶ / verify=コーナーの自動計算欄（入力せず一致を確認）。
 * verify の不一致は転記ミスか前提ずれなので、手順側はその場で停止して報告する。
 */

export interface FilingProjectionInput {
  fiscalYearId: number
  /** 年分（暦年）。 */
  year: number
  blueStatement: BlueStatementReport
  incomeTax: IncomeTaxReturn
  consumption: ConsumptionTaxReturn
  /** 税率別の税込課税売上（C2 転記用。taxSalesSummary の net+tax）。 */
  consumptionGrossByRate: { rate: number; gross: Yen }[]
}

const DEPRECIATION_METHOD_LABELS: Readonly<Record<string, string>> = {
  straight_line: '定額法',
  declining_balance: '定率法',
  old_straight_line: '旧定額法',
  old_declining_balance: '旧定率法',
  lump_sum: '一括償却資産（3年均等）',
  minor_special: '中小企業者の少額特例',
}

const money = (kind: FilingItemKind, field: string, amount: Yen, note?: string): FilingSheetItem => ({
  kind,
  field,
  value: String(amount),
  amount,
  note: note ?? null,
})

const text = (kind: FilingItemKind, field: string, value: string, note?: string): FilingSheetItem => ({
  kind,
  field,
  value,
  amount: null,
  note: note ?? null,
})

const CHECKSUM_NOTE = '★検算: 作成コーナーの表示額と1円単位で一致すること。不一致なら送信へ進まず差分を報告する'

export function buildFilingInstructionSheet(input: FilingProjectionInput): FilingInstructionSheet {
  const { blueStatement: bs, incomeTax: it, consumption: ct } = input
  const pl = bs.pl
  const groups: FilingSheetGroup[] = []

  // --- A1 種類選択 -----------------------------------------------------------
  groups.push({
    id: 'A1',
    screen: '決算書コーナー: 種類選択',
    items: [
      text('select', '提出方法', 'e-Taxで送信'),
      text('select', '決算書の種類', '青色申告決算書（一般用）'),
    ],
  })

  // --- A2 損益（月別売上・仕入 / 棚卸） --------------------------------------
  const a2: FilingSheetItem[] = []
  bs.monthly.rows.forEach((r, i) => {
    a2.push(
      money('input', `${r.month}月 売上（収入）金額`, r.sales,
        i === 0 ? '家事消費等・雑収入は月別売上に含めて計上している（専用欄は空欄のまま）' : undefined),
    )
  })
  for (const r of bs.monthly.rows) a2.push(money('input', `${r.month}月 仕入金額`, r.purchases))
  a2.push(money('input', `${pl.openStock.box} ${pl.openStock.label}`, pl.openStock.amount))
  a2.push(money('input', `${pl.closeStock.box} ${pl.closeStock.label}`, pl.closeStock.amount))
  a2.push(money('verify', `${pl.sales.box} ${pl.sales.label}`, pl.sales.amount))
  a2.push(money('verify', `${pl.purchase.box} ${pl.purchase.label}`, pl.purchase.amount))
  groups.push({ id: 'A2', screen: '決算書コーナー: 損益計算書（月別売上・仕入）', items: a2 })

  // --- A3 損益（経費） -------------------------------------------------------
  const a3: FilingSheetItem[] = []
  for (const e of pl.expenses) {
    if (e.code === 'AOIRO.PL.EXP_DEP') {
      a3.push(money('verify', `${e.box} ${e.label}`, e.amount, 'A4 の減価償却資産の入力から自動計算'))
      continue
    }
    if (e.amount === 0) continue // 金額のない経費欄は空欄のまま
    const isBlank = e.code.startsWith('AOIRO.PL.EXP_BLANK_')
    a3.push(money('input', `${e.box} ${e.label}`, e.amount, isBlank ? '空欄行に科目名を追加して入力' : undefined))
  }
  if (pl.reserveBack.amount !== 0) a3.push(money('input', pl.reserveBack.label, pl.reserveBack.amount))
  if (pl.senju.amount !== 0) a3.push(money('verify', pl.senju.label, pl.senju.amount, 'A4 の専従者給与の内訳から自動転記'))
  if (pl.reserveIn.amount !== 0) a3.push(money('verify', pl.reserveIn.label, pl.reserveIn.amount, 'A4 の貸倒引当金の計算から自動転記'))
  a3.push(money('verify', `${pl.expenseTotal.box} ${pl.expenseTotal.label}`, pl.expenseTotal.amount))
  a3.push(money('verify', `${pl.netBeforeAdjust.box} ${pl.netBeforeAdjust.label}`, pl.netBeforeAdjust.amount))
  groups.push({ id: 'A3', screen: '決算書コーナー: 損益計算書（経費）', items: a3 })

  // --- A4 内訳ページ ---------------------------------------------------------
  const a4: FilingSheetItem[] = []
  for (const d of bs.depreciation.rows) {
    const at = (field: string) => `減価償却資産「${d.name}」 ${field}`
    a4.push(text('input', at('名称'), d.name))
    a4.push(text('input', at('取得年月'), d.acquiredDate ?? '（未設定）'))
    a4.push(money('input', at('取得価額'), d.acquisitionCost))
    a4.push(text('input', at('償却方法'), DEPRECIATION_METHOD_LABELS[d.depreciationMethod] ?? d.depreciationMethod))
    if (d.usefulLife != null) a4.push(text('input', at('耐用年数'), String(d.usefulLife)))
    a4.push(text('input', at('事業専用割合'), `${d.businessUseRatio}%`))
    a4.push(money('verify', at('本年分の必要経費算入額'), d.businessAmount))
    a4.push(money('verify', at('未償却残高（期末）'), d.closingBookValue))
  }
  if (bs.depreciation.rows.length > 0) {
    a4.push(money('verify', '減価償却費 必要経費算入額 合計（損益⑱）', bs.depreciation.businessAmountTotal))
  }
  for (const r of bs.salary.rows) {
    a4.push(money('input', `給料賃金「${r.name}」支給額`, r.amount, '源泉徴収税額は本システム未内訳（給与実務の記録から補完）'))
  }
  if (bs.salary.rows.length > 0) a4.push(money('verify', '給料賃金 合計（損益⑳）', bs.salary.total))
  for (const r of bs.senju.rows) a4.push(money('input', `専従者給与「${r.name}」支給額`, r.amount))
  if (bs.senju.rows.length > 0) a4.push(money('verify', '専従者給与 合計', bs.senju.total))
  for (const r of bs.rent.rows) {
    a4.push(money('input', `地代家賃「${r.name}」必要経費算入額`, r.amount, '賃借料総額（家事按分前）は契約書等から補完'))
  }
  if (bs.rent.rows.length > 0) a4.push(money('verify', '地代家賃 合計（損益㉓）', bs.rent.total))
  const ra = bs.reserveAllowance
  if (ra.total !== 0) {
    a4.push(money('input', '貸倒引当金: 一括評価による貸金の合計額（②）', ra.grossReceivables))
    a4.push(money('verify', '貸倒引当金: 繰入限度額（③）', ra.limit, `繰入率 ${ra.rate * 100}%`))
    a4.push(money('input', '貸倒引当金: 本年分繰入額（⑤）', ra.total))
  }
  groups.push({ id: 'A4', screen: '決算書コーナー: 内訳（減価償却・給料・専従者・地代家賃・貸倒引当金）', items: a4 })

  // --- A5 青色申告特別控除 ---------------------------------------------------
  const limitLabel =
    bs.summary.deductionLimit === 650_000 ? '65万円'
    : bs.summary.deductionLimit === 550_000 ? '55万円'
    : bs.summary.deductionLimit === 100_000 ? '10万円'
    : '適用なし'
  groups.push({
    id: 'A5',
    screen: '決算書コーナー: 青色申告特別控除',
    items: [
      text('select', '青色申告特別控除の区分', limitLabel, bs.summary.basis),
      money('verify', `${pl.incomeBeforeDeduction.box} ${pl.incomeBeforeDeduction.label}`, pl.incomeBeforeDeduction.amount),
      money('verify', `${pl.blueDeduction.box} ${pl.blueDeduction.label}`, pl.blueDeduction.amount),
      money('verify', `${pl.income.box} ${pl.income.label}`, pl.income.amount),
    ],
  })

  // --- A6 貸借対照表 ---------------------------------------------------------
  const a6: FilingSheetItem[] = []
  const bsSheet = bs.balanceSheet
  for (const r of bsSheet.assets) {
    const label = r.label ?? BS_ASSET_ROW_LABELS[r.row] ?? `資産 行${r.row}`
    a6.push(money('input', `資産「${label}」期首`, r.opening))
    a6.push(money('input', `資産「${label}」期末`, r.closing))
  }
  for (const r of bsSheet.liabilities) {
    const label = r.label ?? BS_LIAB_ROW_LABELS[r.row] ?? `負債・資本 行${r.row}`
    if (r.row === 24 && !r.label) {
      // 青色申告特別控除前の所得金額（損益から自動転記）
      a6.push(money('verify', `負債・資本「${label}」期末`, r.closing))
      continue
    }
    a6.push(money('input', `負債・資本「${label}」期首`, r.opening))
    a6.push(money('input', `負債・資本「${label}」期末`, r.closing))
  }
  a6.push(money('verify', '資産の部 合計（期首）', bsSheet.assetTotal.opening))
  a6.push(money('verify', '資産の部 合計（期末）', bsSheet.assetTotal.closing))
  a6.push(money('verify', '負債・資本の部 合計（期首）', bsSheet.liabTotal.opening))
  a6.push(money('verify', '負債・資本の部 合計（期末）', bsSheet.liabTotal.closing))
  groups.push({ id: 'A6', screen: '決算書コーナー: 貸借対照表', items: a6 })

  // --- B1 収入・所得（事業） -------------------------------------------------
  groups.push({
    id: 'B1',
    screen: '所得税コーナー: 収入金額・所得金額（事業・営業等）',
    items: [
      money('verify', '収入金額（営業等）', it.businessRevenue, '決算書コーナーからの引継ぎで自動設定'),
      money('verify', '所得金額（営業等）', it.businessIncome),
    ],
  })

  // --- B2 所得控除 -----------------------------------------------------------
  const inp = it.inputs
  groups.push({
    id: 'B2',
    screen: '所得税コーナー: 所得控除',
    items: [
      money('input', '社会保険料控除', yen(inp.socialInsurance), '支払先・金額の内訳はコーナーで入力'),
      money('input', '生命保険料控除', yen(inp.lifeInsurance), '控除証明書の区分ごとにコーナーで入力'),
      money('input', '医療費控除', yen(inp.medical), '医療費の明細はコーナーで別途入力'),
      money('input', '配偶者（特別）控除・扶養控除', yen(inp.spouseDependents), '対象者の氏名等はコーナーで入力'),
      money('input', 'その他の所得控除', yen(inp.otherDeductions)),
      money('verify', '基礎控除', yen(inp.basicDeduction), 'コーナーが所得から自動判定'),
      money('verify', '所得控除 合計', it.totalDeductions),
    ],
  })

  // --- B3 所得の内訳・源泉・予定納税 -----------------------------------------
  const b3: FilingSheetItem[] = []
  for (const r of it.incomeDetail) {
    b3.push(money('input', `所得の内訳「${r.payerName}」収入金額`, r.revenue))
    b3.push(money('input', `所得の内訳「${r.payerName}」源泉徴収税額`, r.withholding))
  }
  b3.push(money('verify', '源泉徴収税額 合計', it.withholding))
  b3.push(money('input', '予定納税額（第1期分・第2期分の合計）', it.estimatedPrepaid))
  groups.push({ id: 'B3', screen: '所得税コーナー: 所得の内訳・源泉徴収・予定納税', items: b3 })

  // --- B4 計算結果確認（★検算） ---------------------------------------------
  const b4: FilingSheetItem[] = [
    money('verify', '課税される所得金額', it.taxableIncome),
    money('verify', '所得税及び復興特別所得税の額', it.taxWithSurtax),
  ]
  if (it.payableRaw >= 0) b4.push(money('verify', '納める税金（申告納税額）', it.payable, CHECKSUM_NOTE))
  else b4.push(money('verify', '還付される税金', it.refund, CHECKSUM_NOTE))
  groups.push({ id: 'B4', screen: '所得税コーナー: 計算結果確認', items: b4 })

  // --- B5/B6 住民税等・基本情報 ----------------------------------------------
  groups.push({
    id: 'B6',
    screen: '所得税コーナー: 住民税等・住所氏名・マイナンバー',
    items: [
      text('input', '住民税等に関する事項・住所・氏名・マイナンバー', '（利用者自身の情報を入力）',
        '帳簿データ外のため指示書は値を持たない'),
    ],
  })

  // --- C 消費税（簡易課税） --------------------------------------------------
  const consumptionApplicable = ct.applicable
  if (consumptionApplicable) {
    groups.push({
      id: 'C1',
      screen: '消費税コーナー: 条件判定',
      items: [
        text('select', '簡易課税制度の適用', '適用する'),
        text('select', '事業区分', `第${ct.businessCategory}種`, `みなし仕入率 ${ct.deemedRate * 100}%`),
      ],
    })
    const c2: FilingSheetItem[] = []
    for (const g of input.consumptionGrossByRate) {
      c2.push(money('input', `課税売上高（税込・税率${g.rate}%）`, g.gross))
    }
    for (const r of ct.baseRows) {
      c2.push(money('verify', `課税標準額（税率${r.rate}%）`, r.taxBase,
        '千円未満切捨て。行単位丸めとの差が出た場合は停止して報告'))
    }
    c2.push(money('verify', '課税標準額 合計', ct.taxBaseTotal))
    if (ct.returnNational !== 0) c2.push(money('input', '返還等対価に係る税額（国税）', ct.returnNational))
    if (ct.badDebtNational !== 0) c2.push(money('input', '貸倒れに係る税額（国税）', ct.badDebtNational))
    groups.push({ id: 'C2', screen: '消費税コーナー: 売上（収入）金額等の入力', items: c2 })
    groups.push({
      id: 'C3',
      screen: '消費税コーナー: 中間納付',
      items: [
        money('input', '中間納付税額', ct.midPaid, '本システム未追跡。中間納付があれば実額を入力し、検算差分として報告'),
      ],
    })
    groups.push({
      id: 'C4',
      screen: '消費税コーナー: 計算結果確認',
      items: [
        money('verify', '差引税額（国税）', ct.national, CHECKSUM_NOTE),
        money('verify', '地方消費税額', ct.local, CHECKSUM_NOTE),
        money('verify', '納付税額 合計', ct.payable, CHECKSUM_NOTE),
      ],
    })
  }

  return {
    fiscalYearId: input.fiscalYearId,
    year: input.year,
    groups,
    checksum: {
      incomeTaxPayable: it.payable,
      incomeTaxRefund: it.refund,
      consumptionNational: consumptionApplicable ? ct.national : yen(0),
      consumptionLocal: consumptionApplicable ? ct.local : yen(0),
      consumptionTotal: consumptionApplicable ? ct.payable : yen(0),
    },
    consumptionApplicable,
    disclaimer:
      '本指示書は confirmed 仕訳からの参考値であり、提出可否を判定するものではありません。' +
      '転記値は指示書のみを源とし、送信前に作成コーナーの計算結果と検算のうえ、最終確認は税理士に委ねてください。',
  }
}
