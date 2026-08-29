import fs from 'node:fs'
import { dataDir, controlDbPath } from '../config.js'

/**
 * control.sqlite の存在ガード。
 *
 * openSqlite は無条件にファイルを新規生成するため、DATA_DIR 誤設定のまま ops CLI を実行すると
 * 空の control.sqlite を暗黙生成 → それを処理して exit 0（偽成功）してしまう。
 * cron 前提のバックアップでは「誤った安心」が最も危険なので、CLI 系は実行前にここで即エラーにする。
 * サーバ起動・migrate による新規作成は正当なので openSqlite 自体には手を入れない。
 */
export function assertControlDbExists(): void {
  if (!fs.existsSync(controlDbPath())) {
    throw new Error(`control.sqlite が見つかりません（DATA_DIR=${dataDir()} を確認してください）`)
  }
}
