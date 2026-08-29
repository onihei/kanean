import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readOverride,
  writeOverride,
  clearOverride,
  selectorsPath,
} from '../core/calibrationStore.mjs'
import { mergeSelectors, CalibrationRejected } from '../core/selectors.mjs'

const DEFAULTS = { loggedInText: 'ログアウト', maxPages: 50, loginUrl: 'https://bank.example/' }
let dataDir

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-calib-'))
})
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('較正の上書き', () => {
  it('上書きが無ければ null（＝同梱較正）', () => {
    expect(readOverride(dataDir, 'bank_x')).toBeNull()
  })

  it('書いて読める', () => {
    writeOverride(dataDir, 'bank_x', DEFAULTS, { loggedInText: 'Sign out', version: 'v1' })
    expect(readOverride(dataDir, 'bank_x')).toEqual({ loggedInText: 'Sign out', version: 'v1' })
  })

  it('拒否される較正は書かれず、既存の上書きも壊さない', () => {
    writeOverride(dataDir, 'bank_x', DEFAULTS, { loggedInText: 'Sign out' })
    expect(() =>
      writeOverride(dataDir, 'bank_x', DEFAULTS, { loginUrl: 'javascript:evil()' }, ['loginUrl'])
    ).toThrow(CalibrationRejected)
    expect(readOverride(dataDir, 'bank_x')).toEqual({ loggedInText: 'Sign out' })
  })

  it('上書きの削除＝同梱較正への復帰（壊れた較正から戻せる）', () => {
    writeOverride(dataDir, 'bank_x', DEFAULTS, { loggedInText: '壊れた値' })
    const broken = mergeSelectors('bank_x', DEFAULTS, readOverride(dataDir, 'bank_x'))
    expect(broken.sel.loggedInText).toBe('壊れた値')

    const { existed } = clearOverride(dataDir, 'bank_x')
    expect(existed).toBe(true)

    const restored = mergeSelectors('bank_x', DEFAULTS, readOverride(dataDir, 'bank_x'))
    expect(restored.sel).toEqual(DEFAULTS)
    expect(restored.calibration.origin).toBe('bundled')
  })

  it('上書きが無い状態で消しても壊れない', () => {
    expect(clearOverride(dataDir, 'bank_x').existed).toBe(false)
  })

  it('壊れた JSON は黙って無視せず拒否する（黙って同梱に戻ると原因が分からなくなる）', () => {
    const file = selectorsPath(dataDir, 'bank_x')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ これは JSON ではない }')
    expect(() => readOverride(dataDir, 'bank_x')).toThrow(CalibrationRejected)
  })
})
