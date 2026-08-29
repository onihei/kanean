import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { accounts, entryTags, fiscalYears, importFormats, taxCategories } from '../../db/data/schema.js'
import { createManualEntry } from '../../journal/manualEntry.js'
import { getEntry, deleteEntry } from '../../journal/entries.js'
import {
  listCounterparties,
  createCounterparty,
  updateCounterparty,
  setCounterpartyActive,
  getCounterparty,
} from '../counterparties.js'
import {
  listSubAccounts,
  createSubAccount,
  getOrCreateCounterpartySubAccount,
  updateSubAccount,
  setSubAccountActive,
  listImportAccounts,
  createImportAccount,
} from '../subAccounts.js'
import { listDepartments, createDepartment, updateDepartment, setDepartmentActive } from '../departments.js'
import { listItems, createItem, updateItem, setItemActive } from '../items.js'
import { listTags, createTag, deleteTag } from '../tags.js'
import {
  listImportFormats,
  getImportFormat,
  createImportFormat,
  updateImportFormat,
  setImportFormatActive,
} from '../importFormats.js'
import { customSourceType } from '../../import/types.js'
import { getBusinessSettings, updateBusinessSettings } from '../businessSettings.js'

let tmp: string
const USER = 'u_masters'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-masters-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup(): { db: DataDb; fyId: number } {
  const db = new DbRouter().bookDb(USER)
  seedDataPlane(db)
  const fy = db
    .insert(fiscalYears)
    .values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' })
    .returning()
    .all()[0]
  return { db, fyId: fy.id }
}

describe('取引先（counterparties）CRUD', () => {
  it('作成・一覧（有効のみ）・更新・登録番号検証', () => {
    const { db } = setup()
    const id = createCounterparty(db, { name: 'トイウェア株式会社', invoiceRegNo: 'T1234567890123', honorific: '御中' })
    expect(getCounterparty(db, id).invoiceRegNo).toBe('T1234567890123')
    expect(listCounterparties(db).map((c) => c.name)).toEqual(['トイウェア株式会社'])

    // 部分更新: name と invoiceRegNo のみ送る → honorific は維持（消失しない）。
    updateCounterparty(db, id, { name: 'トイウェア（株）', invoiceRegNo: null })
    expect(getCounterparty(db, id).name).toBe('トイウェア（株）')
    expect(getCounterparty(db, id).invoiceRegNo).toBeNull()
    expect(getCounterparty(db, id).honorific).toBe('御中')
  })

  it('名称必須・登録番号フォーマット不正は拒否', () => {
    const { db } = setup()
    expect(() => createCounterparty(db, { name: '  ' })).toThrow(/取引先名/)
    expect(() => createCounterparty(db, { name: 'A', invoiceRegNo: '1234567890123' })).toThrow(/登録番号/)
    expect(() => createCounterparty(db, { name: 'A', invoiceRegNo: 'T123' })).toThrow(/登録番号/)
  })

  it('論理削除（無効化）で既定一覧から外れ、includeInactive で復活可能', () => {
    const { db } = setup()
    const id = createCounterparty(db, { name: 'A社' })
    setCounterpartyActive(db, id, false)
    expect(listCounterparties(db)).toHaveLength(0)
    expect(listCounterparties(db, true)).toHaveLength(1)
    setCounterpartyActive(db, id, true)
    expect(listCounterparties(db)).toHaveLength(1)
  })
})

describe('補助科目（sub_accounts）CRUD', () => {
  it('勘定配下に作成・accountId 絞り込み・親勘定は更新で不変', () => {
    // 普通預金には標準シードの補助科目があるため、作成した補助科目を id で特定して検証する。
    const { db } = setup()
    const bank = accId(db, '普通預金')
    const sales = accId(db, '売上高')
    const sub = createSubAccount(db, { accountId: bank, name: 'UFJ普通' })
    createSubAccount(db, { accountId: sales, name: '物販' })

    expect(listSubAccounts(db, { accountId: bank }).find((s) => s.id === sub)?.name).toBe('UFJ普通')
    expect(listSubAccounts(db, { accountId: sales }).some((s) => s.id === sub)).toBe(false)

    updateSubAccount(db, sub, { name: 'UFJ普通（改）' })
    const row = listSubAccounts(db, { accountId: bank }).find((s) => s.id === sub)!
    expect(row.name).toBe('UFJ普通（改）')
    expect(row.accountId).toBe(bank) // 親勘定は不変
  })

  it('既定税区分・取引先の存在検証、無効化', () => {
    const { db } = setup()
    const bank = accId(db, '普通預金')
    const tc = db.select().from(taxCategories).all()[0].id
    const cp = createCounterparty(db, { name: '取引先X' })
    const sub = createSubAccount(db, { accountId: bank, name: '取引先X補助', defaultTaxCategoryId: tc, counterpartyId: cp })
    expect(listSubAccounts(db, { accountId: bank }).find((s) => s.id === sub)?.counterpartyId).toBe(cp)

    expect(() => createSubAccount(db, { accountId: bank, name: 'NG', defaultTaxCategoryId: 99999 })).toThrow(/税区分/)
    expect(() => createSubAccount(db, { accountId: bank, name: 'NG', counterpartyId: 99999 })).toThrow(/取引先/)
    expect(() => createSubAccount(db, { accountId: 99999, name: 'NG' })).toThrow(/勘定科目/)

    setSubAccountActive(db, sub, false)
    expect(listSubAccounts(db, { accountId: bank }).some((s) => s.id === sub)).toBe(false)
    expect(listSubAccounts(db, { accountId: bank, includeInactive: true }).some((s) => s.id === sub)).toBe(true)
  })
})

describe('口座マスタ（import accounts・F-IMP-8）', () => {
  it('登録した取込口座が親勘定名・source_type 付きで一覧に出る', () => {
    const { db } = setup()
    const id = createImportAccount(db, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', accountId: accId(db, '普通預金'), name: 'UFJ普通' })
    expect(id).toBeGreaterThan(0)
    const list = listImportAccounts(db)
    const acc = list.find((a) => a.accountRef === 'ufj-1234')!
    expect(acc).toMatchObject({ name: 'UFJ普通', accountName: '普通預金', sourceType: 'bank_ufj', isActive: true })
    expect(acc.accountId).toBe(accId(db, '普通預金'))
  })

  it('表示名省略時は account_ref が名称になる', () => {
    const { db } = setup()
    createImportAccount(db, { sourceType: 'card_mufg_visa', accountRef: 'card-9', accountId: accId(db, '未払金') })
    expect(listImportAccounts(db).find((a) => a.accountRef === 'card-9')!.name).toBe('card-9')
  })

  it('account_ref の重複登録は拒否（取込時の口座解決を一意に保つ）', () => {
    const { db } = setup()
    createImportAccount(db, { sourceType: 'bank_ufj', accountRef: 'ufj-1', accountId: accId(db, '普通預金') })
    expect(() => createImportAccount(db, { sourceType: 'bank_ufj', accountRef: 'ufj-1', accountId: accId(db, '普通預金') })).toThrow(/既に登録/)
  })

  it('未対応の取込形式・空 account_ref は拒否', () => {
    const { db } = setup()
    expect(() => createImportAccount(db, { sourceType: 'bogus', accountRef: 'x', accountId: accId(db, '普通預金') })).toThrow(/取込形式/)
    expect(() => createImportAccount(db, { sourceType: 'bank_ufj', accountRef: '  ', accountId: accId(db, '普通預金') })).toThrow(/account_ref/)
  })

  it('無効化（アーカイブ）した取込口座は口座マスタの選択肢に出ない', () => {
    const { db } = setup()
    const id = createImportAccount(db, { sourceType: 'bank_ufj', accountRef: 'ufj-old', accountId: accId(db, '普通預金') })
    createImportAccount(db, { sourceType: 'bank_ufj', accountRef: 'ufj-active', accountId: accId(db, '普通預金') })
    expect(listImportAccounts(db).map((a) => a.accountRef)).toEqual(expect.arrayContaining(['ufj-old', 'ufj-active']))
    setSubAccountActive(db, id, false)
    const refs = listImportAccounts(db).map((a) => a.accountRef)
    expect(refs).toContain('ufj-active')
    expect(refs).not.toContain('ufj-old') // 無効化済みは除外
  })

  it('linked_account_ref を持たない通常の補助科目は口座マスタに出ない', () => {
    const { db } = setup()
    createSubAccount(db, { accountId: accId(db, '普通預金'), name: '通常補助' }) // linkedAccountRef なし
    createImportAccount(db, { sourceType: 'bank_ufj', accountRef: 'ufj-only', accountId: accId(db, '普通預金') })
    const refs = listImportAccounts(db).map((a) => a.accountRef)
    expect(refs).toContain('ufj-only')
    expect(listImportAccounts(db).every((a) => a.accountRef && a.accountRef.length > 0)).toBe(true)
  })
})

describe('取込フォーマット定義（汎用列マッピング・Phase3 対応フォーマット拡充）', () => {
  const config = {
    encoding: 'utf8' as const,
    headerRows: 1,
    dateCol: 0,
    descCols: [1],
    amount: { mode: 'split' as const, paidCol: 2, receivedCol: 3 },
    balanceCol: 4,
  }

  it('作成・一覧（有効のみ）・取得（config パース済み）', () => {
    const { db } = setup()
    const id = createImportFormat(db, { name: '住信SBI 普通', config })
    expect(id).toBeGreaterThan(0)
    expect(listImportFormats(db).map((f) => f.name)).toEqual(['住信SBI 普通'])
    const f = getImportFormat(db, id)
    expect(f.config!.amount).toMatchObject({ mode: 'split', paidCol: 2, receivedCol: 3 })
    expect(f.config!.headerRows).toBe(1)
  })

  it('不正な config は弾かれる（保存されない）', () => {
    const { db } = setup()
    expect(() => createImportFormat(db, { name: 'bad', config: { ...config, encoding: 'utf16' } })).toThrow(/encoding/)
    expect(() => createImportFormat(db, { name: '', config })).toThrow(/フォーマット名/)
    expect(listImportFormats(db)).toEqual([])
  })

  it('更新・論理削除（無効は既定一覧に出ない／includeInactive で出る）', () => {
    const { db } = setup()
    const id = createImportFormat(db, { name: '旧名', config })
    updateImportFormat(db, id, { name: '新名', config: { ...config, headerRows: 2 } })
    expect(getImportFormat(db, id)).toMatchObject({ name: '新名' })
    expect(getImportFormat(db, id).config!.headerRows).toBe(2)
    setImportFormatActive(db, id, false)
    expect(listImportFormats(db)).toEqual([])
    expect(listImportFormats(db, true).map((f) => f.id)).toEqual([id])
  })

  it('口座マスタは format:{id}（実在）を取込形式として受理し、存在しない id は拒否', () => {
    const { db } = setup()
    const fid = createImportFormat(db, { name: '汎用銀行', config })
    const id = createImportAccount(db, { sourceType: customSourceType(fid), accountRef: 'sbi-1', accountId: accId(db, '普通預金') })
    expect(id).toBeGreaterThan(0)
    expect(listImportAccounts(db).find((a) => a.accountRef === 'sbi-1')!.sourceType).toBe(customSourceType(fid))
    expect(() => createImportAccount(db, { sourceType: customSourceType(9999), accountRef: 'sbi-2', accountId: accId(db, '普通預金') })).toThrow(/フォーマット/)
  })

  it('部分更新: config 単独で name を保持、name 単独で config を保持', () => {
    const { db } = setup()
    const id = createImportFormat(db, { name: '元名', config })
    updateImportFormat(db, id, { config: { ...config, headerRows: 3 } }) // name 未指定
    expect(getImportFormat(db, id).name).toBe('元名')
    expect(getImportFormat(db, id).config!.headerRows).toBe(3)
    updateImportFormat(db, id, { name: '改名' }) // config 未指定
    expect(getImportFormat(db, id).name).toBe('改名')
    expect(getImportFormat(db, id).config!.headerRows).toBe(3) // 保持
  })

  it('保存済み config が壊れても list は行隔離し全滅しない（configError 付き・get は厳格に throw）', () => {
    const { db } = setup()
    const okId = createImportFormat(db, { name: '正常', config })
    // 異常系（手動DB編集・スキーマドリフト相当）: 不正 JSON を直挿入。
    db.insert(importFormats).values({ name: '破損', config: '{not json', isActive: true, createdAt: 'x', updatedAt: 'x' }).run()
    const list = listImportFormats(db)
    expect(list.map((f) => f.name).sort()).toEqual(['正常', '破損'].sort())
    const broken = list.find((f) => f.name === '破損')!
    expect(broken.config).toBeNull()
    expect(broken.configError).toBeTruthy()
    expect(list.find((f) => f.id === okId)!.config).not.toBeNull()
    expect(() => getImportFormat(db, broken.id)).toThrow()
  })
})

describe('部門（departments）CRUD', () => {
  it('作成・更新・無効化', () => {
    const { db } = setup()
    const id = createDepartment(db, '営業部')
    expect(listDepartments(db).map((d) => d.name)).toEqual(['営業部'])
    updateDepartment(db, id, '第一営業部')
    expect(listDepartments(db)[0].name).toBe('第一営業部')
    expect(() => createDepartment(db, ' ')).toThrow(/部門名/)
    setDepartmentActive(db, id, false)
    expect(listDepartments(db)).toHaveLength(0)
  })
})

describe('品目（items）CRUD', () => {
  it('作成・税率/単価検証・無効化', () => {
    const { db } = setup()
    const id = createItem(db, { name: 'コンサル', unitPrice: 50000, taxRate: 10, withholding: true })
    expect(listItems(db)[0].withholding).toBe(true)
    updateItem(db, id, { name: 'コンサルA', unitPrice: 60000, taxRate: 10 })
    expect(listItems(db)[0].name).toBe('コンサルA')

    expect(() => createItem(db, { name: 'NG', taxRate: 5 })).toThrow(/消費税率/)
    expect(() => createItem(db, { name: 'NG', unitPrice: -1 })).toThrow(/単価/)

    setItemActive(db, id, false)
    expect(listItems(db)).toHaveLength(0)
  })
})

describe('タグ（tags）CRUD', () => {
  it('作成は同名で冪等、削除は entry_tags 参照も外す', () => {
    const { db, fyId } = setup()
    const t1 = createTag(db, '経費精算')
    const t2 = createTag(db, '経費精算') // 同名 → 同 id
    expect(t1).toBe(t2)
    expect(listTags(db)).toHaveLength(1)

    // 仕訳へ付与してから削除 → entry_tags も消える。
    const entryId = createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-04-01',
      lines: [
        { side: 'debit', accountId: accId(db, '通信費'), amount: 1000 },
        { side: 'credit', accountId: accId(db, '現金'), amount: 1000 },
      ],
    })
    db.insert(entryTags).values({ entryId, tagId: t1 }).run()
    deleteTag(db, t1)
    expect(listTags(db)).toHaveLength(0)
    expect(db.select().from(entryTags).all()).toHaveLength(0)
  })

  it('タグ付与済みの仕訳も deleteEntry で削除できる（entry_tags を先に外す）', () => {
    const { db, fyId } = setup()
    const tag = createTag(db, '要確認')
    const entryId = createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-04-01',
      lines: [
        { side: 'debit', accountId: accId(db, '通信費'), amount: 1000 },
        { side: 'credit', accountId: accId(db, '現金'), amount: 1000 },
      ],
    })
    db.insert(entryTags).values({ entryId, tagId: tag }).run()
    // entry_tags の FK で落ちずに削除でき、付与も消える。
    expect(() => deleteEntry(db, entryId, '削除')).not.toThrow()
    expect(db.select().from(entryTags).all()).toHaveLength(0)
    expect(listTags(db)).toHaveLength(1) // タグ自体は残る
  })
})

describe('仕訳明細への配線（補助科目・取引先・部門が書き込まれ名称解決される）', () => {
  it('createManualEntry の明細に id を付与すると getEntry が名称付きで返す', () => {
    const { db, fyId } = setup()
    const bank = accId(db, '普通預金')
    const sub = createSubAccount(db, { accountId: bank, name: 'UFJ普通' })
    const cp = createCounterparty(db, { name: 'トイウェア株式会社' })
    const dep = createDepartment(db, '営業部')

    const id = createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-05-01',
      description: '入金',
      lines: [
        { side: 'debit', accountId: bank, subAccountId: sub, counterpartyId: cp, departmentId: dep, amount: 30000 },
        { side: 'credit', accountId: accId(db, '売上高'), counterpartyId: cp, amount: 30000 },
      ],
    })

    const e = getEntry(db, id)
    const debit = e.lines.find((l) => l.side === 'debit')!
    expect(debit.subAccountName).toBe('UFJ普通')
    expect(debit.counterpartyName).toBe('トイウェア株式会社')
    expect(debit.departmentName).toBe('営業部')
    const credit = e.lines.find((l) => l.side === 'credit')!
    expect(credit.counterpartyName).toBe('トイウェア株式会社')
    expect(credit.departmentName).toBeNull()
  })
})

describe('事業者設定（business settings）configured', () => {
  it('未保存は configured=false、保存後は屋号が空でも configured=true', () => {
    const { db } = setup()
    // 1行も無い初期状態。
    expect(getBusinessSettings(db).configured).toBe(false)

    // 屋号なし（businessName を送らない）で申告区分だけ保存 → 行が作られ configured=true。
    updateBusinessSettings(db, { filingType: 'blue' })
    const s = getBusinessSettings(db)
    expect(s.configured).toBe(true)
    expect(s.businessName).toBeNull()
  })

  it('evidenceCapture（電帳法・証憑保存）は既定 false で、更新でトグルできる', () => {
    const { db } = setup()
    expect(getBusinessSettings(db).evidenceCapture).toBe(false) // 既定OFF
    updateBusinessSettings(db, { evidenceCapture: true })
    expect(getBusinessSettings(db).evidenceCapture).toBe(true)
    updateBusinessSettings(db, { evidenceCapture: false })
    expect(getBusinessSettings(db).evidenceCapture).toBe(false)
  })
})

describe('取引先別補助科目（get-or-create・重複ガード）', () => {
  it('getOrCreateCounterpartySubAccount は取引先名で作成し、再呼び出しは同じ補助科目を返す', () => {
    const { db } = setup()
    const cpId = createCounterparty(db, { name: 'トイウェア株式会社' })
    const arId = accId(db, '売掛金')
    const first = getOrCreateCounterpartySubAccount(db, arId, cpId)
    const sub = listSubAccounts(db, { accountId: arId }).find((s) => s.id === first)
    expect(sub).toMatchObject({ name: 'トイウェア株式会社', counterpartyId: cpId })
    // 2回目は新規作成せず同一 id。
    expect(getOrCreateCounterpartySubAccount(db, arId, cpId)).toBe(first)
    expect(listSubAccounts(db, { accountId: arId })).toHaveLength(1)
  })

  it('createSubAccount は同一(勘定, 取引先)の二重作成を拒否（手動作成が自動作成と重複しない）', () => {
    const { db } = setup()
    const cpId = createCounterparty(db, { name: 'トイウェア株式会社' })
    const arId = accId(db, '売掛金')
    getOrCreateCounterpartySubAccount(db, arId, cpId)
    expect(() => createSubAccount(db, { accountId: arId, name: '別名でも不可', counterpartyId: cpId })).toThrow(/同じ取引先の補助科目/)
  })
})
