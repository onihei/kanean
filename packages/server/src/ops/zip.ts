import fs from 'node:fs'
import path from 'node:path'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw, inflateRawSync } from 'node:zlib'

/**
 * 依存追加なしの最小 ZIP ライタ／リーダ。フルデータエクスポート（データ主権）とその取り込み用。
 *
 * 構造: [ローカルファイルヘッダ＋名前＋データ]×N → セントラルディレクトリ×N → EOCD。
 * - 全エントリ UTF-8 ファイル名（汎用フラグ bit11）・無圧縮（method 0）・CRC-32 付き。
 * - 日付は DOS 形式（ローカル時刻・2秒精度・1980〜2107 年にクランプ）。
 *
 * 制限（ZIP64 非対応。超えたら明示エラー）:
 * - エントリ数 65535 まで / 1エントリ 4GB 未満 / zip 全体（オフセット表現）4GB 未満。
 * - 書き込みは無圧縮（STORE）のみ。SQLite・PDF・画像が主対象なので圧縮率より単純さを優先。
 * - ディレクトリエントリは書かない（解凍側がパスから作る）。
 *
 * リーダ（openZip）は**書き手を信用しない**前提で書く。取り込みの入力は利用者が選んだ
 * 外部ファイルであり、自分が書いた zip とは限らない:
 * - 読み出しは STORE に加えて DEFLATE も受ける（解凍→再 zip した書庫が普通に持ち込まれる）。
 * - 全オフセット・長さを範囲検査し、エントリ名のパス脱出を拒否する。
 * - 展開は宣言サイズで打ち切り、CRC-32 が合わなければ捨てる（zip bomb・破損の両方を弾く）。
 */

export interface ZipEntry {
  /** zip 内パス（'/' 区切り・UTF-8）。空・絶対パス・'..' セグメントは拒否。 */
  name: string
  /** Buffer=内容そのもの / string=読み込むファイルの絶対パス（書き込み時にエントリ毎に読む）。 */
  data: Buffer | string
  /** 更新日時（省略時: パス指定はファイルの mtime、Buffer は現在時刻）。 */
  mtime?: Date
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const FLAG_UTF8 = 0x0800 // 汎用フラグ bit11: ファイル名/コメントは UTF-8
const METHOD_STORE = 0
const METHOD_DEFLATE = 8 // 読み出しのみ対応（再 zip された書庫を受けるため）
const VERSION_20 = 20 // 2.0（STORE のみなので十分）
const MAX_UINT32 = 0xffffffff
const MAX_ENTRIES = 0xffff

// ---- CRC-32（IEEE 802.3 多項式 0xEDB88320・テーブル方式） ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** CRC-32 の途中状態を更新する（初期値 0xffffffff・最後に反転して確定）。 */
function crc32Update(state: number, buf: Buffer): number {
  let c = state
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c >>> 0
}

/** CRC-32 を計算する（zip エントリ検証用に公開）。 */
export function crc32(buf: Buffer): number {
  return (crc32Update(0xffffffff, buf) ^ 0xffffffff) >>> 0
}

// ---- DOS 日時 ----

/** DOS 形式の日時（ローカル時刻・2秒精度）。範囲（1980〜2107年）外はクランプ。 */
function dosDateTime(d: Date): { time: number; date: number } {
  const y = Math.min(2107, Math.max(1980, d.getFullYear()))
  const date = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  return { time, date }
}

// ---- エントリ名の検証（zip 内でのパス脱出を書き込み側でも遮断） ----

function assertSafeName(name: string): void {
  if (name.length === 0) throw new Error('zip エントリ名が空です')
  if (name.startsWith('/') || name.includes('\\')) {
    throw new Error(`zip エントリ名が不正です（絶対パス・バックスラッシュ不可）: ${name}`)
  }
  if (name.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new Error(`zip エントリ名にパス脱出（../ 等）が含まれます: ${name}`)
  }
}

// ---- 書き込み先の抽象（メモリ / ファイル逐次書き出し） ----

interface Sink {
  write(buf: Buffer): void
  readonly offset: number
}

class MemorySink implements Sink {
  readonly chunks: Buffer[] = []
  offset = 0
  write(buf: Buffer): void {
    this.chunks.push(buf)
    this.offset += buf.length
  }
}

class FileSink implements Sink {
  offset = 0
  constructor(private readonly fd: number) {}
  write(buf: Buffer): void {
    let done = 0
    while (done < buf.length) done += fs.writeSync(this.fd, buf, done, buf.length - done)
    this.offset += buf.length
  }
}

// ---- 本体 ----

interface CentralRecord {
  nameBytes: Buffer
  crc: number
  size: number
  time: number
  date: number
  localOffset: number
}

/** 全エントリ→セントラルディレクトリ→EOCD の順で sink へ書く（エントリ毎に read＝全載せしない）。 */
function writeAllTo(sink: Sink, entries: ZipEntry[]): void {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`エントリ数が ${MAX_ENTRIES} を超えています（ZIP64 非対応）: ${entries.length}`)
  }
  const records: CentralRecord[] = []
  for (const e of entries) {
    assertSafeName(e.name)
    const fromPath = typeof e.data === 'string'
    const body = fromPath ? fs.readFileSync(e.data as string) : (e.data as Buffer)
    if (body.length >= MAX_UINT32) {
      throw new Error(`4GB 以上のエントリは書けません（ZIP64 非対応）: ${e.name}`)
    }
    const mtime = e.mtime ?? (fromPath ? fs.statSync(e.data as string).mtime : new Date())
    const { time, date } = dosDateTime(mtime)
    const nameBytes = Buffer.from(e.name, 'utf8')
    const crc = crc32(body)
    const localOffset = sink.offset
    if (localOffset + 30 + nameBytes.length + body.length >= MAX_UINT32) {
      throw new Error('zip 全体が 4GB を超えます（ZIP64 非対応）')
    }
    // ローカルファイルヘッダ（30 bytes）＋名前＋データ。STORE なので圧縮前後サイズは同値。
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(SIG_LOCAL, 0)
    lfh.writeUInt16LE(VERSION_20, 4) // version needed to extract
    lfh.writeUInt16LE(FLAG_UTF8, 6)
    lfh.writeUInt16LE(METHOD_STORE, 8)
    lfh.writeUInt16LE(time, 10)
    lfh.writeUInt16LE(date, 12)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(body.length, 18) // compressed size
    lfh.writeUInt32LE(body.length, 22) // uncompressed size
    lfh.writeUInt16LE(nameBytes.length, 26)
    lfh.writeUInt16LE(0, 28) // extra field length
    sink.write(lfh)
    sink.write(nameBytes)
    sink.write(body)
    records.push({ nameBytes, crc, size: body.length, time, date, localOffset })
  }

  // セントラルディレクトリ（46 bytes×N＋名前）。
  const cdStart = sink.offset
  for (const r of records) {
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(SIG_CENTRAL, 0)
    cdh.writeUInt16LE(VERSION_20, 4) // version made by
    cdh.writeUInt16LE(VERSION_20, 6) // version needed to extract
    cdh.writeUInt16LE(FLAG_UTF8, 8)
    cdh.writeUInt16LE(METHOD_STORE, 10)
    cdh.writeUInt16LE(r.time, 12)
    cdh.writeUInt16LE(r.date, 14)
    cdh.writeUInt32LE(r.crc, 16)
    cdh.writeUInt32LE(r.size, 20)
    cdh.writeUInt32LE(r.size, 24)
    cdh.writeUInt16LE(r.nameBytes.length, 28)
    cdh.writeUInt16LE(0, 30) // extra field length
    cdh.writeUInt16LE(0, 32) // file comment length
    cdh.writeUInt16LE(0, 34) // disk number start
    cdh.writeUInt16LE(0, 36) // internal file attributes
    cdh.writeUInt32LE(0, 38) // external file attributes
    cdh.writeUInt32LE(r.localOffset, 42)
    sink.write(cdh)
    sink.write(r.nameBytes)
  }
  const cdSize = sink.offset - cdStart
  if (sink.offset + 22 >= MAX_UINT32) throw new Error('zip 全体が 4GB を超えます（ZIP64 非対応）')

  // EOCD（22 bytes・コメント無し）。
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4) // number of this disk
  eocd.writeUInt16LE(0, 6) // disk with central directory
  eocd.writeUInt16LE(records.length, 8)
  eocd.writeUInt16LE(records.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdStart, 16)
  eocd.writeUInt16LE(0, 20) // comment length
  sink.write(eocd)
}

/** zip をメモリ上に生成する（小さいエントリ集合向け）。 */
export function createZip(entries: ZipEntry[]): Buffer {
  const sink = new MemorySink()
  writeAllTo(sink, entries)
  return Buffer.concat(sink.chunks)
}

/**
 * zip をファイルへ逐次書き出す（証憑が大きい可能性に備え、全体をメモリに載せない。
 * メモリ使用は最大エントリ1個分）。失敗時は書きかけの outPath を残さない。
 */
export function writeZip(
  outPath: string,
  entries: ZipEntry[],
): { fileCount: number; byteSize: number } {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const fd = fs.openSync(outPath, 'w')
  const sink = new FileSink(fd)
  let ok = false
  try {
    writeAllTo(sink, entries)
    ok = true
  } finally {
    fs.closeSync(fd)
    if (!ok) fs.rmSync(outPath, { force: true })
  }
  return { fileCount: entries.length, byteSize: sink.offset }
}

// ---- 読み出し（取り込み） ----

/** zip 内の1エントリ。実データは持たず、位置と検証値だけを持つ（全載せしない）。 */
export interface ZipReadEntry {
  /** zip 内パス（'/' 区切り）。ディレクトリエントリは除外済み。 */
  name: string
  /** 展開後のバイト数（セントラルディレクトリの宣言値）。 */
  size: number
  /** 圧縮後のバイト数（STORE なら size と同値）。 */
  compressedSize: number
  /** 展開後データの CRC-32（宣言値。展開時に実測と突合する）。 */
  crc: number
  /** 圧縮方式（0=STORE / 8=DEFLATE）。 */
  method: number
  /** 実データの先頭オフセット（ローカルヘッダを解決済み）。 */
  dataOffset: number
}

/** 壊れた／期待しない形式の zip。取り込み層がこれを利用者向けの理由文に変える。 */
export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipFormatError'
  }
}

/** fd の position から length バイトを確実に読む（readSync の短読みを吸収）。 */
function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, position + done)
    if (n === 0) throw new ZipFormatError('zip が途中で終わっています')
    done += n
  }
  return buf
}

/**
 * 通過するバイトの CRC-32 を測りつつ、宣言サイズを超えた時点で打ち切る Transform。
 * DEFLATE の展開後サイズは圧縮データ次第でいくらでも大きくなりうる（zip bomb）ため、
 * 「セントラルディレクトリが宣言した size まで」を上限として構造的に縛る。
 */
class Crc32Meter extends Transform {
  private state = 0xffffffff
  bytes = 0
  constructor(private readonly limit: number) {
    super()
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length
    if (this.bytes > this.limit) {
      cb(new ZipFormatError('展開後のサイズが宣言値を超えました'))
      return
    }
    this.state = crc32Update(this.state, chunk)
    cb(null, chunk)
  }
  get crc(): number {
    return (this.state ^ 0xffffffff) >>> 0
  }
}

/** EOCD（末尾から後方走査）を見つけてセントラルディレクトリの位置を返す。 */
function findCentralDirectory(
  fd: number,
  fileSize: number,
): { cdOffset: number; cdSize: number; count: number } {
  if (fileSize < 22) throw new ZipFormatError('zip として小さすぎます')
  // EOCD は末尾 22 バイト＋最大 64KB のコメント。その範囲だけ読んで後方走査する。
  const tailLen = Math.min(fileSize, 22 + 0xffff)
  const tail = readAt(fd, fileSize - tailLen, tailLen)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    // 署名の偶然一致を避けるため、コメント長が末尾までの残りと一致することも要求する。
    if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipFormatError('zip の終端レコード（EOCD）が見つかりません')

  const count = tail.readUInt16LE(eocd + 10)
  const cdSize = tail.readUInt32LE(eocd + 12)
  const cdOffset = tail.readUInt32LE(eocd + 16)
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) {
    throw new ZipFormatError('分割 zip には対応していません')
  }
  if (count === MAX_ENTRIES || cdSize === MAX_UINT32 || cdOffset === MAX_UINT32) {
    throw new ZipFormatError('ZIP64 形式には対応していません')
  }
  if (cdOffset + cdSize > fileSize) {
    throw new ZipFormatError('セントラルディレクトリの位置/サイズが不整合です')
  }
  return { cdOffset, cdSize, count }
}

/**
 * zip を読むためのハンドル。**エントリの目録だけを保持**し、実データはファイルから
 * その都度読む（writeZip と同じく、メモリ使用は最大エントリ1個分に留める）。
 * 解析時に fd は閉じるので、呼び出し側に後始末を要求しない。
 */
export class ZipReader {
  constructor(
    /** 読み出し元ファイルの絶対パス。 */
    readonly file: string,
    readonly entries: ZipReadEntry[],
  ) {}

  /** 名前でエントリを引く（無ければ undefined）。 */
  entry(name: string): ZipReadEntry | undefined {
    return this.entries.find((e) => e.name === name)
  }

  /** 指定プレフィックス配下のエントリ（名前順）。 */
  under(prefix: string): ZipReadEntry[] {
    return this.entries.filter((e) => e.name.startsWith(prefix))
  }

  /**
   * 小さいエントリ（manifest 等）をメモリへ読む。CRC-32 と宣言サイズを検証する。
   * 大きいエントリは extractTo（ストリーム）を使う。maxBytes は宣言サイズに対する上限で、
   * 「manifest.json のはずが 1GB」のような入力をメモリに載せる前に弾く。
   */
  readEntry(entry: ZipReadEntry, maxBytes: number): Buffer {
    if (entry.size > maxBytes) {
      throw new ZipFormatError(`${entry.name} が大きすぎます（${entry.size} bytes）`)
    }
    if (entry.compressedSize === 0) return verifyBuffer(entry, Buffer.alloc(0))
    const fd = fs.openSync(this.file, 'r')
    let raw: Buffer
    try {
      raw = readAt(fd, entry.dataOffset, entry.compressedSize)
    } finally {
      fs.closeSync(fd)
    }
    if (entry.method !== METHOD_DEFLATE) return verifyBuffer(entry, raw)
    // 展開後は宣言サイズで縛る（zip bomb を maxBytes 超で膨らませない）。
    return verifyBuffer(entry, inflateRawSync(raw, { maxOutputLength: entry.size }))
  }

  /**
   * エントリを destPath へ展開する（ストリーム）。展開後に CRC-32 と宣言サイズを突合し、
   * 合わなければ書きかけを消して throw する（壊れた内容を配置したまま終わらせない）。
   */
  async extractTo(entry: ZipReadEntry, destPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    let ok = false
    try {
      if (entry.compressedSize === 0) {
        if (entry.size !== 0) throw new ZipFormatError(`${entry.name} の宣言サイズが不整合です`)
        fs.writeFileSync(destPath, Buffer.alloc(0))
      } else {
        const meter = new Crc32Meter(entry.size)
        const src = fs.createReadStream(this.file, {
          start: entry.dataOffset,
          end: entry.dataOffset + entry.compressedSize - 1,
        })
        const dest = fs.createWriteStream(destPath)
        if (entry.method === METHOD_DEFLATE) {
          await pipeline(src, createInflateRaw(), meter, dest)
        } else {
          await pipeline(src, meter, dest)
        }
        if (meter.bytes !== entry.size) {
          throw new ZipFormatError(`${entry.name} の展開サイズが宣言値と一致しません`)
        }
        if (meter.crc !== entry.crc) {
          throw new ZipFormatError(`${entry.name} の CRC-32 が一致しません（壊れています）`)
        }
      }
      ok = true
    } finally {
      if (!ok) fs.rmSync(destPath, { force: true })
    }
  }
}

/** 展開済みバイト列を宣言サイズ・CRC-32 と突合する。 */
function verifyBuffer(entry: ZipReadEntry, body: Buffer): Buffer {
  if (body.length !== entry.size) {
    throw new ZipFormatError(`${entry.name} の展開サイズが宣言値と一致しません`)
  }
  if (crc32(body) !== entry.crc) {
    throw new ZipFormatError(`${entry.name} の CRC-32 が一致しません（壊れています）`)
  }
  return body
}

/**
 * zip を解析してエントリ目録を作る。実データは読まない。
 * ディレクトリエントリ（名前が '/' で終わる）は読み飛ばし、それ以外は書き込み側と同じ
 * `assertSafeName` に通す（`../` を含む名前で $DATA_DIR の外へ書かせない）。
 */
export function openZip(file: string): ZipReader {
  const fileSize = fs.statSync(file).size
  const fd = fs.openSync(file, 'r')
  try {
    const { cdOffset, cdSize, count } = findCentralDirectory(fd, fileSize)
    const cd = readAt(fd, cdOffset, cdSize)
    const entries: ZipReadEntry[] = []
    let p = 0
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length) throw new ZipFormatError('セントラルディレクトリが途中で終わっています')
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) {
        throw new ZipFormatError('セントラルディレクトリの署名が不正です')
      }
      const method = cd.readUInt16LE(p + 10)
      const crc = cd.readUInt32LE(p + 16)
      const compressedSize = cd.readUInt32LE(p + 20)
      const size = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      const localOffset = cd.readUInt32LE(p + 42)
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) {
        throw new ZipFormatError('セントラルディレクトリが途中で終わっています')
      }
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8')
      p += 46 + nameLen + extraLen + commentLen

      // ディレクトリエントリ（解凍→再 zip した書庫に現れる）は目録に載せない。
      if (name.endsWith('/')) continue
      assertSafeName(name)
      if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
        throw new ZipFormatError(`未対応の圧縮方式です（${name}: method=${method}）`)
      }
      if (compressedSize === MAX_UINT32 || size === MAX_UINT32 || localOffset === MAX_UINT32) {
        throw new ZipFormatError('ZIP64 形式には対応していません')
      }
      if (localOffset + 30 > cdOffset) {
        throw new ZipFormatError(`ローカルヘッダの位置が不正です: ${name}`)
      }

      // 実データ位置はローカルヘッダの名前/拡張長で決まる（セントラル側の長さとは一致しない）。
      const lfh = readAt(fd, localOffset, 30)
      if (lfh.readUInt32LE(0) !== SIG_LOCAL) {
        throw new ZipFormatError(`ローカルヘッダの署名が不正です: ${name}`)
      }
      const dataOffset = localOffset + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28)
      if (dataOffset + compressedSize > cdOffset) {
        throw new ZipFormatError(`エントリのデータ範囲が不正です: ${name}`)
      }
      if (method === METHOD_STORE && compressedSize !== size) {
        throw new ZipFormatError(`STORE なのに圧縮前後サイズが不一致です: ${name}`)
      }

      entries.push({ name, size, compressedSize, crc, method, dataOffset })
    }
    return new ZipReader(file, entries)
  } finally {
    fs.closeSync(fd)
  }
}
