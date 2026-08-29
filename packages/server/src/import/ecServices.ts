import { desc, eq } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { importBatches, rawTransactions } from '../db/data/schema.js'
import { getOpenFiscalYear } from '../db/lookups.js'
import { listServices } from '../masters/services.js'
import { getBusinessSettings } from '../masters/businessSettings.js'

/**
 * 連携サービス一覧（[ec-import-api.md §1]）。レジストリは本体DBが正（口座マスタ/F-IMP-8・カタログ駆動）。
 * EC連携サービス＝カタログ kind='ec' で登録された補助科目（registerService が作成・amazon/楽天）。
 * スキルはこれで「どのサービス(source)を・どの口座(accountRef)に・いつ以降(fetchSince)」取り込むかを決める。
 */

/**
 * 連携チャネル共通の識別子とタイムライン（HTTP JSON のキーは docs（[ec-import-api.md] /
 * [bank-import-api.md]）が正＝base 化してもキーは変えない）。kind 毎の投入先・付替えの注記は
 * 各拡張 interface に置く（issue #125 = B13）。
 */
interface LinkedChannelBase {
  /** import_source_type / カタログ key（'amazon' / 'bank_ufj' 等）。巡回対象・履歴/学習キー（lookup の source）。 */
  source: string
  /** linked_account_ref（'amazon-1' / 'bank_ufj-1' 等）。journal-candidates の投入先（補助科目を一意に指す）。 */
  accountRef: string
  displayName: string
  lastImportedAt: string | null
  /** 差分の起点＝max(直近取込済み txn_date（EC は order_date）, open 期間 start)。これ以降を巡回する。 */
  fetchSince: string | null
}

/**
 * EC連携サービス（未払金チャネル・カタログ kind='ec'）。投入先は POST /skill/ec/journal-candidates。
 * 旧名 LinkedService は masters/services.ts の同名別物（GET /api/services の型）と衝突していたため
 * LinkedBankAccount / LinkedCardAccount の命名に揃えて改名（issue #125）。
 */
export interface LinkedEcService extends LinkedChannelBase {
  payableSubAccount: string // "未払金 / Amazon"
}

/**
 * 銀行口座（普通預金）の連携（[bank-import-api.md] / カタログ kind='bank'）。スキルトラックで巡回・取込する。
 * EC（未払金チャネル）と違い貸方=普通預金が一脚なので投入先は POST /skill/bank/journal-candidates。
 */
export interface LinkedBankAccount extends LinkedChannelBase {
  depositSubAccount: string // "普通預金 / 三菱UFJ銀行"
}

/**
 * クレジットカード（未払金チャネル）の連携（カタログ kind='card'）。スキルトラックで巡回・取込する。
 * 投入先は **銀行トラックと同じ** POST /skill/bank/journal-candidates（importer の一脚は accountRef の補助科目で汎用
 * ＝普通預金でなく未払金が一脚に立つ）。カード利用は direction='out' で 借)費用/貸)未払金(card)、
 * Amazon/楽天等の連携EC利用は treatment='settlement'＋counterSubAccountRef で 借)未払金(EC)/貸)未払金(card)（付替え・[csv-format §4.3]）。
 */
export interface LinkedCardAccount extends LinkedChannelBase {
  payableSubAccount: string // "未払金 / 三菱UFJ-VISA"
}

export interface LinkedServicesResult {
  openFiscalYear: { id: number; startDate: string; endDate: string } | null
  /** 取込時に証憑（証跡）を保存するか（電帳法・電子取引データ保存。business_settings.evidence_capture）。スキルが分岐に使う。 */
  evidenceCapture: boolean
  /** EC連携サービス（未払金チャネル）。投入先＝POST /skill/ec/journal-candidates。 */
  services: LinkedEcService[]
  /** 銀行口座（普通預金）。投入先＝POST /skill/bank/journal-candidates（[bank-import-api.md]）。 */
  bankAccounts: LinkedBankAccount[]
  /** クレジットカード（未払金チャネル）。投入先＝POST /skill/bank/journal-candidates（一脚＝未払金。[bank-import-api.md]）。 */
  cards: LinkedCardAccount[]
}

/** account_ref の取込タイムライン（最終取込時刻と差分起点）。EC/銀行で共通（order_date/txn_date とも raw.txn_date）。 */
function accountTimeline(db: DataDb, accountRef: string, start: string | null): { lastImportedAt: string | null; fetchSince: string | null } {
  const lastBatch = db
    .select({ at: importBatches.importedAt })
    .from(importBatches)
    .where(eq(importBatches.accountRef, accountRef))
    .orderBy(desc(importBatches.importedAt))
    .all()[0]
  const lastTxn = db
    .select({ d: rawTransactions.txnDate })
    .from(rawTransactions)
    .where(eq(rawTransactions.accountRef, accountRef))
    .orderBy(desc(rawTransactions.txnDate))
    .all()[0]
  // 差分起点: 直近取込済み取引日と open 期間 start の大きい方（同日は再取得→dedup で吸収）。
  let fetchSince: string | null = start
  if (lastTxn?.d && (!start || lastTxn.d > start)) fetchSince = lastTxn.d
  return { lastImportedAt: lastBatch?.at ?? null, fetchSince }
}

export function listLinkedServices(db: DataDb): LinkedServicesResult {
  const open = getOpenFiscalYear(db)
  const openInfo = open ? { id: open.id, startDate: open.startDate, endDate: open.endDate } : null
  const start = openInfo?.startDate ?? null
  const evidenceCapture = getBusinessSettings(db).evidenceCapture
  const all = listServices(db)

  // kind 毎の差分は補助科目フィールド名（payable/deposit）だけ。共通部を1回で組む。
  const base = (s: (typeof all)[number]): LinkedChannelBase => ({
    source: s.serviceKey,
    accountRef: s.accountRef,
    displayName: s.label ?? s.name,
    ...accountTimeline(db, s.accountRef, start),
  })
  const subName = (s: (typeof all)[number]) => `${s.accountName} / ${s.name}`

  const services: LinkedEcService[] = all
    .filter((s) => s.kind === 'ec')
    .map((s) => ({ ...base(s), payableSubAccount: subName(s) }))

  const bankAccounts: LinkedBankAccount[] = all
    .filter((s) => s.kind === 'bank')
    .map((s) => ({ ...base(s), depositSubAccount: subName(s) }))

  const cards: LinkedCardAccount[] = all
    .filter((s) => s.kind === 'card')
    .map((s) => ({ ...base(s), payableSubAccount: subName(s) }))

  return { openFiscalYear: openInfo, evidenceCapture, services, bankAccounts, cards }
}
