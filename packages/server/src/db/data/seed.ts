import { eq, sql } from 'drizzle-orm'
import { parseCsv } from '@kanean/shared'
import type { DataDb } from '../router.js'
import {
  taxCategories,
  accountCategories,
  statementItems,
  accounts,
  subAccounts,
} from './schema.js'
import { ACCOUNTS_CHART_CSV } from './seed/accountsChart.js'

/**
 * data plane の標準シード（architecture §4.4）。新規ユーザーDB作成時に投入。
 * (1) 税区分マスタ（accounting-spec §2.2）
 * (2) 勘定科目体系（参照チャート → account_categories→statement_items→accounts→sub_accounts）
 */

// (1) 税区分マスタ（情報通信＝第5種を主に使用）。
const TAX_CATEGORIES: Array<typeof taxCategories.$inferInsert> = [
  { code: 'SALE_10_C5', label: '課売 10% 五種', taxability: 'taxable', direction: 'sale', rate: 10, simplifiedCategory: '第5種', adjustment: 'none' },
  { code: 'SALE_8_C5', label: '課売 (軽)8% 五種', taxability: 'taxable', direction: 'sale', rate: 8, simplifiedCategory: '第5種', adjustment: 'none' },
  { code: 'SALE_10_C5_RET', label: '課売-返還 10% 五種', taxability: 'taxable', direction: 'sale', rate: 10, simplifiedCategory: '第5種', adjustment: 'return' },
  { code: 'SALE_8_C5_RET', label: '課売-返還 (軽)8% 五種', taxability: 'taxable', direction: 'sale', rate: 8, simplifiedCategory: '第5種', adjustment: 'return' },
  { code: 'SALE_10_C5_BAD', label: '課売-貸倒 10% 五種', taxability: 'taxable', direction: 'sale', rate: 10, simplifiedCategory: '第5種', adjustment: 'bad_debt' },
  { code: 'SALE_8_C5_BAD', label: '課売-貸倒 (軽)8% 五種', taxability: 'taxable', direction: 'sale', rate: 8, simplifiedCategory: '第5種', adjustment: 'bad_debt' },
  { code: 'PUR_10', label: '課仕 10%', taxability: 'taxable', direction: 'purchase', rate: 10, adjustment: 'none' },
  { code: 'PUR_8', label: '課仕 (軽)8%', taxability: 'taxable', direction: 'purchase', rate: 8, adjustment: 'none' },
  { code: 'PUR_10_RET', label: '課仕-返還 10%', taxability: 'taxable', direction: 'purchase', rate: 10, adjustment: 'return' },
  { code: 'PUR_8_RET', label: '課仕-返還 (軽)8%', taxability: 'taxable', direction: 'purchase', rate: 8, adjustment: 'return' },
  { code: 'NONTAX_SALE', label: '非売', taxability: 'non_taxable', direction: 'sale', rate: 0, adjustment: 'none' },
  { code: 'NONTAX_PUR', label: '非仕', taxability: 'non_taxable', direction: 'purchase', rate: 0, adjustment: 'none' },
  { code: 'OUT', label: '対象外', taxability: 'out_of_scope', direction: 'none', adjustment: 'none' },
  { code: 'OUT_PUR', label: '対象外仕', taxability: 'out_of_scope', direction: 'purchase', adjustment: 'none' },
]

function seedTaxCategories(db: DataDb): void {
  const [{ count }] = db.select({ count: sql<number>`count(*)` }).from(taxCategories).all()
  if (count === 0) db.insert(taxCategories).values(TAX_CATEGORIES).run()
}

// (2) 勘定科目体系 ----------------------------------------------------------

// 分類 → 決算書のセクション（normal_balance 決定の素。accounting-spec §1.2）。
const SECTION_BY_BUNRUI: Record<string, string> = {
  現金及び預金: '流動資産',
  売上債権: '流動資産',
  有価証券: '流動資産',
  棚卸資産: '流動資産',
  その他流動資産: '流動資産',
  諸口: '流動資産',
  有形固定資産: '固定資産',
  無形固定資産: '固定資産',
  投資その他の資産: '固定資産',
  繰延資産: '繰延資産',
  仕入債務: '流動負債',
  その他流動負債: '流動負債',
  固定負債: '固定負債',
  事業主貸: '資本',
  事業主借: '資本',
  資本の部: '資本',
  '売上（収入）金額': '売上',
  '期首商品（製品）棚卸高': '売上原価',
  当期仕入高: '売上原価',
  '期末商品（製品）棚卸高': '売上原価',
  経費: '経費',
  // 繰戻額等（貸倒引当金戻入）＝その他section。所得に**加算**（profitAndLoss otherIncome）。
  繰戻額等: 'その他',
  // 繰入額等（専従者給与・貸倒引当金繰入）＝経費section。所得から**控除**（expenses.total に含む）。
  // ただし様式の㉝経費計には含めず別欄（line_code SENJU/RESERVE_IN で blueReturnStatement が分離）。
  繰入額等: '経費',
}

// 参照チャートの税区分ラベル → 税区分コード。
// チャートは旧標準8%だが、現行標準は10%のため**既定は10%**に寄せる
// （軽減8%は飲食料品・定期新聞のみ。情報通信業の売上は出てこない。簡易課税では仕入の税区分は税額に不影響）。
const TAX_CODE_BY_LABEL: Record<string, string> = {
  対象外: 'OUT',
  対象外仕: 'OUT_PUR',
  '課仕 8%': 'PUR_10',
  '課仕-返還 8%': 'PUR_10_RET',
  '課売 8% 五種': 'SALE_10_C5',
  '課売-返還 8% 五種': 'SALE_10_C5_RET',
  '課売-貸倒 8%': 'SALE_10_C5_BAD',
  非仕: 'NONTAX_PUR',
}

// 決算書科目（statement_items）→ 青色申告決算書 損益ページの様式ボックス line_code。
// 体系は {FORM}.{SECTION}.{LINE}（form-mapping §0）。本シードのスコープは AOIRO.PL.* のみ。
// 集計は「勘定科目 → 決算書科目 → 様式の欄」の3段（reports/blueReturnStatement.ts が読む）。
// ⚠️ 標準32行に名前が無い経費（固定資産除却損・車両費・リース料・支払手数料・研修採用費・
//    新聞図書費・会議費・繰延資産償却）は **NULL のまま** にし、集計側で空欄行（㉕〜㉛）へ
//    sortOrder 順に動的割当する（最後尾は雑費㉜へ overflow）。
// ⚠️ 丸数字・官製欄番号は令和6年分公式様式で要突合（form-mapping §0注記）。本マップは内部 code のみ。
const LINE_CODE_BY_ITEM: Record<string, string> = {
  // 売上・売上原価
  '売上（収入）金額': 'AOIRO.PL.SALES', // ①
  '期首商品（製品）棚卸高': 'AOIRO.PL.OPEN_STOCK', // ②
  仕入金額: 'AOIRO.PL.PURCHASE', // ③
  '期末商品（製品）棚卸高': 'AOIRO.PL.CLOSE_STOCK', // ⑤
  // 標準経費 ⑧〜㉔
  租税公課: 'AOIRO.PL.EXP_TAX', // ⑧
  荷造運賃: 'AOIRO.PL.EXP_PACK', // ⑨
  水道光熱費: 'AOIRO.PL.EXP_UTIL', // ⑩
  旅費交通費: 'AOIRO.PL.EXP_TRAVEL', // ⑪
  通信費: 'AOIRO.PL.EXP_COMM', // ⑫
  広告宣伝費: 'AOIRO.PL.EXP_AD', // ⑬
  接待交際費: 'AOIRO.PL.EXP_ENT', // ⑭
  損害保険料: 'AOIRO.PL.EXP_INS', // ⑮
  修繕費: 'AOIRO.PL.EXP_REPAIR', // ⑯
  消耗品費: 'AOIRO.PL.EXP_SUPPLY', // ⑰
  減価償却費: 'AOIRO.PL.EXP_DEP', // ⑱（§1.3 減価償却の内訳と連動）
  福利厚生費: 'AOIRO.PL.EXP_WELFARE', // ⑲
  給料賃金: 'AOIRO.PL.EXP_SALARY', // ⑳（§1.4 給料の内訳と連動）
  外注工賃: 'AOIRO.PL.EXP_OUTSRC', // ㉑
  利子割引料: 'AOIRO.PL.EXP_INTEREST', // ㉒
  地代家賃: 'AOIRO.PL.EXP_RENT', // ㉓（§1.5 地代家賃の内訳と連動）
  貸倒金: 'AOIRO.PL.EXP_BADDEBT', // ㉔
  雑費: 'AOIRO.PL.EXP_MISC', // ㉜
  // 繰戻・繰入・専従者（㉝経費計には含めず別行で控除/加算）
  貸倒引当金戻入: 'AOIRO.PL.RESERVE_BACK',
  専従者給与: 'AOIRO.PL.SENJU',
  貸倒引当金繰入: 'AOIRO.PL.RESERVE_IN',
}

// 科目名による normal_balance 例外（評価勘定・控除）。
const NAME_EXCEPTIONS: Record<string, 'debit' | 'credit'> = {
  減価償却累計額: 'credit',
  貸倒引当金: 'credit',
  '売上値引・返品': 'debit',
  '仕入値引・返品': 'credit',
}
const CREDIT_SECTIONS = new Set(['流動負債', '固定負債', '資本', '売上'])

function normalBalanceFor(section: string, bunrui: string, accountName: string): 'debit' | 'credit' {
  if (accountName in NAME_EXCEPTIONS) return NAME_EXCEPTIONS[accountName]
  if (bunrui === '事業主貸') return 'debit' // 引出（資本控除だが借方）
  if (bunrui === '繰戻額等') return 'credit' // 戻入＝収益側
  return CREDIT_SECTIONS.has(section) ? 'credit' : 'debit'
}

function seedAccountChart(db: DataDb): void {
  const [{ count }] = db.select({ count: sql<number>`count(*)` }).from(accountCategories).all()
  if (count > 0) return

  const taxIdByLabel = (label: string): number | null => {
    const code = TAX_CODE_BY_LABEL[label.trim()]
    if (!code) return null
    return db.select().from(taxCategories).where(eq(taxCategories.code, code)).all()[0]?.id ?? null
  }

  const rows = parseCsv(ACCOUNTS_CHART_CSV)
  const now = new Date().toISOString()
  const catId = new Map<string, number>()
  const itemId = new Map<string, number>()
  const accId = new Map<string, number>()
  let order = 0

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (r.length < 4) continue
    const reportType = r[0] === '貸借対照表' ? 'BS' : 'PL'
    const bunrui = r[1]
    const itemName = r[2]
    const accountName = r[3]
    const sub = (r[4] ?? '').trim()
    const taxLabel = (r[5] ?? '').trim()
    const section = SECTION_BY_BUNRUI[bunrui] ?? '流動資産'

    const ck = `${reportType}|${bunrui}`
    let cId = catId.get(ck)
    if (cId === undefined) {
      cId = db.insert(accountCategories).values({ reportType, section, name: bunrui, sortOrder: order++ }).returning().all()[0].id
      catId.set(ck, cId)
    }

    const ik = `${ck}|${itemName}`
    let iId = itemId.get(ik)
    if (iId === undefined) {
      iId = db
        .insert(statementItems)
        .values({ categoryId: cId, name: itemName, statementLineCode: LINE_CODE_BY_ITEM[itemName] ?? null, sortOrder: order++ })
        .returning()
        .all()[0].id
      itemId.set(ik, iId)
    }

    const ak = `${ik}|${accountName}`
    let aId = accId.get(ak)
    if (aId === undefined) {
      aId = db
        .insert(accounts)
        .values({
          statementItemId: iId,
          name: accountName,
          normalBalance: normalBalanceFor(section, bunrui, accountName),
          defaultTaxCategoryId: taxIdByLabel(taxLabel),
          isSystem: true,
          isActive: true,
          sortOrder: order++,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all()[0].id
      accId.set(ak, aId)
    }

    if (sub) {
      db.insert(subAccounts)
        .values({
          accountId: aId,
          name: sub,
          defaultTaxCategoryId: taxIdByLabel(taxLabel),
          isActive: true,
          sortOrder: order++,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }
  }
}

/** data plane に標準データを投入する（冪等）。 */
export function seedDataPlane(db: DataDb): void {
  seedTaxCategories(db)
  seedAccountChart(db)
}
