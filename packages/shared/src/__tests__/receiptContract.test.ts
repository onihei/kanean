import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { receiptMetaSchema, receiptStatusSchema } from '../receipt.js'

/**
 * 契約のゴールデンテスト（design D4）。**Dart 側のテストが同じフィクスチャを読む**ので、
 * 片側だけ解釈を変えるとどちらかが落ちる — これがドリフトに対する唯一の防壁。
 * 契約を変えるときはフィクスチャを先に足すこと。
 */

const contractDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'contract',
  'receipt',
)
const fixturesDir = path.join(contractDir, 'fixtures')

interface Case {
  file: string
  kind: 'meta' | 'status'
  valid: boolean
}

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'))
const manifest = readJson(path.join(fixturesDir, 'index.json')) as { cases: Case[] }
const schemas = { meta: receiptMetaSchema, status: receiptStatusSchema }

describe('レシート契約のゴールデン', () => {
  it('フィクスチャの一覧が空でない', () => {
    expect(manifest.cases.length).toBeGreaterThan(0)
  })

  for (const c of manifest.cases) {
    it(`${c.file} は ${c.valid ? '受理される' : '弾かれる'}`, () => {
      const result = schemas[c.kind].safeParse(readJson(path.join(fixturesDir, c.file)))
      expect(result.success).toBe(c.valid)
    })
  }

  it('現金と カードを取り違えない', () => {
    const cash = receiptMetaSchema.parse(readJson(path.join(fixturesDir, 'meta-cash-full.json')))
    const card = receiptMetaSchema.parse(readJson(path.join(fixturesDir, 'meta-card.json')))
    expect(cash.paymentMethod).toBe('cash')
    expect(card.paymentMethod).toBe('card')
  })

  it('未登録の status は必ず理由を持つ', () => {
    for (const c of manifest.cases.filter((x) => x.kind === 'status' && x.valid)) {
      const status = receiptStatusSchema.parse(readJson(path.join(fixturesDir, c.file)))
      if (status.outcome === 'skipped') expect(status.reason).toBeTruthy()
    }
  })

  it('登録済みの status は帳簿の中身を運ばない', () => {
    const status = receiptStatusSchema.parse(
      readJson(path.join(fixturesDir, 'status-registered.json')),
    )
    // 要約に許すのは entryId・date・totalAmount・accountName の4つだけ（receipt-inbox spec）。
    expect(status.outcome).toBe('registered')
    if (status.outcome !== 'registered') return
    expect(Object.keys(status.summary).sort()).toEqual([
      'accountName',
      'date',
      'entryId',
      'totalAmount',
    ])
  })
})

describe('生成された JSON Schema', () => {
  // Dart 側は TS を実行できないので、追跡している生成物が唯一の入力になる。
  // zod を直して再生成し忘れると Dart だけ古い契約で動くため、ここで検出する。
  const targets = [
    { file: 'receipt-meta.schema.json', name: 'ReceiptMeta', schema: receiptMetaSchema },
    { file: 'receipt-status.schema.json', name: 'ReceiptStatus', schema: receiptStatusSchema },
  ]

  for (const { file, name, schema } of targets) {
    it(`${file} が zod と一致している（ズレたら build:schema を回す）`, () => {
      const { $schema, ...body } = z.toJSONSchema(schema, { target: 'draft-7' })
      const generated = { $ref: `#/definitions/${name}`, definitions: { [name]: body }, $schema }
      expect(readJson(path.join(contractDir, file))).toEqual(generated)
    })
  }
})
