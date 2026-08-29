import { useEffect, useState } from 'react'
import { api, setCurrentBookId, type AppMode, type BookInfo, type FiscalYearView } from './api.js'
import { Sidebar } from './nav/Sidebar.js'
import { type TabKey } from './nav/nav.js'
import { replaceRoute, useHashRoute } from './nav/route.js'
import { FiscalYearSetup } from './pages/FiscalYearSetup.js'
import { ModeSetup } from './pages/ModeSetup.js'
import { BookPicker } from './pages/BookPicker.js'
import { PersonalBookRepair } from './pages/PersonalBookRepair.js'
import { HomeTab } from './pages/HomeTab.js'
import { ServicesTab } from './pages/ServicesTab.js'
import { RawTransactionsTab } from './pages/RawTransactionsTab.js'
import { ReconcileTab } from './pages/ReconcileTab.js'
import { SettlementTab } from './pages/SettlementTab.js'
import { ManualEntryTab } from './pages/ManualEntryTab.js'
import { JournalTab } from './pages/JournalTab.js'
import { TrialBalanceTab } from './pages/TrialBalanceTab.js'
import { PlTab } from './pages/PlTab.js'
import { BsTab } from './pages/BsTab.js'
import { TrendTab } from './pages/TrendTab.js'
import { DepartmentReportTab } from './pages/DepartmentReportTab.js'
import { TaxSalesTab } from './pages/TaxSalesTab.js'
import { IncomeTaxTab } from './pages/IncomeTaxTab.js'
import { FilingTab } from './pages/FilingTab.js'
import { FixedAssetsTab } from './pages/FixedAssetsTab.js'
import { InvoicesTab } from './pages/InvoicesTab.js'
import { ProrationTab } from './pages/ProrationTab.js'
import { ClosingTab } from './pages/ClosingTab.js'
import { SettingsTab } from './pages/SettingsTab.js'
import { LedgerView } from './pages/LedgerView.js'

/**
 * 前回開いた帳簿の記憶。**自動で開くためではなく、帳簿選択画面でハイライトするため**に使う
 * （web-app spec「前回開いた帳簿を示す」）。事務所モードでは前回の帳簿を黙って開かない＝
 * 別の顧問先の帳簿に気づかず仕訳を打つ、という最悪の事故を構造的に防ぐ。
 */
const BOOK_STORAGE_KEY = 'kanean.bookId'

/**
 * 起動シーケンス（app-mode spec / web-app spec「初回セットアップ導線」）。
 *
 *   GET /api/app-mode
 *     ├ 未設定    → ModeSetup（選ぶまで進まない）
 *     ├ personal → アクティブ1冊をそのまま開く。2冊以上なら PersonalBookRepair
 *     └ office   → BookPicker（必ず選ぶ）→ Workbench →「帳簿を閉じる」で戻る
 *
 * 認証は無い（サーバは 127.0.0.1 限定バインド）。サーバが起動時に最低1冊を用意するため
 * アクティブな帳簿は必ず1冊以上ある。取得失敗＝サーバ未起動などの異常。
 */
export function App() {
  const [mode, setMode] = useState<AppMode | null | 'loading' | 'error'>('loading')
  const [books, setBooks] = useState<BookInfo[] | null>(null)
  const [bookId, setBookId] = useState<string | null>(null)

  const loadBooks = () => api.books().then((list) => (setBooks(list), list))

  useEffect(() => {
    api
      .appMode()
      .then((m) => {
        setMode(m)
        return loadBooks()
      })
      .catch(() => setMode('error'))
  }, [])

  const openBook = (id: string) => {
    localStorage.setItem(BOOK_STORAGE_KEY, id)
    setCurrentBookId(id) // ← 以降の API 呼び出しが X-BookInfo-Id を載せる
    setBookId(id)
  }

  // じぶんの帳簿モードは唯一のアクティブ帳簿へ直行する（選ばせない）。
  // 選択中の帳簿が消えた（アーカイブされた等）ときは選び直しへ戻す。
  useEffect(() => {
    if (books === null) return
    if (mode === 'personal' && books.length === 1 && bookId !== books[0].id) openBook(books[0].id)
    else if (bookId !== null && !books.some((b) => b.id === bookId)) setBookId(null)
  }, [mode, books, bookId])

  if (mode === 'loading' || (mode !== 'error' && books === null)) return <CenterShell>…</CenterShell>
  if (mode === 'error') return <CenterShell>サーバに接続できません。起動しているか確認してください。</CenterShell>

  // モード未設定＝初回起動。何より先に選ばせる（既定へ倒さない）。
  if (mode === null) {
    return (
      <ModeSetup
        onDone={(m) => {
          setMode(m)
          loadBooks()
        }}
      />
    )
  }

  const active = books ?? []
  if (active.length === 0) return <CenterShell>開ける帳簿がありません。サーバを再起動してください。</CenterShell>

  const lastOpened = localStorage.getItem(BOOK_STORAGE_KEY)

  // じぶんの帳簿モードで不変条件が壊れている（外部でファイルを足した・復元した等）。
  // list[0] を黙って選ぶ＝気づかないうちにどれかの帳簿へ書き込む、なので選ばせて残りをアーカイブする。
  if (mode === 'personal' && active.length > 1) {
    return (
      <PersonalBookRepair
        books={active}
        onDone={() => {
          setBookId(null)
          loadBooks()
        }}
      />
    )
  }

  // 事務所モード: 必ず選んでから始める（前回分はハイライトのみ）。
  if (mode === 'office' && bookId === null) {
    return (
      <BookPicker
        books={active}
        lastOpenedId={lastOpened}
        onSelect={openBook}
        onCreated={(list, created) => {
          setBooks(list)
          openBook(created.id)
        }}
      />
    )
  }

  const book = bookId === null ? undefined : active.find((b) => b.id === bookId)
  if (!book) return <CenterShell>…</CenterShell> // personal の直行待ち・帳簿が消えた直後

  // key に bookId を渡し、帳簿の切替で Workbench を作り直す＝選択年度・開いている元帳・
  // 絞り込みなどの画面状態を前の帳簿から持ち越さない（design Open Questions: 全リセット）。
  return (
    <Workbench
      key={bookId}
      mode={mode}
      book={book}
      // 閉じたら経路も初期化する。前の帳簿の画面状態（元帳の科目 id 等）を hash 経由で
      // 次の帳簿へ持ち越さない（design Open Questions: 帳簿切替は全リセット）。
      onCloseBook={
        mode === 'office'
          ? () => {
              setBookId(null)
              replaceRoute({ tab: 'home' })
            }
          : undefined
      }
      onBooksChanged={(list) => setBooks(list)}
      onModeChanged={setMode}
    />
  )
}

/** 起動時・エラー時の中央寄せ枠。 */
function CenterShell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ padding: 32, maxWidth: 960, margin: '0 auto' }}>
      <h1>Kanean</h1>
      {children}
    </main>
  )
}

function Workbench({
  mode,
  book,
  onCloseBook,
  onBooksChanged,
  onModeChanged,
}: {
  mode: AppMode
  book: BookInfo
  /** 事務所モードのみ。帳簿選択画面へ戻る（＝帳簿の切替もこの経路を通る）。 */
  onCloseBook?: () => void
  onBooksChanged: (books: BookInfo[]) => void
  onModeChanged: (mode: AppMode) => void
}) {
  // 会計年度の一覧を1回取得。初回ゲート（未設定なら選択画面）と、サイドバーの会計年度表示に使う。
  // null=読込中 / 'error'=取得失敗（ロックアウトを避けゲートしない）。
  const [years, setYears] = useState<FiscalYearView[] | 'error' | null>(null)
  const loadYears = () => api.fiscalYears().then(setYears).catch(() => setYears('error'))
  useEffect(() => {
    loadYears()
  }, [])

  // タブ・元帳オーバーレイ・設定セクションまで URL（hash）が単一の真実源（#129/#136）。
  // リロード・ブラウザバックで復帰し、遷移元ごとの状態受け渡しプロップは持たない。
  const route = useHashRoute()
  // 元帳は試算表/各表の科目リンク（AccountLink の実アンカー）で開く（タブ内容に重ねて表示）。

  if (years === null) return <CenterShell>…</CenterShell>
  if (years !== 'error' && years.length === 0) return <FiscalYearSetup onDone={loadYears} />
  const openFy = years === 'error' ? null : years.find((y) => y.status === 'open') ?? null

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar tab={route.tab} mode={mode} book={book} onCloseBook={onCloseBook} fiscalYear={openFy} />
      {/*
        maxWidth は帳票の行長を抑えるためのもので、一覧の折り返しとは無関係。
        既定ウィンドウ 1280（desktop/src/main.ts）では main の実幅が 1060 でこの上限に届かず**発動しない**ので、
        効くのはウィンドウを広げて使う場合だけ。一覧が既定サイズで収まることをこの値に依存させてはいけない。
      */}
      <main style={{ flex: 1, minWidth: 0, padding: '24px 32px', maxWidth: 1440 }}>
        {route.ledgerAccountId != null ? (
          <LedgerView accountId={route.ledgerAccountId} subId={route.ledgerSubId} />
        ) : (
          <TabView
            tab={route.tab}
            settingsSection={route.settingsSection}
            serviceSubId={route.serviceSubId}
            assetScheduleId={route.assetScheduleId}
            mode={mode}
            fiscalYear={openFy}
            onBooksChanged={onBooksChanged}
            onModeChanged={onModeChanged}
          />
        )}
      </main>
    </div>
  )
}

function TabView({
  tab,
  settingsSection,
  serviceSubId,
  assetScheduleId,
  mode,
  fiscalYear,
  onBooksChanged,
  onModeChanged,
}: {
  tab: TabKey
  /** 設定タブのセクション（URL 由来・未検証。キーの検証は SettingsTab）。 */
  settingsSection: string | undefined
  /** 連携サービスの選択（URL 由来。実在の検証は ServicesTab）。 */
  serviceSubId: number | undefined
  /** 固定資産の償却スケジュール表示（URL 由来）。 */
  assetScheduleId: number | undefined
  mode: AppMode
  /** 開いている会計年度。一覧行の日付から年を省けるかの判定に使う（未取得なら年を省かない）。 */
  fiscalYear: FiscalYearView | null
  onBooksChanged: (books: BookInfo[]) => void
  onModeChanged: (mode: AppMode) => void
}) {
  switch (tab) {
    case 'home':
      return <HomeTab />
    case 'services':
      return <ServicesTab fiscalYear={fiscalYear} selectedSubId={serviceSubId} />
    case 'raw':
      return <RawTransactionsTab fiscalYear={fiscalYear} />
    case 'reconcile':
      return <ReconcileTab />
    case 'settle':
      return <SettlementTab />
    case 'entry':
      return <ManualEntryTab />
    case 'journal':
      return <JournalTab />
    case 'trial':
      return <TrialBalanceTab />
    case 'pl':
      return <PlTab />
    case 'bs':
      return <BsTab />
    case 'trend':
      return <TrendTab />
    case 'dept':
      return <DepartmentReportTab />
    case 'tax':
      return <TaxSalesTab />
    case 'incometax':
      return <IncomeTaxTab />
    case 'filing':
      return <FilingTab />
    case 'assets':
      return <FixedAssetsTab scheduleId={assetScheduleId} />
    case 'invoices':
      return <InvoicesTab />
    case 'proration':
      return <ProrationTab />
    case 'closing':
      return <ClosingTab />
    case 'settings':
      return (
        <SettingsTab mode={mode} section={settingsSection} onBooksChanged={onBooksChanged} onModeChanged={onModeChanged} />
      )
  }
}
