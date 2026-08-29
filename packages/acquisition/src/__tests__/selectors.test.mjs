import { describe, it, expect } from 'vitest'
import {
  validateSelectors,
  mergeSelectors,
  bundledVersion,
  CalibrationRejected,
} from '../core/selectors.mjs'
import { SITES } from '../sites/index.mjs'

const NAVIGABLE = ['loginUrl', 'detailUrlTemplate']
const DEFAULTS = {
  loginUrl: 'https://bank.example/login',
  detailUrlTemplate: 'https://bank.example/d?id={orderId}',
  loggedInText: 'ログアウト',
  tableHeaders: ['日付', '残高'],
  maxPages: 50,
}

describe('validateSelectors — 受け付けるのはデータだけ', () => {
  it('同梱と同じ形の値は受け付ける', () => {
    const r = validateSelectors(DEFAULTS, {
      loggedInText: 'サインアウト',
      tableHeaders: ['取引日', '残高'],
      maxPages: 20,
    })
    expect(r.ok).toBe(true)
    expect(r.value.maxPages).toBe(20)
  })

  it('関数・コード片に相当するものを拒否する', () => {
    // JSON には関数が載らないので、実際に来るのはオブジェクト/配列に化けた形
    const r = validateSelectors(DEFAULTS, { loggedInText: { __fn: 'return process.exit(1)' } })
    expect(r.ok).toBe(false)
    expect(r.reasons.join()).toMatch(/文字列・数値・文字列配列/)
  })

  it('javascript: の URL を拒否する（較正がコード実行になるため）', () => {
    const r = validateSelectors(DEFAULTS, { loginUrl: 'javascript:fetch("//evil")' }, NAVIGABLE)
    expect(r.ok).toBe(false)
    expect(r.reasons.join()).toMatch(/http\/https 以外/)
  })

  it('file: の URL も拒否する', () => {
    expect(validateSelectors(DEFAULTS, { loginUrl: 'file:///etc/passwd' }, NAVIGABLE).ok).toBe(false)
  })

  it('プレースホルダ入りのテンプレート URL は受け付ける', () => {
    const r = validateSelectors(
      DEFAULTS,
      { detailUrlTemplate: 'https://bank.example/orders/{orderId}' },
      NAVIGABLE
    )
    expect(r.ok).toBe(true)
  })

  it('同梱に無いキーは追加できない（解釈対象を増やさせない）', () => {
    const r = validateSelectors(DEFAULTS, { evalHook: 'alert(1)' })
    expect(r.ok).toBe(false)
    expect(r.reasons.join()).toMatch(/未知の較正キー/)
  })

  it('型の違う上書きを拒否する', () => {
    expect(validateSelectors(DEFAULTS, { maxPages: '50' }).ok).toBe(false)
    expect(validateSelectors(DEFAULTS, { tableHeaders: '日付' }).ok).toBe(false)
  })

  it('オブジェクトでない較正を拒否する', () => {
    expect(validateSelectors(DEFAULTS, ['a']).ok).toBe(false)
    expect(validateSelectors(DEFAULTS, null).ok).toBe(false)
  })
})

describe('mergeSelectors — 同梱を既定・$DATA_DIR で上書き', () => {
  it('上書きが無ければ同梱をそのまま使う', () => {
    const { sel, calibration } = mergeSelectors('bank_x', DEFAULTS, null)
    expect(sel).toEqual(DEFAULTS)
    expect(calibration.origin).toBe('bundled')
    expect(calibration.version).toBe(bundledVersion(DEFAULTS))
    expect(calibration.overridden).toEqual([])
  })

  it('上書きしたキーだけが差し変わり、どれを上書きしたかが残る', () => {
    const { sel, calibration } = mergeSelectors('bank_x', DEFAULTS, { loggedInText: 'Sign out' })
    expect(sel.loggedInText).toBe('Sign out')
    expect(sel.loginUrl).toBe(DEFAULTS.loginUrl)
    expect(calibration.origin).toBe('override')
    expect(calibration.overridden).toEqual(['loggedInText'])
  })

  it('宣言された版があればそれを名乗る（取得結果に残す用）', () => {
    const { calibration } = mergeSelectors('bank_x', DEFAULTS, {
      loggedInText: 'Sign out',
      version: '2026-08-12a',
    })
    expect(calibration.version).toBe('override:2026-08-12a')
  })

  it('拒否される較正では巡回を始めない', () => {
    expect(() => mergeSelectors('bank_x', DEFAULTS, { loginUrl: 'javascript:1' }, NAVIGABLE)).toThrow(
      CalibrationRejected
    )
  })

  it('同梱の版は内容から決まる（中身が変われば版も変わる）', () => {
    expect(bundledVersion(DEFAULTS)).toBe(bundledVersion({ ...DEFAULTS }))
    expect(bundledVersion(DEFAULTS)).not.toBe(bundledVersion({ ...DEFAULTS, maxPages: 10 }))
  })
})

describe('同梱較正そのものがデータであること', () => {
  it.each(Object.entries(SITES))('%s の DEFAULT_SEL に関数が無い', (source, site) => {
    for (const [key, v] of Object.entries(site.DEFAULT_SEL)) {
      expect(typeof v, `${source}.${key}`).not.toBe('function')
      expect(['string', 'number'].includes(typeof v) || Array.isArray(v), `${source}.${key}`).toBe(
        true
      )
    }
  })

  it.each(Object.entries(SITES))('%s の DEFAULT_SEL は自分自身の検証を通る', (_source, site) => {
    expect(validateSelectors(site.DEFAULT_SEL, site.DEFAULT_SEL, site.NAVIGABLE_KEYS).ok).toBe(true)
  })
})

describe('遷移先として使う較正キーの宣言', () => {
  it.each(Object.entries(SITES))('%s は NAVIGABLE_KEYS を宣言し、全て DEFAULT_SEL にある', (_s, site) => {
    expect(Array.isArray(site.NAVIGABLE_KEYS)).toBe(true)
    expect(site.NAVIGABLE_KEYS.length).toBeGreaterThan(0)
    for (const key of site.NAVIGABLE_KEYS) expect(site.DEFAULT_SEL).toHaveProperty(key)
  })

  it.each(Object.entries(SITES))('%s は遷移先の較正に javascript: を通さない', (_s, site) => {
    for (const key of site.NAVIGABLE_KEYS) {
      const r = validateSelectors(site.DEFAULT_SEL, { [key]: 'javascript:alert(1)' }, site.NAVIGABLE_KEYS)
      expect(r.ok, key).toBe(false)
    }
  })
})
