import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { accounts, mappingHistory } from '../../db/data/schema.js'
import { lookupEcClassification } from '../ecClassifyService.js'

let tmp: string
const USER = 'u_ecls'
const NOW = '2026-06-01T00:00:00.000Z'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-ecls-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup(): DataDb {
  const router = new DbRouter()
  const db = router.bookDb(USER)
  seedDataPlane(db)
  db.insert(mappingHistory)
    .values([
      { sourceType: 'amazon', pattern: 'SanDisk microSDXC 128GB', accountId: accId(db, '消耗品費'), hitCount: 3, lastUsedAt: '2026-05-01' },
      { sourceType: 'amazon', pattern: '鬼滅の刃 23巻', accountId: accId(db, '事業主貸'), hitCount: 5, lastUsedAt: '2026-05-10' },
      { sourceType: 'amazon', pattern: 'SanDisk 古い', accountId: accId(db, '消耗品費'), hitCount: 99, lastUsedAt: '2024-01-01' }, // 窓外
      { sourceType: 'rakuten', pattern: 'SanDisk 楽天', accountId: accId(db, '消耗品費'), hitCount: 9, lastUsedAt: '2026-05-01' }, // 別source
    ])
    .run()
  return db
}

describe('lookupEcClassification', () => {
  it('科目名と treatment を解決して返す（expense）', () => {
    const db = setup()
    const r = lookupEcClassification(db, 'amazon', ['SanDisk microSDXC 256GB'], { now: NOW })
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0].proposedAccount).toBe('消耗品費')
    expect(r.candidates[0].treatment).toBe('expense')
    expect(r.policy.matchedItems).toBe(1)
  })

  it('別sourceと窓外は除外', () => {
    const db = setup()
    const r = lookupEcClassification(db, 'amazon', ['SanDisk microSDXC 256GB'], { now: NOW })
    expect(r.candidates.map((c) => c.pattern)).toEqual(['SanDisk microSDXC 128GB'])
  })

  it('漫画は owner_draw（事業主貸）として導出', () => {
    const db = setup()
    const r = lookupEcClassification(db, 'amazon', ['鬼滅の刃 24巻'], { now: NOW })
    expect(r.candidates[0].proposedAccount).toBe('事業主貸')
    expect(r.candidates[0].treatment).toBe('owner_draw')
  })
})
