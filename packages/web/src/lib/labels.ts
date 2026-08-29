/** 画面共通のラベル辞書・選択肢定数。 */
import type { AppMode, TaxReturnInputsView } from '../api.js'

/**
 * アプリモードの選択肢（初回選択 ModeSetup と設定 AppModePanel で共用。名称は app-mode spec）。
 * label はモード名、action は初回選択で「行為」として聞くときの見出し。
 */
export const APP_MODE_CHOICES: { mode: AppMode; label: string; action: string; detail: string }[] = [
  {
    mode: 'personal',
    label: 'じぶんの帳簿',
    action: '自分の帳簿をつける',
    detail: '帳簿は1冊だけ。起動するとそのまま自分の帳簿が開きます。帳簿の切替・作成は表示しません。',
  },
  {
    mode: 'office',
    label: '事務所',
    action: '複数の事業者の帳簿を預かる',
    detail: '顧問先ごとに帳簿を持てます。起動のたびに、どの顧問先の帳簿を開くかを必ず選んでから始めます。',
  },
]

/** 連携サービスの取込元ラベル（取込明細の表示用。サーバ services/catalog と同じ key 空間）。 */
export const SOURCES = [
  { value: 'bank_ufj', label: '三菱UFJ銀行' },
  { value: 'bank_shinsei', label: '新生銀行' },
  { value: 'card_mufg_visa', label: '三菱UFJ-VISA' },
  { value: 'amazon', label: 'Amazon' },
  { value: 'rakuten', label: '楽天市場' },
]

export const SOURCE_LABELS: Record<string, string> = {
  manual: '手入力',
  import: '取込',
  auto_rule: '自動ルール',
  auto_institution: '自動仕訳(金融機関)',
  depreciation: '減価償却',
  proration: '家事按分',
  invoice: '請求',
  opening: '開始残高',
}
export const sourceLabel = (s: string) => SOURCE_LABELS[s] ?? s

export const RAW_STATUS_LABEL: Record<string, string> = { pending: '未仕訳', journalized: '仕訳済', ignored: '除外' }
export const RAW_LIST_LIMIT = 500 // server LIST_LIMIT と一致（truncated 表示用）

export const ADJ_LABEL: Record<string, string> = { none: '通常', return: '返還', bad_debt: '貸倒' }

export const KIND_LABEL: Record<number, string> = { 1: '第1種', 2: '第2種', 3: '第3種', 4: '第4種', 5: '第5種', 6: '第6種' }

export const DEDUCTION_FIELDS: { key: keyof TaxReturnInputsView; label: string }[] = [
  { key: 'basicDeduction', label: '基礎控除' },
  { key: 'socialInsurance', label: '社会保険料控除' },
  { key: 'lifeInsurance', label: '生命保険料控除' },
  { key: 'medical', label: '医療費控除' },
  { key: 'spouseDependents', label: '配偶者・扶養控除' },
  { key: 'otherDeductions', label: 'その他の所得控除' },
  { key: 'estimatedPrepaid', label: '予定納税額' },
]

export const METHOD_LABELS: Record<string, string> = {
  straight_line: '定額法',
  declining_balance: '定率法',
  lump_sum: '一括償却',
  minor_special: '少額特例',
}
export const methodLabel = (m: string) => METHOD_LABELS[m] ?? m

export const DOC_STATUS_LABEL: Record<string, string> = { draft: '下書き', issued: '起票済', collected: '入金済', void: '無効' }

/** 自動仕訳ルールのラベル。 */
export const DIRECTION_LABELS: Record<string, string> = { any: '両方', in: '入金', out: '出金' }
export const FIELD_LABELS: Record<string, string> = { description: '摘要', amount: '金額', source: '取込元' }
export const OP_LABELS: Record<string, string> = { contains: '含む', equals: '一致', regex: '正規表現', range: '金額範囲' }
