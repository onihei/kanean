import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { receiptMetaSchema, receiptStatusSchema } from '../src/receipt.js'

/**
 * zod（正）から JSON Schema を生成する（design D4）。
 * 生成物は**リポジトリに追跡する**。モバイル（Dart）は TS のビルドを走らせずに
 * このファイルだけを読んで検証するため、成果物が無いと契約が届かない。
 *
 * 契約を変えたら `pnpm --filter @kanean/shared build:schema` を回し、
 * 生成物の差分も一緒にコミットすること。差分が出たまま放置すると Dart 側だけ古い契約で動く。
 */

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'contract', 'receipt')

const targets = [
  { file: 'receipt-meta.schema.json', name: 'ReceiptMeta', schema: receiptMetaSchema },
  { file: 'receipt-status.schema.json', name: 'ReceiptStatus', schema: receiptStatusSchema },
]

mkdirSync(outDir, { recursive: true })

for (const { file, name, schema } of targets) {
  const json = zodToJsonSchema(schema, { name, $refStrategy: 'none' })
  writeFileSync(path.join(outDir, file), `${JSON.stringify(json, null, 2)}\n`, 'utf8')
  console.log(`generated contract/receipt/${file}`)
}
