import type { ImportConflict } from '@kanean/shared'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Hono } from 'hono'
import { tmpDir } from '../config.js'
import type { DbRouter } from '../db/router.js'
import {
  importBookData,
  ImportConflictError,
  ImportValidationError,
  type ImportMode,
} from '../ops/importBook.js'

/**
 * エクスポート zip の取り込み API（restorable-export）。`GET /api/export` の対であり、
 * 「エクスポートは復元可能な持ち出しである」を成立させる側（data-ops spec）。
 *
 * **`withBook` より前にマウントする**（bookRoutes と同じ理由）。取り込みは control plane への
 * 帳簿登録であって、対象帳簿を指定して行う操作ではない。取り込み先が「まだ帳簿が無い環境」で
 * あることも普通にあるので、帳簿解決を前提にしてはならない。
 *
 * ボディは **zip の生バイト列**（multipart にしない）。multipart は formData() で全体をメモリに
 * 載せるが、証憑を含むエクスポートは数百MBになりうる。生ボディならディスクへストリームで
 * 落とせて、以降は ops/importBook がファイルとして扱える。
 */

/** 受け付ける zip の上限。ライタ（ops/zip.ts）が ZIP64 非対応で 4GB 未満しか書けないため、これを超える入力は自前のエクスポートではありえない。 */
const MAX_ZIP_BYTES = 0xffffffff

const MODES: ImportMode[] = ['auto', 'new', 'replace']

export function importRoutes(router: DbRouter): Hono {
  const app = new Hono()

  app.post('/import', async (c) => {
    const rawMode = c.req.query('mode') ?? 'auto'
    if (!MODES.includes(rawMode as ImportMode)) {
      return c.json(
        { error: { code: 'validation_error', message: 'mode は auto / new / replace のいずれかです' } },
        400,
      )
    }
    const body = c.req.raw.body
    if (!body) {
      return c.json({ error: { code: 'validation_error', message: 'zip ファイルが空です' } }, 400)
    }

    // 受信は $DATA_DIR/tmp/（export と同じ。同一FS なので配置が rename で済み、権限も一貫する）。
    const tmpZip = path.join(tmpDir(), `import-${randomUUID()}.zip`)
    fs.mkdirSync(path.dirname(tmpZip), { recursive: true })
    try {
      let received = 0
      const counted = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])
      counted.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > MAX_ZIP_BYTES) counted.destroy(new Error('zip が大きすぎます'))
      })
      await pipeline(counted, fs.createWriteStream(tmpZip))

      const result = await importBookData(router, tmpZip, { mode: rawMode as ImportMode })
      return c.json(result, 201)
    } catch (e) {
      if (e instanceof ImportConflictError) {
        // 黙って置換も採番もしない。利用者が選ぶための材料（両方の帳簿名）を返す（design.md §5）。
        return c.json(
          {
            error: {
              code: 'book_id_conflict',
              message: '同じ帳簿IDが既に登録されています。別の帳簿として取り込むか、置換を選んでください',
            },
            conflict: { bookId: e.bookId, incomingName: e.incomingName, existingName: e.existingName } satisfies ImportConflict,
          },
          409,
        )
      }
      if (e instanceof ImportValidationError) {
        // 取り込めない理由は利用者が対処できる情報なので、そのまま返す（既存データは無傷）。
        return c.json({ error: { code: 'invalid_export', message: e.message } }, 400)
      }
      console.error('[import] 取り込みに失敗', e)
      return c.json({ error: { code: 'import_failed', message: '取り込みに失敗しました' } }, 500)
    } finally {
      fs.rmSync(tmpZip, { force: true })
    }
  })

  return app
}
