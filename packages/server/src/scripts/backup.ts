import { dataDir } from '../config.js'
import { backupAllDatabases } from '../ops/backup.js'
import { assertControlDbExists } from '../ops/guards.js'

/**
 * バックアップCLI（運用基盤・Exit#4）。control + 全 data plane を WAL 整合スナップショット
 * （integrity_check 検証・証憑同梱）し、世代保持（既定30・第1引数で上書き）を行う。
 * **月次 cron ＋ deploy.sh が migrate 前に実行**（直前状態へ戻せる復元点の確保。architecture §12）。
 *
 * 使い方:
 *   pnpm --filter @kanean/server backup           # 既定30世代
 *   pnpm --filter @kanean/server backup 7          # 7世代保持
 *   node dist/scripts/backup.js --deploy             # deploy 前バックアップ（世代プールを cron と分離）
 * cron 例（毎月1日 4:00）:
 *   0 4 1 * * cd /path/to/repo && pnpm --filter @kanean/server backup >> ~/backup.log 2>&1
 * 復元は `pnpm --filter @kanean/server restore`（scripts/restore.ts）。
 */
async function main(): Promise<void> {
  // D5: DATA_DIR 誤設定で空の control を暗黙生成し「成功」報告（偽成功）しないよう最初に遮断。
  assertControlDbExists()
  // --deploy: deploy.sh の migrate 前実行。`-deploy` 接尾辞のセットになり、cron の長期復元点を
  // 世代保持から追い出さない（prune は同種のみ数える）。
  const args = process.argv.slice(2)
  const kind = args.includes('--deploy') ? ('deploy' as const) : ('cron' as const)
  const retentionRaw = args.find((a) => a !== '--deploy')
  const retention = retentionRaw ? Number(retentionRaw) : undefined
  if (retention != null && (!Number.isInteger(retention) || retention < 0)) {
    throw new Error('retention は0以上の整数で指定してください')
  }
  console.log(`[backup] DATA_DIR = ${dataDir()}`)
  const r = await backupAllDatabases({ retention, kind })
  const okBooks = r.books.filter((b) => b.ok).length
  console.log(`[backup] → ${r.backupDir}`)
  console.log(`[backup] control: ${r.control.ok ? '✓' : `✗ ${r.control.error}`}`)
  console.log(`[backup] books: ${okBooks}/${r.books.length} ✓`)
  for (const b of r.books.filter((x) => !x.ok)) console.error(`[backup]   ✗ ${b.bookId}: ${b.error}`)
  if (r.prunedSets.length > 0) console.log(`[backup] pruned ${r.prunedSets.length} old set(s)`)

  const failed = (r.control.ok ? 0 : 1) + r.books.filter((b) => !b.ok).length
  if (failed > 0) throw new Error(`${failed} backup failure(s)`)
  console.log('[backup] done')
}

main().catch((err) => {
  console.error('[backup] failed:', err)
  process.exit(1)
})
