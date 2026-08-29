/**
 * 各種設定: 事業者設定・開始残高・マスタ（取引先/補助科目/部門/品目/タグ/自動仕訳ルール）・データ管理を集約。
 * パネル本体は components/（settings/ 配下含む）と MastersPanels に分割済み（issue #153）。
 * ここは SETTINGS_TABS 定義＋サブタブルータのみ。
 */
import { COLORS } from '../lib/styles.js'
import { useEffect, useState } from 'react'
import { api, type AppMode, type BookInfo, type OpeningBalancesResponse } from '../api.js'
import { formatHash } from '../nav/route.js'
import { NoYear } from '../components/common.js'
import { BusinessSettingsPanel } from '../components/BusinessSettingsPanel.js'
import { AiLinkPanel } from '../components/AiLinkPanel.js'
import { AcquisitionLoginsPanel } from '../components/AcquisitionLoginsPanel.js'
import { ClassificationPolicyPanel } from '../components/ClassificationPolicyPanel.js'
import { AppModePanel } from '../components/settings/AppModePanel.js'
import { BooksPanel } from '../components/settings/BooksPanel.js'
import { DataManagementPanel } from '../components/settings/DataManagementPanel.js'
import { OpeningBalancesPanel } from './OpeningBalancesPanel.js'
import {
  CounterpartiesPanel,
  SubAccountsPanel,
  DepartmentsPanel,
  ItemsPanel,
  TagsPanel,
  RulesPanel,
} from './MastersPanels.js'

export type SettingsKey =
  | 'business'
  | 'opening'
  | 'counterparties'
  | 'subAccounts'
  | 'departments'
  | 'items'
  | 'tags'
  | 'rules'
  | 'books'
  | 'mode'
  | 'data'
  | 'ai'

const SETTINGS_TABS: { key: SettingsKey; label: string }[] = [
  { key: 'business', label: '事業者設定' },
  { key: 'opening', label: '開始残高' },
  { key: 'counterparties', label: '取引先' },
  { key: 'subAccounts', label: '補助科目' },
  { key: 'departments', label: '部門' },
  { key: 'items', label: '品目' },
  { key: 'tags', label: 'タグ' },
  { key: 'rules', label: '自動仕訳ルール' },
  { key: 'books', label: '帳簿' },
  { key: 'mode', label: 'アプリモード' },
  { key: 'data', label: 'データ管理' },
  { key: 'ai', label: 'Claude Desktop 連携' },
]

export function SettingsTab({
  mode,
  section,
  onBooksChanged,
  onModeChanged,
}: {
  mode: AppMode
  /** URL のセクションセグメント（`#settings/<section>`・未検証文字列）。未指定・未知は事業者設定。 */
  section?: string
  onBooksChanged: (books: BookInfo[]) => void
  onModeChanged: (mode: AppMode) => void
}) {
  // セクションは URL が単一の真実源（issue #136）。未知の値は既定へ倒す＝壊れたリンクで白画面にしない。
  const sub: SettingsKey = SETTINGS_TABS.some((t) => t.key === section) ? (section as SettingsKey) : 'business'
  return (
    <>
      <h2 style={{ margin: '0 0 12px' }}>各種設定</h2>
      <nav style={{ display: 'flex', gap: 8, margin: '0 0 1rem', flexWrap: 'wrap' }}>
        {SETTINGS_TABS.map((t) => (
          <a
            key={t.key}
            href={formatHash({ tab: 'settings', settingsSection: t.key })}
            className={sub === t.key ? 'sub-tab active' : 'sub-tab'}
          >
            {t.label}
          </a>
        ))}
      </nav>
      {sub === 'business' && <BusinessSettingsPanel />}
      {sub === 'opening' && <OpeningBalancesSection />}
      {sub === 'counterparties' && <CounterpartiesPanel />}
      {sub === 'subAccounts' && <SubAccountsPanel />}
      {sub === 'departments' && <DepartmentsPanel />}
      {sub === 'items' && <ItemsPanel />}
      {sub === 'tags' && <TagsPanel />}
      {sub === 'rules' && <RulesPanel />}
      {sub === 'books' && <BooksPanel mode={mode} onChanged={onBooksChanged} />}
      {sub === 'mode' && (
        <AppModePanel
          mode={mode}
          onChanged={onModeChanged}
        />
      )}
      {sub === 'data' && <DataManagementPanel onBooksChanged={onBooksChanged} />}
      {sub === 'ai' && (
        <>
          <AiLinkPanel />
          <ClassificationPolicyPanel />
          <AcquisitionLoginsPanel />
        </>
      )}
    </>
  )
}

/** 開始残高（青色決算書4ページ目 貸借の期首列を駆動）。設定内では元帳遷移なし。 */
function OpeningBalancesSection() {
  const [data, setData] = useState<OpeningBalancesResponse | null>(null)
  const [err, setErr] = useState('')
  const reload = () => {
    api.openingBalances().then(setData).catch((e) => setErr(String(e)))
  }
  useEffect(reload, [])
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!data) return <NoYear />
  return (
    <OpeningBalancesPanel
      balances={data.balances}
      accounts={data.accounts}
      subAccounts={data.subAccounts}
      totals={data.totals}
      onChange={reload}
    />
  )
}
