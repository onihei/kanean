import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { receiptMetaSchema, receiptStatusSchema } from '../src/receipt.js'

/**
 * zod（正）から JSON Schema を生成する（design D4）。
 * 生成物は**リポジトリに追跡する**。モバイル（Dart）は TS のビルドを走らせずに
 * このファイルだけを読んで検証するため、成果物が無いと契約が届かない。
 *
 * 契約を変えたら `pnpm --filter @kanean/shared build:schema` を回し、
 * 生成物の差分も一緒にコミットすること。差分が出たまま放置すると Dart 側だけ古い契約で動く。
 */

/**
 * zod 4 標準の z.toJSONSchema で生成し、従来（zod-to-json-schema）と同じ封筒
 * `{ $ref, definitions: { [name] }, $schema }`（draft-07）に包む。Dart 側の読み方を変えないため。
 */
export function toContractJsonSchema(schema: z.ZodType, name: string) {
  const { $schema, ...body } = z.toJSONSchema(schema, { target: 'draft-7' })
  return { $ref: `#/definitions/${name}`, definitions: { [name]: body }, $schema }
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'contract', 'receipt')

const targets = [
  { file: 'receipt-meta.schema.json', name: 'ReceiptMeta', schema: receiptMetaSchema },
  { file: 'receipt-status.schema.json', name: 'ReceiptStatus', schema: receiptStatusSchema },
]

mkdirSync(outDir, { recursive: true })

for (const { file, name, schema } of targets) {
  const json = toContractJsonSchema(schema, name)
  writeFileSync(path.join(outDir, file), `${JSON.stringify(json, null, 2)}\n`, 'utf8')
  console.log(`generated contract/receipt/${file}`)
}
