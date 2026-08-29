import { describe, it, expect } from 'vitest'
import { redactHtml, redactUrl } from '../core/redact.mjs'
import { captureDiagnostic } from '../core/runner.mjs'
import { ScrapeError } from '../core/errors.mjs'

describe('redactUrl', () => {
  it('セッション識別子らしきクエリを伏せる', () => {
    const u = redactUrl('https://bank.example/a?SESSIONID=abc123&page=2')
    expect(u).not.toContain('abc123')
    expect(u).toContain('page=2')
  })

  it('値を持つフラグメントは丸ごと落とす', () => {
    expect(redactUrl('https://bank.example/#access_token=zzz')).toBe(
      'https://bank.example/#[REDACTED]'
    )
  })

  it('普通の URL はそのまま残す（診断の役に立つため）', () => {
    expect(redactUrl('https://bank.example/account/activity')).toBe(
      'https://bank.example/account/activity'
    )
  })
})

describe('redactHtml', () => {
  it('入力欄の値を伏せる', () => {
    const html = '<input type="password" name="pin" value="9876"><input value="myuserid">'
    const out = redactHtml(html)
    expect(out).not.toContain('9876')
    expect(out).not.toContain('myuserid')
    expect(out).toContain('[REDACTED]')
  })

  it('textarea の中身を伏せる', () => {
    expect(redactHtml('<textarea>秘密のメモ</textarea>')).not.toContain('秘密のメモ')
  })

  it('CSRF/セッショントークンの meta を伏せる', () => {
    const out = redactHtml('<meta name="csrf-token" content="tok_abc">')
    expect(out).not.toContain('tok_abc')
  })

  it('画面構造は残す（較正の見直しに使うため）', () => {
    const out = redactHtml('<table><tr><th>取引日</th><th>残高</th></tr></table>')
    expect(out).toContain('取引日')
    expect(out).toContain('残高')
  })
})

describe('captureDiagnostic', () => {
  it('手順・所在・画面の状態を集め、認証情報は残さない', async () => {
    const page = {
      url: () => 'https://bank.example/a?token=SECRET',
      content: async () => '<input name="pw" value="SECRET">',
      screenshot: async () => Buffer.from('png'),
    }
    const err = new ScrapeError('set-period', '日付欄が見つからない', 'SEL を較正する')
    const d = await captureDiagnostic({ source: 'bank_x', page, err, steps: ['open-login', 'set-period'] })

    expect(d.step).toBe('set-period')
    expect(d.steps).toEqual(['open-login', 'set-period'])
    expect(d.hint).toBe('SEL を較正する')
    expect(JSON.stringify(d)).not.toContain('SECRET')
    expect(d.screenshot).toBeInstanceOf(Buffer)
  })

  it('ブラウザが死んでいても step と message は残る', async () => {
    const dead = {
      url: () => {
        throw new Error('closed')
      },
      content: async () => {
        throw new Error('closed')
      },
      screenshot: async () => {
        throw new Error('closed')
      },
    }
    const d = await captureDiagnostic({
      source: 'bank_x',
      page: dead,
      err: new ScrapeError('extract', 'テーブルが無い'),
    })
    expect(d.step).toBe('extract')
    expect(d.message).toBe('テーブルが無い')
    expect(d.url).toBeNull()
  })
})
