import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DbRouter } from '../../db/router.js'
import { fiscalYears } from '../../db/data/schema.js'
import { suggestInitialFiscalYear, createInitialFiscalYear } from '../setup.js'

describe('suggestInitialFiscalYear（1〜4月は前年・それ以外は当年）', () => {
  it('申告期（2月）は前年を提案', () => {
    expect(suggestInitialFiscalYear(new Date('2026-02-15T00:00:00Z'))).toBe(2025)
  })
  it('4月末は前年・5月頭は当年（境界）', () => {
    expect(suggestInitialFiscalYear(new Date('2026-04-30T00:00:00Z'))).toBe(2025)
    expect(suggestInitialFiscalYear(new Date('2026-05-01T00:00:00Z'))).toBe(2026)
  })
  it('年末（12月）は当年を提案', () => {
    expect(suggestInitialFiscalYear(new Date('2026-12-01T00:00:00Z'))).toBe(2026)
  })
})

describe('createInitialFiscalYear（初回の暦年1本を open で作成）', () => {
  let tmp: string
  const USER = 'u_fysetup'
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-fysetup-'))
    process.env.DATA_DIR = tmp
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('暦年(1/1〜12/31)を open で作成して返す', () => {
    const db = new DbRouter().bookDb(USER)
    const fy = createInitialFiscalYear(db, 2025, new Date('2026-02-01T00:00:00Z'))
    expect(fy.startDate).toBe('2025-01-01')
    expect(fy.endDate).toBe('2025-12-31')
    expect(fy.status).toBe('open')
    expect(db.select().from(fiscalYears).all()).toHaveLength(1)
  })

  it('既に年度があれば拒否（二重作成しない）', () => {
    const db = new DbRouter().bookDb(USER)
    createInitialFiscalYear(db, 2025)
    expect(() => createInitialFiscalYear(db, 2026)).toThrow(/既に設定/)
    expect(db.select().from(fiscalYears).all()).toHaveLength(1)
  })

  it('範囲外の西暦は拒否', () => {
    const db = new DbRouter().bookDb(USER)
    expect(() => createInitialFiscalYear(db, 1999)).toThrow(/不正/)
    expect(() => createInitialFiscalYear(db, 3000)).toThrow(/不正/)
    expect(db.select().from(fiscalYears).all()).toHaveLength(0)
  })
})
