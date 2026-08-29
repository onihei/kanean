import { COLORS, selectableRow } from '../lib/styles.js'
import { useState, useEffect } from 'react'
import type { DateScope } from '../lib/format.js'
import { Msg, okMsg, errMsg } from '../components/common.js'
import { AcquisitionPanel } from '../components/AcquisitionPanel.js'
import { AddServiceForm } from '../components/AddServiceForm.js'
import { CsvImportPanel } from '../components/CsvImportPanel.js'
import { DraftListPanel } from './drafts/DraftReview.js'
import { useRefreshOnFocus } from '../lib/hooks.js'
import type { MsgState } from '../components/common.js'
import { api } from '../api.js'
import type { Account, TaxCategory, LinkedService, ServiceCatalogEntry } from '../api.js'
import { navigate } from '../nav/route.js'

/**
 * 連携サービス（自動で仕訳の起点）。まずサービスを登録し、サービス毎に取込・仕訳確認する。
 * 実体は「取込口座の補助科目」（サーバ /services）。CSV取込は組込3形式＋ユーザー定義フォーマット、
 * amazon/rakuten は将来スキル/内部IF。先頭の「確認待ち（全件）」は手入力・名寄せ等を含む全 draft を見る導線。
 * draft レビューの実体は pages/drafts/DraftReview.tsx、CSV 取込・サービス登録フォームは
 * components/ に分割済み（issue #152）。ここは一覧シェル（サービス選択＋詳細の出し分け）のみ。
 */

const KIND_LABEL: Record<string, string> = { bank: '銀行', card: 'カード', ec: 'EC' }

const EMPTY_BOX: React.CSSProperties = { border: `1px dashed ${COLORS.border}`, borderRadius: 8, padding: 32, textAlign: 'center', color: COLORS.muted, margin: '1rem 0' }

const rowStyle = (active: boolean): React.CSSProperties => ({
  ...selectableRow(active),
  display: 'block',
  marginBottom: 4,
})

export function ServicesTab({
  fiscalYear,
  selectedSubId,
}: {
  fiscalYear: DateScope
  /** 選択中サービスの subAccountId（URL `#services/<subAccountId>` 由来・issue #250）。無指定は確認待ち（全件）。 */
  selectedSubId?: number
}) {
  const [services, setServices] = useState<LinkedService[]>([])
  const [catalog, setCatalog] = useState<ServiceCatalogEntry[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [taxCats, setTaxCats] = useState<TaxCategory[]>([])
  const [allDraftCount, setAllDraftCount] = useState<number | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [msg, setMsg] = useState<MsgState>(null)
  // 選択は URL が真実源（#136 の設定セクションと同じ）。null = 確認待ち（全件）/ else subAccountId。
  const selectedId = selectedSubId ?? null
  const select = (id: number | null) => navigate({ tab: 'services', serviceSubId: id ?? undefined })

  const reloadServices = () => api.services().then(setServices).catch((e) => setMsg(errMsg(e)))
  const reloadAllCount = () => api.drafts().then((d) => setAllDraftCount(d.length)).catch(() => setAllDraftCount(null))
  // confirm/取込後に左一覧バッジ（サービス毎）と全件カウントの両方を追随させる。
  const reloadCounts = () => {
    reloadServices()
    reloadAllCount()
  }

  // 帳簿は Claude Desktop 側からも変わる（科目を当てる・取込が完了する）。
  // 前面に戻ったら件数を読み直す（ここを更新しないと、左の確認待ちバッジだけ古い数が残る）。
  useRefreshOnFocus(reloadCounts)

  useEffect(() => {
    reloadServices()
    reloadAllCount()
    api.serviceCatalog().then(setCatalog).catch((e) => setMsg(errMsg(e, 'サービス候補の取得に失敗しました')))
    api.accounts().then(setAccounts).catch((e) => setMsg(errMsg(e)))
    api.taxCategories().then(setTaxCats).catch((e) => setMsg(errMsg(e)))
  }, [])

  const selected = selectedId == null ? null : services.find((s) => s.subAccountId === selectedId) ?? null
  const hasContent = services.length > 0 || (allDraftCount ?? 0) > 0

  const onRegistered = async (svc: LinkedService) => {
    setShowAdd(false)
    setMsg(okMsg(`連携サービス「${svc.name}」を追加しました（${svc.accountName} に補助科目を自動作成）。`))
    await reloadServices()
    reloadAllCount()
    select(svc.subAccountId)
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>連携サービス</h2>
        <button onClick={() => setShowAdd((v) => !v)} className="btn">{showAdd ? '－ 閉じる' : '＋ 連携サービスを追加'}</button>
      </div>
      <Msg msg={msg} />

      {showAdd && <AddServiceForm catalog={catalog} onRegistered={onRegistered} onCancel={() => setShowAdd(false)} />}

      {!hasContent ? (
        <div style={EMPTY_BOX}>
          連携サービスを追加してください。
          <br />
          CSV を取り込むには、まず銀行・カード・EC のサービスを「＋ 連携サービスを追加」から登録します。登録するとサービス毎に取込・仕訳確認ができます。
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginTop: 12 }}>
          {/* マスタ: 全件＋登録済みサービス */}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, width: 240, flexShrink: 0 }}>
            <li>
              <button onClick={() => select(null)} style={rowStyle(selectedId == null)}>
                <div style={{ fontWeight: 600 }}>確認待ち（全件）</div>
                <div style={{ fontSize: 13, color: COLORS.muted }}>すべての draft{allDraftCount != null ? `・${allDraftCount}件` : ''}</div>
              </button>
            </li>
            {services.map((s) => {
              const active = s.subAccountId === selectedId
              return (
                <li key={s.subAccountId}>
                  <button onClick={() => select(s.subAccountId)} style={rowStyle(active)}>
                    <div style={{ fontWeight: 600 }}>{s.name}</div>
                    <div style={{ fontSize: 13, color: COLORS.muted }}>
                      {s.label ?? s.serviceKey}
                      {s.kind ? `・${KIND_LABEL[s.kind]}` : ''}
                      {!s.csv && '・スキル連携'}
                      {s.draftCount > 0 ? `・確認待ち${s.draftCount}` : ''}
                    </div>
                  </button>
                </li>
              )
            })}
            {services.length === 0 && (
              <li style={{ fontSize: 13, color: COLORS.muted, padding: '6px 4px' }}>連携サービスは未登録です。「＋ 連携サービスを追加」から登録できます。</li>
            )}
          </ul>
          {/* 詳細: 全件 or 選択サービスの取込＋仕訳確認 */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {selectedId == null ? (
              /* 確認待ち（全件）: 取込・手入力・名寄せ等すべての draft をサービス横断で確認する。 */
              <section>
                <h3 style={{ marginTop: 0 }}>確認待ち（全件）</h3>
                <p style={{ color: COLORS.muted, fontSize: 13, marginTop: 0 }}>
                  取込・手入力・名寄せなど、すべての確認待ち（draft）仕訳です。左でサービスを選ぶとそのサービス分に絞れます。
                </p>
                <DraftListPanel
                  loadKey="all"
                  accounts={accounts}
                  taxCats={taxCats}
                  fiscalYear={fiscalYear}
                  onChanged={reloadCounts}
                  emptyHint="確認待ちの仕訳はありません。"
                />
              </section>
            ) : selected ? (
              <ServiceDetail key={selected.subAccountId} service={selected} accounts={accounts} taxCats={taxCats} fiscalYear={fiscalYear} onChanged={reloadCounts} />
            ) : (
              <p style={{ color: COLORS.muted }}>サービスが見つかりません。</p>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/** 選択サービスの詳細: CSV取込（対応形式のみ）＋そのサービスの draft 確認。 */
function ServiceDetail({
  service,
  accounts,
  taxCats,
  fiscalYear,
  onChanged,
}: {
  service: LinkedService
  accounts: Account[]
  taxCats: TaxCategory[]
  fiscalYear: DateScope
  onChanged: () => void
}) {
  const [reloadToken, setReloadToken] = useState(0)
  const [msg, setMsg] = useState<MsgState>(null)

  return (
    <section>
      <h3 style={{ marginTop: 0 }}>
        {service.name}{' '}
        <span style={{ fontSize: 13, color: COLORS.muted, fontWeight: 400 }}>
          （{service.accountName} / {service.accountRef}）
        </span>
      </h3>
      {/*
        取込の入口は2つあり、**どちらか一方ではない**。
          巡回（アプリが明細を取りに行く）… 既定。5サイトすべてにある
          CSV 取込（人がファイルを渡す）  … 反自動化に弾かれたときのフォールバック（銀行・カードのみ）
        巡回を上に置き、CSV はその下に「うまくいかないとき」の逃げ道として残す。
      */}
      <AcquisitionPanel
        service={service}
        hasCsvFallback={service.csv}
        onDone={() => {
          setReloadToken((t) => t + 1) // draft 一覧を再取得
          onChanged() // 左一覧バッジ・全件カウントを追随
        }}
      />
      {service.csv && (
        <CsvImportPanel
          service={service}
          onDone={(m) => {
            setMsg(m)
            setReloadToken((t) => t + 1)
            onChanged()
          }}
        />
      )}
      <Msg msg={msg} />
      <DraftListPanel
        loadKey={`svc:${service.subAccountId}:${reloadToken}`}
        subAccountId={service.subAccountId}
        accounts={accounts}
        taxCats={taxCats}
        fiscalYear={fiscalYear}
        onChanged={onChanged}
        emptyHint={
          service.csv
            ? 'draft はありません。明細を取り込む（または CSV を取り込む）と自動仕訳の候補が並びます。'
            : 'draft はありません。明細を取り込むと自動仕訳の候補が並びます。'
        }
      />
    </section>
  )
}
