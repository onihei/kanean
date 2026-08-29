/**
 * テスト検証用の最小 zip リーダ（セントラルディレクトリ走査）。
 * ライタ（ops/zip.ts）とは独立に EOCD→セントラルディレクトリ→ローカルヘッダを構造で辿り、
 * 生成物が ZIP 仕様として自己整合していることを検証する。STORE（無圧縮）のみ対応。
 */

export interface ReadZipEntry {
  name: string
  data: Buffer
  /** セントラルディレクトリに記録された CRC-32。 */
  crc: number
  /** 汎用フラグ（bit11=UTF-8 名の検証用）。 */
  flags: number
  /** 圧縮方式（STORE=0 の検証用）。 */
  method: number
}

/** zip バイト列を走査してエントリ一覧を返す。構造不整合は例外。 */
export function readZip(buf: Buffer): ReadZipEntry[] {
  // EOCD（0x06054b50）を末尾から後方走査（コメント無し前提だが頑健に探す）。
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('EOCD が見つかりません')
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const cdSize = buf.readUInt32LE(eocd + 12)
  if (cdOffset + cdSize !== eocd) throw new Error('セントラルディレクトリの位置/サイズが不整合')

  const entries: ReadZipEntry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('セントラルディレクトリ署名が不正')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    if (size !== compSize) throw new Error(`STORE なのに圧縮前後サイズが不一致: ${name}`)

    // ローカルヘッダから実データ位置を解決（ローカル側の name/extra 長を使う）。
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ローカルヘッダ署名が不正')
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const data = Buffer.from(buf.subarray(dataStart, dataStart + compSize))

    entries.push({ name, data, crc, flags, method })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * ライタと独立な CRC-32 参照実装（テーブルなしビット逐次）。
 * ops/zip.ts のテーブル実装と相互検証するために別方式で書く。
 */
export function crc32Reference(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}
