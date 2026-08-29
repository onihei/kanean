import { useState } from 'react'
import {
  api,
  type BlueReturnSummary,
  type FilingIssue,
  type FilingRecord,
  type FilingSheetGroup,
  type FilingSheetItem,
  type FilingMethod,
  type FilingTaxKind,
  type McpLinkStatus,
} from '../api.js'
import { FILING_METHOD_LABELS, FILING_TAX_KIND_LABELS } from '@kanean/shared'
import { Msg, NoYear, SegTabs, TaxAdvisorBanner, errMsg, okMsg, useConfirm, type MsgState } from '../components/common.js'
import { useReport } from '../lib/hooks.js'
import { COLORS, FIELD, SECTION, WARN_BANNER } from '../lib/styles.js'
import { formatHash } from '../nav/route.js'
import type { TabKey } from '../nav/nav.js'

/**
 * 確定申告画面（web-app spec「確定申告画面」/ filing spec）。
 * 申告前チェック → 入力指示書（手動転記のフォールバック）→ AI 転記の案内 → 完了記録。
 * 「提出可能」は表示しない（判定は常に人と税理士の側）。
 */

// --- 純関数（テスト対象） ----------------------------------------------------

export function splitIssues(issues: FilingIssue[]): { blocking: FilingIssue[]; warnings: FilingIssue[] } {
  return {
    blocking: issues.filter((i) => i.level === 'blocking'),
    warnings: issues.filter((i) => i.level === 'warning'),
  }
}

/**
 * AI 転記の案内（web-app spec「AI 転記の案内を疎通状態に合わせる」）。
 * 導入の有無は断定しない — 書けるのは観測できた到達と版の一致だけ（mcpLinkRow と同じ規約）。
 */
export function aiGuide(status: McpLinkStatus | null): { kind: 'ready' | 'setup'; text: string } {
  if (status?.seen && status.matches) {
    return {
      kind: 'ready',
      text:
        'Claude Desktop の定型手順「確定申告の転記」から会話を始めると、この画面の入力指示書どおりの転記を任せられます。' +
        'マイナンバーカードの認証（QRコードの読み取り）と送信の操作はあなた自身が行います。',
    }
  }
  if (status?.seen && !status.matches) {
    return {
      kind: 'setup',
      text: 'Claude Desktop で同梱版と一致しない連携ファイルが使われた記録があります。設定画面から書き出して入れ直してください。',
    }
  }
  return {
    kind: 'setup',
    text:
      'AI 連携（Claude Desktop）の到達はまだ確認できていません。連携すると作成コーナーへの転記を任せられます。' +
      'この指示書を見ながら手動で転記することもできます。',
  }
}

/** e-Tax 提出（作成コーナー）の所得税記録があり、65万円の電子要件が未設定なら設定確認を促す。 */
export function needs65Hint(records: FilingRecord[], summary: BlueReturnSummary | null): boolean {
  if (!summary || summary.qualifiesFor65 || summary.filingType !== 'blue') return false
  return records.some((r) => r.method === 'corner_etax' && r.taxKind === 'income_tax')
}

// --- 小部品 ------------------------------------------------------------------

function GoTab({ tab, label }: { tab: TabKey; label: string }) {
  return (
    <a href={formatHash({ tab })} style={{ color: COLORS.accent, textDecoration: 'none', marginLeft: 8, fontSize: 13 }}>
      {label} →
    </a>
  )
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={copied ? 'btn btn-ok' : 'btn btn-accent'}
      style={{ padding: '0 8px', fontSize: 13 }}
      onClick={async () => {
        if (await copyText(value)) {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }
      }}
    >
      {copied ? '✓' : 'コピー'}
    </button>
  )
}

const KIND_CHIP: Record<FilingSheetItem['kind'], { label: string; color: string }> = {
  input: { label: '転記', color: COLORS.accent },
  select: { label: '選択', color: COLORS.warn },
  verify: { label: '照合', color: COLORS.ok },
}

function KindChip({ kind }: { kind: FilingSheetItem['kind'] }) {
  const c = KIND_CHIP[kind]
  return (
    <span style={{ border: `1px solid ${c.color}`, color: c.color, borderRadius: 4, padding: '0 6px', fontSize: 11 }}>
      {c.label}
    </span>
  )
}

const fmtYen = (v: number) => v.toLocaleString('ja-JP')

// --- 申告前チェック ----------------------------------------------------------

function PrecheckSection() {
  const { data, err, loading } = useReport(api.filingPrecheck)
  const link = useReport(() => api.mcpLink().catch(() => null))
  if (loading) return <p>読込中…</p>
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!data) return <NoYear />
  const { blocking, warnings } = splitIssues(data.issues)
  const guide = aiGuide(link.data ?? null)
  return (
    <div>
      <section style={SECTION}>
        <h3 style={{ marginTop: 0 }}>{data.year}年分 申告前チェック</h3>
        {data.issues.length === 0 && <p style={{ color: COLORS.ok }}>不備は見つかりませんでした。</p>}
        {blocking.length > 0 && (
          <div>
            <p style={{ color: COLORS.error, fontWeight: 600 }}>不備（解消してから転記へ進んでください）</p>
            <ul>
              {blocking.map((i) => (
                <li key={i.code} style={{ color: COLORS.error, marginBottom: 4 }}>
                  {i.message}
                  {i.screen && <GoTab tab={i.screen} label="画面を開く" />}
                </li>
              ))}
            </ul>
          </div>
        )}
        {warnings.length > 0 && (
          <div>
            <p style={{ color: COLORS.warn, fontWeight: 600 }}>注意</p>
            <ul>
              {warnings.map((i) => (
                <li key={i.code} style={{ color: COLORS.warn, marginBottom: 4 }}>
                  {i.message}
                  {i.screen && <GoTab tab={i.screen} label="画面を開く" />}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p style={{ color: COLORS.muted, fontSize: 13 }}>{data.disclaimer}</p>
      </section>
      <section style={SECTION}>
        <h3 style={{ marginTop: 0 }}>提出のしかた</h3>
        <p style={{ fontSize: 13 }}>
          国税庁の「確定申告書等作成コーナー」に、入力指示書の値を転記して e-Tax 送信します。
          転記は手動でも、AI（Claude Desktop）に任せることもできます。
        </p>
        <p style={{ ...(guide.kind === 'ready' ? { color: COLORS.ok } : WARN_BANNER), fontSize: 13 }}>
          {guide.text}
          {guide.kind === 'setup' && <GoTab tab="settings" label="AI 連携の設定" />}
        </p>
      </section>
    </div>
  )
}

// --- 入力指示書 --------------------------------------------------------------

function SheetGroupTable({ group }: { group: FilingSheetGroup }) {
  if (group.items.length === 0) return null
  return (
    <section style={SECTION}>
      <h3 style={{ margin: '0 0 8px' }}>
        <span style={{ color: COLORS.muted, marginRight: 8 }}>{group.id}</span>
        {group.screen}
      </h3>
      <table className="tbl" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th style={{ width: 56 }}></th>
            <th>欄</th>
            <th style={{ textAlign: 'right' }}>転記値</th>
            <th style={{ width: 72 }}></th>
            <th>注記</th>
          </tr>
        </thead>
        <tbody>
          {group.items.map((item, i) => (
            <tr key={i}>
              <td>
                <KindChip kind={item.kind} />
              </td>
              <td>{item.field}</td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: item.kind === 'verify' ? 600 : 400 }}>
                {item.amount != null ? fmtYen(item.amount) : item.value}
              </td>
              <td>
                <CopyBtn value={item.value} />
              </td>
              <td style={{ color: COLORS.muted, fontSize: 13 }}>{item.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function SheetSection() {
  const { data, err, loading } = useReport(api.filingSheet)
  if (loading) return <p>読込中…</p>
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!data) return <NoYear />
  return (
    <div>
      <section style={{ ...SECTION, background: COLORS.accentBg, border: `1px solid ${COLORS.accentBorder}` }}>
        <h3 style={{ marginTop: 0 }}>{data.year}年分 検算（★送信前に作成コーナーの計算結果と1円単位で一致を確認）</h3>
        <ul style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>
          {data.checksum.incomeTaxRefund > 0 ? (
            <li>所得税: 還付される税金 {fmtYen(data.checksum.incomeTaxRefund)} 円</li>
          ) : (
            <li>所得税: 納める税金 {fmtYen(data.checksum.incomeTaxPayable)} 円</li>
          )}
          {data.consumptionApplicable && (
            <li>
              消費税: 国税 {fmtYen(data.checksum.consumptionNational)} 円 ／ 地方 {fmtYen(data.checksum.consumptionLocal)} 円 ／ 合計{' '}
              {fmtYen(data.checksum.consumptionTotal)} 円
            </li>
          )}
        </ul>
        <p style={{ color: COLORS.muted, fontSize: 13, margin: '8px 0 0' }}>
          一致しない場合は送信せず、値の食い違いを確認してください。{data.disclaimer}
        </p>
      </section>
      {data.groups.map((g) => (
        <SheetGroupTable key={g.id} group={g} />
      ))}
    </div>
  )
}

// --- 完了記録 ----------------------------------------------------------------

const EMPTY_FORM = { taxKind: 'income_tax' as FilingTaxKind, method: 'corner_etax' as FilingMethod, submittedOn: '', receiptNumber: '', memo: '' }

function RecordsSection() {
  const [confirmDialog, ask] = useConfirm()
  const records = useReport(api.filingRecords)
  const deduction = useReport(api.blueDeduction)
  const [form, setForm] = useState(EMPTY_FORM)
  const [msg, setMsg] = useState<MsgState>(null)

  const create = async () => {
    try {
      await api.createFilingRecord({
        taxKind: form.taxKind,
        method: form.method,
        submittedOn: form.submittedOn,
        receiptNumber: form.receiptNumber || null,
        memo: form.memo || null,
      })
      setMsg(okMsg('提出を記録しました'))
      setForm(EMPTY_FORM)
      records.reload()
    } catch (e) {
      setMsg(errMsg(e, '記録に失敗'))
    }
  }

  const upload = async (recordId: number, file: File) => {
    try {
      await api.uploadFilingAttachment(recordId, file)
      setMsg(okMsg('控えを添付しました'))
      records.reload()
    } catch (e) {
      setMsg(errMsg(e, '添付に失敗'))
    }
  }

  const remove = async (r: FilingRecord) => {
    if (!(await ask(`${FILING_TAX_KIND_LABELS[r.taxKind]}（${r.submittedOn} 提出）の記録を添付ごと削除しますか？`))) return
    try {
      await api.deleteFilingRecord(r.id)
      setMsg(okMsg('記録を削除しました'))
      records.reload()
    } catch (e) {
      setMsg(errMsg(e, '削除に失敗'))
    }
  }

  if (records.loading) return <p>読込中…</p>
  if (records.err) return <p style={{ color: COLORS.error }}>{records.err}</p>

  return (
    <div>
      {confirmDialog}
      {needs65Hint(records.data ?? [], deduction.data ?? null) && (
        <p style={WARN_BANNER}>
          e-Tax 送信を記録しました。青色申告特別控除（65万円）の電子要件を満たしている可能性があります。設定を確認してください。
          <GoTab tab="incometax" label="所得税申告の設定" />
        </p>
      )}
      <section style={SECTION}>
        <h3 style={{ marginTop: 0 }}>提出を記録する</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={FIELD}>
            税目{' '}
            <select value={form.taxKind} onChange={(e) => setForm({ ...form, taxKind: e.target.value as FilingTaxKind })}>
              {Object.entries(FILING_TAX_KIND_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label style={FIELD}>
            提出方法{' '}
            <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value as FilingMethod })}>
              {Object.entries(FILING_METHOD_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label style={FIELD}>
            提出日 <input type="date" value={form.submittedOn} onChange={(e) => setForm({ ...form, submittedOn: e.target.value })} />
          </label>
          <label style={FIELD}>
            受付番号 <input value={form.receiptNumber} onChange={(e) => setForm({ ...form, receiptNumber: e.target.value })} placeholder="受信通知に記載" />
          </label>
          <label style={FIELD}>
            メモ <input value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
          </label>
          <button className="btn btn-ok" disabled={!form.submittedOn} onClick={create}>
            記録する
          </button>
        </div>
        <Msg msg={msg} />
      </section>
      <section style={SECTION}>
        <h3 style={{ marginTop: 0 }}>提出の記録</h3>
        {(records.data ?? []).length === 0 && <p style={{ color: COLORS.muted }}>まだ記録がありません。</p>}
        {(records.data ?? []).length > 0 && (
          <table className="tbl" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>税目</th>
                <th>提出方法</th>
                <th>提出日</th>
                <th>受付番号</th>
                <th>控え</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(records.data ?? []).map((r) => (
                <tr key={r.id}>
                  <td>{FILING_TAX_KIND_LABELS[r.taxKind]}</td>
                  <td>{FILING_METHOD_LABELS[r.method]}</td>
                  <td>{r.submittedOn}</td>
                  <td>{r.receiptNumber ?? '—'}</td>
                  <td>
                    {r.attachments.map((a) => (
                      <span key={a.id} style={{ marginRight: 8, whiteSpace: 'nowrap' }}>
                        <a href={api.attachmentUrl(a.id)} target="_blank" rel="noreferrer" style={{ color: COLORS.accent }}>
                          {a.fileName ?? `添付${a.id}`}
                        </a>
                      </span>
                    ))}
                    <label className="btn btn-accent" style={{ fontSize: 13, display: 'inline-block' }}>
                      控えを添付
                      <input
                        type="file"
                        accept="application/pdf,image/jpeg,image/png,image/heic,image/heif"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          if (f) void upload(r.id, f)
                          e.target.value = ''
                        }}
                      />
                    </label>
                  </td>
                  <td>
                    <button className="btn btn-danger" onClick={() => remove(r)}>
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ color: COLORS.muted, fontSize: 13 }}>
          記録は提出の事実のメモであり、提出の有効性を判定するものではありません。受信通知・申告書控えの PDF を控えとして残せます。
        </p>
      </section>
    </div>
  )
}

// --- 画面本体 ----------------------------------------------------------------

type Seg = 'check' | 'sheet' | 'records'

export function FilingTab() {
  const [seg, setSeg] = useState<Seg>('check')
  return (
    <div>
      <h2>確定申告</h2>
      <TaxAdvisorBanner note="送信の操作とマイナンバーカードの認証は必ず本人が行います。" />
      <SegTabs
        value={seg}
        onChange={setSeg}
        options={[
          { value: 'check', label: '申告前チェック' },
          { value: 'sheet', label: '入力指示書' },
          { value: 'records', label: '完了記録' },
        ]}
      />
      {seg === 'check' && <PrecheckSection />}
      {seg === 'sheet' && <SheetSection />}
      {seg === 'records' && <RecordsSection />}
    </div>
  )
}
