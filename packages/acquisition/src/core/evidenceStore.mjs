// 証跡（`--evidence` / business_settings.evidence_capture）の置き場所。
// アプリ経路では `$DATA_DIR/acquisition/evidence/<key>/…`（会計データと同じ領域＝バックアップ対象）。
// **巡回のログイン状態はここには入らない**（あれはパスワード級の秘密。design D7）。
import path from 'node:path'
import { fileEvidenceStore } from './fileStores.mjs'

export function evidenceDir(dataDir, key) {
  return path.join(dataDir, 'acquisition', 'evidence', key)
}

export function dataDirEvidenceStore(dataDir, key, enabled) {
  return fileEvidenceStore(evidenceDir(dataDir, key), enabled)
}
