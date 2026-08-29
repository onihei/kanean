import { dataDir } from '../config.js'
import { listSnapshots, restoreFromSnapshot, type SnapshotInfo } from '../ops/restore.js'

/**
 * リストアCLI（ops/restore.ts の薄いラッパ。ロジックは ops 側でテストする）。
 *
 * 使い方:
 *   pnpm --filter @kanean/server restore                      # スナップショット一覧＋整合性検証
 *   pnpm --filter @kanean/server restore <timestamp>          # dry-run（復元内容の表示のみ）
 *   pnpm --filter @kanean/server restore <timestamp> --apply  # 適用（現行データは pre-restore-* へ退避）
 *
 * ⚠️ --apply は**サーバ停止中**（pm2 stop kanean）に実行すること。稼働中プロセスが開いている
 *    DB と入れ替えると WAL が混ざり破損する。復元後に pm2 start → 動作確認 → pre-restore-* を手動削除。
 */

function fmt(s: SnapshotInfo): string {
  const okBooks = s.books.filter((b) => b.integrity === 'ok').length
  const control = s.hasControl
    ? s.controlIntegrity === 'ok'
      ? 'ok'
      : `NG(${s.controlIntegrity})`
    : 'なし'
  return `${s.timestamp}  帳簿: ${okBooks}/${s.books.length} ok  control: ${control}`
}

function main(): void {
  console.warn(
    '[restore] ⚠ サーバ停止中（pm2 stop kanean 等）に実行してください。稼働中の --apply は DB を破損させます。',
  )
  console.log(`[restore] DATA_DIR = ${dataDir()}`)
  const [timestamp, flag] = process.argv.slice(2)

  // 引数なし: スナップショット一覧（timestamp・ユーザー数・integrity 検証結果）。
  if (!timestamp) {
    const sets = listSnapshots()
    if (sets.length === 0) {
      console.log('[restore] スナップショットがありません（$DATA_DIR/backups/ が空。DATA_DIR を確認）')
      return
    }
    console.log(`[restore] ${sets.length} 件のスナップショット（新しい順）:`)
    for (const s of sets) console.log(`[restore]   ${fmt(s)}`)
    console.log('[restore] 復元: restore <timestamp> で dry-run → restore <timestamp> --apply で適用')
    return
  }

  if (flag != null && flag !== '--apply') throw new Error(`不明なオプション: ${flag}`)
  const apply = flag === '--apply'
  const r = restoreFromSnapshot(timestamp, { apply })

  console.log(`[restore] スナップショット: ${r.snapshot.dir}`)
  console.log(`[restore]   ${fmt(r.snapshot)}`)
  for (const b of r.snapshot.books) {
    console.log(
      `[restore]   book ${b.bookId}: integrity=${b.integrity} attachments=${b.hasAttachments ? 'あり' : 'なし'}`,
    )
  }
  if (!apply) {
    console.log(`[restore] dry-run: 適用時は現行データを ${r.preRestoreDir} へ退避して上記を配置します`)
    console.log('[restore] 適用するには --apply を付けて再実行してください')
    return
  }
  console.log(`[restore] 現行データを退避しました: ${r.preRestoreDir}`)
  console.log('[restore] 復元完了。サーバ起動・動作確認後、退避ディレクトリは手動で削除してください')
}

try {
  main()
} catch (err) {
  console.error('[restore] failed:', err)
  process.exit(1)
}
