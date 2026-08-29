import fs from 'node:fs'
import path from 'node:path'
import { dataDir, controlDbPath, booksDir } from '../config.js'
import { checkSqliteIntegrity, stamp, STAMP_RE } from './backup.js'
import { moveDbWithWal, SQLITE_RE } from './fsops.js'

/**
 * リストア（バックアップの対。「データは手元・いつでも復元可能」の復元側）。
 * `$DATA_DIR/backups/{timestamp}/` のスナップショットを検査し、現行の control.sqlite /
 * books/（DB・WAL/SHM・attachments）を `$DATA_DIR/pre-restore-{now}/` へ退避した上で、
 * スナップショットを**コピーで**配置する（バックアップセット自体は無傷で温存＝失敗してもやり直せる）。
 *
 * ⚠️ 適用（apply）は**サーバ停止中**に行う前提。稼働中プロセスが開いている DB と入れ替えると
 * 旧接続の WAL/チェックポイントが復元後のファイルへ混ざり破損する。
 * CLI は scripts/restore.ts（薄いラッパ）。コアをここに置くのはテスト可能にするため。
 */

export interface SnapshotBookInfo {
  bookId: string
  /** スナップショットDBの PRAGMA integrity_check 結果（正常は 'ok'）。 */
  integrity: string
  /** 証憑（attachments）がスナップショットに同梱されているか。 */
  hasAttachments: boolean
}

export interface SnapshotInfo {
  timestamp: string
  dir: string
  hasControl: boolean
  /** control.sqlite の integrity_check 結果（無ければ null）。 */
  controlIntegrity: string | null
  books: SnapshotBookInfo[]
}

function backupsRoot(): string {
  return path.join(dataDir(), 'backups')
}

/** 1スナップショットを検査する（存在確認＋全DBの integrity_check）。 */
export function inspectSnapshot(timestamp: string): SnapshotInfo {
  // timestamp は STAMP_RE 形式のみ受理（CLI 引数経由のパストラバーサルを構造的に排除）。
  if (!STAMP_RE.test(timestamp)) throw new Error(`不正なタイムスタンプ形式です: ${timestamp}`)
  const dir = path.join(backupsRoot(), timestamp)
  if (!fs.existsSync(dir)) throw new Error(`スナップショットが見つかりません: ${dir}`)

  const controlFile = path.join(dir, 'control.sqlite')
  const hasControl = fs.existsSync(controlFile)
  const booksSnapDir = path.join(dir, 'books')
  const books: SnapshotBookInfo[] = []
  if (fs.existsSync(booksSnapDir)) {
    const files = fs
      .readdirSync(booksSnapDir)
      .filter((f) => f.endsWith('.sqlite'))
      .sort()
    for (const f of files) {
      const bookId = f.replace(SQLITE_RE, '')
      books.push({
        bookId,
        integrity: checkSqliteIntegrity(path.join(booksSnapDir, f)),
        hasAttachments: fs.existsSync(path.join(booksSnapDir, bookId, 'attachments')),
      })
    }
  }
  return {
    timestamp,
    dir,
    hasControl,
    controlIntegrity: hasControl ? checkSqliteIntegrity(controlFile) : null,
    books,
  }
}

/** `$DATA_DIR/backups/` の全スナップショットを検査して返す（新しい順）。 */
export function listSnapshots(): SnapshotInfo[] {
  const root = backupsRoot()
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && STAMP_RE.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse()
    .map((name) => inspectSnapshot(name))
}

export interface RestoreResult {
  snapshot: SnapshotInfo
  /** 現行データの退避先（applied=true のときのみ実在する）。 */
  preRestoreDir: string
  applied: boolean
}

/**
 * スナップショットを復元する。apply=false（既定）は検査結果を返すだけの dry-run。
 * apply=true で ①スナップショット全DBを integrity_check（NG なら現行データに一切触らず throw）
 * ②現行データを pre-restore-{now}/ へ退避（同一FS内 rename） ③スナップショットをコピーで配置。
 */
export function restoreFromSnapshot(
  timestamp: string,
  opts: { apply?: boolean; now?: Date } = {},
): RestoreResult {
  const snapshot = inspectSnapshot(timestamp)
  const preRestoreDir = path.join(dataDir(), `pre-restore-${stamp(opts.now ?? new Date())}`)
  if (!opts.apply) return { snapshot, preRestoreDir, applied: false }

  // 適用前検証: 破損・不完全なスナップショットでは退避も含め何もしない（現行データ無傷を保証）。
  const bad: string[] = []
  if (!snapshot.hasControl) bad.push('control.sqlite がスナップショットにありません')
  else if (snapshot.controlIntegrity !== 'ok') bad.push(`control: ${snapshot.controlIntegrity}`)
  for (const b of snapshot.books.filter((x) => x.integrity !== 'ok')) {
    bad.push(`book ${b.bookId}: ${b.integrity}`)
  }
  if (bad.length > 0) {
    throw new Error(`スナップショットの整合性検証に失敗しました:\n  ${bad.join('\n  ')}`)
  }
  if (fs.existsSync(preRestoreDir)) throw new Error(`退避先が既に存在します: ${preRestoreDir}`)

  // 1) 退避（同一FS内の rename＝原子的移動）。books/ は DB・WAL/SHM 残骸・attachments を含めて
  //    丸ごと動かす（スナップショットに無い帳簿も復元後の世界には残さない＝時点復元の意味論）。
  fs.mkdirSync(preRestoreDir, { recursive: true })
  moveDbWithWal(controlDbPath(), preRestoreDir)
  if (fs.existsSync(booksDir())) fs.renameSync(booksDir(), path.join(preRestoreDir, 'books'))

  // 2) 配置はコピー（rename しない）: バックアップセットを消費せず温存し、再リストアを可能に保つ。
  //    スナップショットは `.backup()` 産の単一ファイルだが、運用者が sqlite3 で直接開く等で
  //    -wal/-shm が紛れ込む可能性はあるため、防御的に除外して復元後を単一ファイルに保つ。
  const noWalShm = (src: string): boolean => !/-(wal|shm)$/.test(src)
  fs.cpSync(path.join(snapshot.dir, 'control.sqlite'), controlDbPath())
  const booksSnapDir = path.join(snapshot.dir, 'books')
  if (fs.existsSync(booksSnapDir)) {
    fs.cpSync(booksSnapDir, booksDir(), { recursive: true, filter: noWalShm })
  } else {
    fs.mkdirSync(booksDir(), { recursive: true })
  }

  return { snapshot, preRestoreDir, applied: true }
}
