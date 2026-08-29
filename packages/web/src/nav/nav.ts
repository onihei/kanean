/** サイドナビの構造定義。 */
import { OPENABLE_TABS } from '@kanean/shared'

export type TabKey =
  | 'home'
  | 'services'
  | 'raw'
  | 'reconcile'
  | 'settle'
  | 'entry'
  | 'journal'
  | 'trial'
  | 'pl'
  | 'bs'
  | 'trend'
  | 'dept'
  | 'proration'
  | 'assets'
  | 'tax'
  | 'incometax'
  | 'filing'
  | 'closing'
  | 'invoices'
  | 'settings'

// ディープリンクで開ける画面（@kanean/shared のプロセス間契約）は TabKey の部分集合であることを
// コンパイル時に固定する（issue #167。タブを改名したら desktop/MCP 側の契約も一緒に見直す）。
OPENABLE_TABS satisfies readonly TabKey[]

export interface NavItem {
  key: TabKey
  label: string
}
export interface NavGroup {
  /** 空文字はグループ見出しなし（ホーム単独）。 */
  group: string
  items: NavItem[]
}

export const NAV: NavGroup[] = [
  { group: '', items: [{ key: 'home', label: 'ホーム' }] },
  {
    group: '自動で仕訳',
    items: [
      { key: 'services', label: '連携サービス' },
      { key: 'raw', label: '取込明細' },
      { key: 'reconcile', label: '残高突合' },
      { key: 'settle', label: '名寄せ（振替）' },
    ],
  },
  { group: '手動で仕訳', items: [{ key: 'entry', label: '仕訳入力' }] },
  { group: '会計帳簿', items: [{ key: 'journal', label: '仕訳帳' }] },
  {
    group: '集計・レポート',
    items: [
      { key: 'trial', label: '試算表' },
      { key: 'pl', label: '損益計算書' },
      { key: 'bs', label: '貸借対照表' },
      { key: 'trend', label: '推移表' },
      { key: 'dept', label: '部門別' },
    ],
  },
  {
    group: '決算・申告',
    items: [
      { key: 'proration', label: '家事按分' },
      { key: 'assets', label: '固定資産' },
      { key: 'tax', label: '消費税' },
      { key: 'incometax', label: '所得税申告' },
      { key: 'filing', label: '確定申告' },
      { key: 'closing', label: '決算整理' },
    ],
  },
  { group: '請求書', items: [{ key: 'invoices', label: '請求書' }] },
  { group: '各種設定', items: [{ key: 'settings', label: '事業者・開始残高・マスタ' }] },
]
