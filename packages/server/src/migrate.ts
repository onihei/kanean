import path from 'node:path'
import { dataDir, controlDbPath } from './config.js'
import { migrateControlDb, migrateBookDb, listBookDbFiles } from './db/router.js'

/**
 * マイグレーションエントリ（deploy.sh が pm2 restart の前に実行）。
 * - control plane に1回適用。
 * - data plane: $DATA_DIR/books/*.sqlite を全走査して順次適用（N個DBランナー、architecture §4.3）。
 * 冪等。失敗は非0終了で deploy を止める＝壊れたスキーマで起動させない。
 */
async function main(): Promise<void> {
  console.log(`[migrate] DATA_DIR = ${dataDir()}`)

  console.log(`[migrate] control: ${controlDbPath()}`)
  migrateControlDb()

  const bookDbs = listBookDbFiles()
  console.log(`[migrate] data plane: ${bookDbs.length} book db(s)`)
  let failed = 0
  for (const file of bookDbs) {
    try {
      const rehashed = migrateBookDb(file)
      const note = rehashed > 0 ? ` (dedup_hash 再計算 ${rehashed}件)` : ''
      console.log(`[migrate]   ✓ ${path.basename(file)}${note}`)
    } catch (err) {
      failed++
      console.error(`[migrate]   ✗ ${path.basename(file)}:`, err)
    }
  }

  if (failed > 0) {
    throw new Error(`${failed} book db migration(s) failed`)
  }
  console.log('[migrate] done')
}

main().catch((err) => {
  console.error('[migrate] failed:', err)
  process.exit(1)
})
