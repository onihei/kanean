import { describe, expect, it } from 'vitest'
import { formatHash, normalizeLegacyTabParam, parseHash, replaceRoute } from '../route.js'
import { NAV } from '../nav.js'

/**
 * ハッシュルーティングのコーデック（issue #129）。
 * URL はユーザーが手で書き換えられる入力なので、**壊れた値で白画面にしない**
 * （home へのフォールバック）ことをここで固定する。
 */

describe('parseHash / formatHash', () => {
  it('全タブが往復できる', () => {
    for (const { key } of NAV.flatMap((g) => g.items)) {
      expect(parseHash(formatHash({ tab: key }))).toEqual({ tab: key })
    }
  })

  it('元帳ルートが往復できる（タブセグメントを保持する）', () => {
    const route = { tab: 'trial', ledgerAccountId: 123 } as const
    expect(formatHash(route)).toBe('#trial/ledger/123')
    expect(parseHash('#trial/ledger/123')).toEqual(route)
  })

  it('空・未知のタブは home へフォールバックする', () => {
    expect(parseHash('')).toEqual({ tab: 'home' })
    expect(parseHash('#')).toEqual({ tab: 'home' })
    expect(parseHash('#no-such-tab')).toEqual({ tab: 'home' })
    // タブが壊れていれば末尾（元帳指定）ごと捨てる。未知タブの上に元帳だけ開かない。
    expect(parseHash('#no-such-tab/ledger/5')).toEqual({ tab: 'home' })
  })

  it('壊れた元帳セグメントはタブだけ残して捨てる', () => {
    expect(parseHash('#trial/ledger/abc')).toEqual({ tab: 'trial' })
    expect(parseHash('#trial/ledger/')).toEqual({ tab: 'trial' })
    expect(parseHash('#trial/ledger/-5')).toEqual({ tab: 'trial' })
    expect(parseHash('#trial/unknown/5')).toEqual({ tab: 'trial' })
  })

  it('補助元帳ルートが往復できる（元帳に重ねる二段目・issue #136）', () => {
    const route = { tab: 'trial', ledgerAccountId: 123, ledgerSubId: 45 } as const
    expect(formatHash(route)).toBe('#trial/ledger/123/sub/45')
    expect(parseHash('#trial/ledger/123/sub/45')).toEqual(route)
  })

  it('壊れた sub セグメントは元帳までで捨てる', () => {
    expect(parseHash('#trial/ledger/123/sub/abc')).toEqual({ tab: 'trial', ledgerAccountId: 123 })
    expect(parseHash('#trial/ledger/123/unknown/45')).toEqual({ tab: 'trial', ledgerAccountId: 123 })
  })

  it('設定セクションが往復できる（中身の検証は SettingsTab の責務）', () => {
    expect(formatHash({ tab: 'settings', settingsSection: 'rules' })).toBe('#settings/rules')
    expect(parseHash('#settings/rules')).toEqual({ tab: 'settings', settingsSection: 'rules' })
    // 未知のセクションもコーデックは素通しする（SettingsTab が既定へ倒す）
    expect(parseHash('#settings/no-such')).toEqual({ tab: 'settings', settingsSection: 'no-such' })
  })

  it('設定以外のタブは余分なセグメントを捨てる', () => {
    expect(parseHash('#journal/rules')).toEqual({ tab: 'journal' })
    // settings では数値が続かない ledger もセクション名として扱う（該当キーは無く既定へ倒れる）
    expect(parseHash('#settings/ledger')).toEqual({ tab: 'settings', settingsSection: 'ledger' })
  })

  it('連携サービスの選択が往復できる（実在の検証は ServicesTab の責務・issue #250）', () => {
    expect(formatHash({ tab: 'services', serviceSubId: 7 })).toBe('#services/7')
    expect(parseHash('#services/7')).toEqual({ tab: 'services', serviceSubId: 7 })
    // 数値でないセグメントは捨てる＝確認待ち（全件）
    expect(parseHash('#services/abc')).toEqual({ tab: 'services' })
    // 元帳オーバーレイは従来どおり（services セグメントより先に解釈される）
    expect(parseHash('#services/ledger/5')).toEqual({ tab: 'services', ledgerAccountId: 5 })
  })

  it('償却スケジュールが往復できる（issue #250）', () => {
    expect(formatHash({ tab: 'assets', assetScheduleId: 3 })).toBe('#assets/schedule/3')
    expect(parseHash('#assets/schedule/3')).toEqual({ tab: 'assets', assetScheduleId: 3 })
    // 壊れた id・未知セグメントはタブだけ残す
    expect(parseHash('#assets/schedule/abc')).toEqual({ tab: 'assets' })
    expect(parseHash('#assets/3')).toEqual({ tab: 'assets' })
  })
})

describe('normalizeLegacyTabParam', () => {
  it('旧形式 ?tab= を hash へ読み替え、search を消す', () => {
    history.replaceState(null, '', '/?tab=raw')
    normalizeLegacyTabParam()
    expect(window.location.hash).toBe('#raw')
    expect(window.location.search).toBe('')
  })

  it('未知の ?tab= は home（壊れたリンクで白画面にしない）', () => {
    history.replaceState(null, '', '/?tab=no-such-tab')
    normalizeLegacyTabParam()
    expect(window.location.hash).toBe('#home')
  })

  it('hash が既にあれば hash が勝つ（新形式が正）', () => {
    history.replaceState(null, '', '/?tab=raw#journal')
    normalizeLegacyTabParam()
    expect(window.location.hash).toBe('#journal')
    expect(window.location.search).toBe('')
  })

  it('?tab= が無ければ何もしない（hash も履歴も触らない）', () => {
    history.replaceState(null, '', '/#pl')
    normalizeLegacyTabParam()
    expect(window.location.hash).toBe('#pl')
  })
})

describe('replaceRoute', () => {
  it('hash を置き換え、購読者へ hashchange を通知する', () => {
    history.replaceState(null, '', '/#trial/ledger/123')
    let notified = 0
    const onChange = () => notified++
    window.addEventListener('hashchange', onChange)
    try {
      replaceRoute({ tab: 'home' })
    } finally {
      window.removeEventListener('hashchange', onChange)
    }
    expect(window.location.hash).toBe('#home')
    expect(notified).toBe(1)
  })
})
