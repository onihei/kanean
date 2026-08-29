import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { tmpDir } from '../config.js'
import type { DbRouter } from '../db/router.js'
import type { BookVariables } from '../books/middleware.js'
import { exportBookData } from '../ops/exportBook.js'
import { rfc5987 } from './helpers.js'

/**
 * フルデータエクスポート API（データ主権）。ユーザーの全データ（会計DB＋証憑＋manifest）を
 * zip で丸ごとダウンロードさせる。「解約＝データ人質」にしないための出口。
 *
 * 認証は無い（ローカル単一ユーザー・到達性がアクセス境界。CLAUDE.md）。対象帳簿は
 * マウント側の withBook が解決した c.get('bookId') を使う。
 * zip は $DATA_DIR/tmp/ に一度組成してからファイルストリームで返す（メモリに全載せしない）。
 * 送出完了・中断（stream close）で一時 zip を削除する。
 */

export function exportRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()

  app.get('/export', async (c) => {
    const bookId = c.get('bookId')

    const tmpZip = path.join(tmpDir(), `export-${randomUUID()}.zip`)
    try {
      const { byteSize } = await exportBookData(router, bookId, tmpZip)
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const filename = `kanean-export-${stamp}.zip`
      c.header('Content-Type', 'application/zip')
      c.header('Content-Disposition', `attachment; filename*=UTF-8''${rfc5987(filename)}`)
      c.header('Content-Length', String(byteSize))
      // ファイルストリームで返却し、close（送出完了・クライアント切断とも）で一時 zip を削除。
      const stream = fs.createReadStream(tmpZip)
      stream.once('close', () => fs.rm(tmpZip, { force: true }, () => {}))
      return c.body(Readable.toWeb(stream) as unknown as ReadableStream)
    } catch (e) {
      fs.rmSync(tmpZip, { force: true })
      console.error('[export] エクスポートに失敗', e)
      return c.json({ error: 'エクスポートに失敗しました' }, 500)
    }
  })

  return app
}
