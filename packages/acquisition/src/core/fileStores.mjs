// 失敗診断シンク・証跡ストアのファイル実体（issue #166）。
// アプリ経路（$DATA_DIR 配下・core/diagnosticsStore, evidenceStore）と CLI/Playwright 経路
// （リポジトリ配下・runtime/playwright）は、ここへ**パスを渡すだけ**の薄いラッパになる。
// ファイル名（screenshot.png / page.html / error.json）は MCP の DiagnosticView.artifactsDir
// 契約でもあるため、この1箇所に固定する。
import fs from 'node:fs'
import path from 'node:path'

/**
 * 失敗診断シンク: dir を作り直して screenshot.png / page.html / error.json を書く。
 * @param {string} dir 書き込み先（latest ディレクトリ）
 * @param {{onWritten?: (dir: string) => void}} [opts] 書き終えた後のフック（CLI のログ等）
 */
export function fileDiagnosticsSink(dir, { onWritten } = {}) {
  return {
    dir,
    async dump(record) {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(dir, { recursive: true })
      const { html, screenshot, ...info } = record
      if (screenshot) fs.writeFileSync(path.join(dir, 'screenshot.png'), screenshot)
      if (html) fs.writeFileSync(path.join(dir, 'page.html'), html)
      fs.writeFileSync(path.join(dir, 'error.json'), JSON.stringify(info, null, 2) + '\n')
      onWritten?.(dir)
      return dir
    },
  }
}

/** 証跡ストア: enabled のときだけ baseDir 配下へ保存。ref は保存パス（無効時は fallback）。 */
export function fileEvidenceStore(baseDir, enabled) {
  return {
    enabled,
    async save(relPath, buffer) {
      if (!enabled) return null
      const full = path.join(baseDir, relPath)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, buffer)
      return full
    },
    ref(relPath, fallback) {
      return enabled ? path.join(baseDir, relPath) : fallback
    },
  }
}
