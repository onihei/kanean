import { describe, expect, it } from 'vitest'
import { screenLink } from '@kanean/shared'
import { deepLinkFromArgv, OPENABLE_TABS, parseDeepLink } from '../deepLink.js'

/**
 * 外部リンクの受理（desktop-app spec「該当画面を開く外部リンク」）。
 *
 * リンクは OS 経由で誰からでも渡されうる。**画面遷移だけを行い、
 * 解釈できないものは初期画面へ倒す**ことをここで固定する。
 */

describe('リンクの解釈', () => {
  it('画面の指定を取り出す（hash 形式・issue #129）', () => {
    expect(parseDeepLink('kanean://local/#raw')).toBe('raw')
    expect(parseDeepLink('kanean://local/#settings')).toBe('settings')
  })

  it('旧形式 ?tab= も受ける（チャット履歴に残った過去のリンクを壊さない）', () => {
    expect(parseDeepLink('kanean://local/?tab=raw')).toBe('raw')
    expect(parseDeepLink('kanean://local/?tab=settings')).toBe('settings')
  })

  it('画面より深い内部ルートは受けない（外部リンクの契約は OPENABLE_TABS の画面のみ）', () => {
    expect(parseDeepLink('kanean://local/#journal/ledger/5')).toBeNull()
  })

  it('指定が無ければ初期画面（null）', () => {
    expect(parseDeepLink('kanean://local/')).toBeNull()
  })

  it('未知の画面は受け付けない', () => {
    expect(parseDeepLink('kanean://local/#unknown-screen')).toBeNull()
    expect(parseDeepLink('kanean://local/?tab=unknown-screen')).toBeNull()
  })

  it('別スキーム・別ホストは自分宛てではない', () => {
    expect(parseDeepLink('https://example.com/?tab=raw')).toBeNull()
    expect(parseDeepLink('kanean://evil/?tab=raw')).toBeNull()
  })

  it('URL として壊れていても例外を投げない', () => {
    expect(parseDeepLink('kanean')).toBeNull()
    expect(parseDeepLink('')).toBeNull()
    expect(parseDeepLink('not a url at all')).toBeNull()
  })

  it('更新系のパラメータは解釈しない（画面遷移だけを担う）', () => {
    // 何が付いていても、取り出すのは tab だけ。データを動かす指示は読まない。
    const url = 'kanean://local/?tab=journal&confirm=all&delete=1&bookId=01J'
    expect(parseDeepLink(url)).toBe('journal')
  })
})

describe('画面を開く URL（shared の screenLink と往復）', () => {
  it('指定が無ければ入口の URL', () => {
    expect(screenLink(null)).toBe('kanean://local/')
  })

  it('開ける画面はすべて往復できる', () => {
    for (const tab of OPENABLE_TABS) {
      expect(parseDeepLink(screenLink(tab))).toBe(tab)
    }
  })
})

describe('起動引数からのリンク抽出', () => {
  it('引数に混ざったリンクを拾う', () => {
    expect(deepLinkFromArgv(['/path/to/app', '--flag', 'kanean://local/?tab=pl'])).toBe(
      'kanean://local/?tab=pl',
    )
  })

  it('リンクが無ければ null', () => {
    expect(deepLinkFromArgv(['/path/to/app', '--flag'])).toBeNull()
  })
})
