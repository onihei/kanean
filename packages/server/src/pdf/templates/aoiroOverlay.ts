import type { DigitCell } from '../digitCells.js'

/**
 * 官製様式PDF（青色申告決算書 一般用）への座標オーバーレイ定義（外部データ化）。
 *
 * テンプレ = assets/forms/aoiro_r05.pdf（国税庁様式を gs 正規化した提出用4ページ）。
 * 各欄の座標（pt・左下原点）をここに集約する。本テンプレは MediaBox と embedPages 後の
 * 描画空間が一致する（kakutei/shohi と異なりオフセットなし。ラスタ照合で確認済み）。
 * 年度様式が変わったらテンプレ差替え＋本座標の再較正で対応する（aoiroOverlay.ts は描画ロジックのみ）。
 *
 * ページ1（損益計算書）の金額欄と P2 月別表の計行は1桁1マスの手書き用セルなので、
 * DigitCell（右端マス中心 x・マス帯中心 y）に1桁ずつ差込む（digitCells.ts）。
 * 較正の実測値（桁マス罫線のラスタ解析。2026-06 較正）:
 *   - P1 の桁マスはピッチ 13.84・マス帯高 14。先頭（左端）マスのみ幅広（約25pt）＋通常マス7個。
 *   - 右端マス中心は 左列（売上原価・経費前半）=293.75／中列（経費後半）=531.2／
 *     右列（繰戻繰入・所得）=768.5。
 *   - 行はセクションごとに等間隔（ピッチ 17.5）だが区切り帯が挟まるため行ごとに実測値を持つ。
 * P2 月別表の1〜12月・P3 減価償却・P4 貸借対照表はマスのない自由記入欄（右寄せ差込のまま）。
 */

export interface OverlayTemplate {
  /** assets/forms 配下のテンプレファイル名。 */
  template: string
  /** assets/fonts 配下の埋込フォント。 */
  font: string
  /** 桁マス差込のフォントサイズ（マス帯高14に対する手書き相当の大きさ）。 */
  digitSize: number
  /** 桁マスのピッチ。 */
  cellPitch: number
  /** ページ index（0始まり）ごとの桁マス座標。 */
  pages: Record<string, DigitCell>[]
}

/** P1 損益計算書の右端マス中心 x（左列／中列／右列）。 */
const P1_LEFT_X = 293.75
const P1_MID_X = 531.2
const P1_RIGHT_X = 768.5

// ページ1（損益計算書）。3列: 左(売上原価・経費前半) / 中(経費後半) / 右(繰戻繰入・所得)。
const P1: Record<string, DigitCell> = {
  // 左列
  'AOIRO.PL.SALES': { x: P1_LEFT_X, y: 354.25 }, // ① 売上（収入）金額
  'AOIRO.PL.OPEN_STOCK': { x: P1_LEFT_X, y: 328.08 }, // ② 期首商品棚卸高
  'AOIRO.PL.PURCHASE': { x: P1_LEFT_X, y: 310.58 }, // ③ 仕入金額
  'AOIRO.PL.SUBTOTAL_COST': { x: P1_LEFT_X, y: 293.08 }, // ④ 小計
  'AOIRO.PL.CLOSE_STOCK': { x: P1_LEFT_X, y: 275.75 }, // ⑤ 期末商品棚卸高
  'AOIRO.PL.COST': { x: P1_LEFT_X, y: 258.25 }, // ⑥ 差引原価
  'AOIRO.PL.GROSS': { x: P1_LEFT_X, y: 232.08 }, // ⑦ 差引金額（売上総利益）
  'AOIRO.PL.EXP_TAX': { x: P1_LEFT_X, y: 205.92 }, // ⑧ 租税公課
  'AOIRO.PL.EXP_PACK': { x: P1_LEFT_X, y: 188.42 }, // ⑨ 荷造運賃
  'AOIRO.PL.EXP_UTIL': { x: P1_LEFT_X, y: 170.92 }, // ⑩ 水道光熱費
  'AOIRO.PL.EXP_TRAVEL': { x: P1_LEFT_X, y: 153.42 }, // ⑪ 旅費交通費
  'AOIRO.PL.EXP_COMM': { x: P1_LEFT_X, y: 136.0 }, // ⑫ 通信費
  'AOIRO.PL.EXP_AD': { x: P1_LEFT_X, y: 118.58 }, // ⑬ 広告宣伝費
  'AOIRO.PL.EXP_ENT': { x: P1_LEFT_X, y: 101.08 }, // ⑭ 接待交際費
  'AOIRO.PL.EXP_INS': { x: P1_LEFT_X, y: 83.58 }, // ⑮ 損害保険料
  'AOIRO.PL.EXP_REPAIR': { x: P1_LEFT_X, y: 66.08 }, // ⑯ 修繕費
  // 中列（⑰消耗品費〜㉔貸倒金, ㉕-㉚空欄, ㉛雑費, ㉜計, ㉝差引金額）
  'AOIRO.PL.EXP_SUPPLY': { x: P1_MID_X, y: 362.92 }, // ⑰ 消耗品費
  'AOIRO.PL.EXP_DEP': { x: P1_MID_X, y: 345.58 }, // ⑱ 減価償却費
  'AOIRO.PL.EXP_WELFARE': { x: P1_MID_X, y: 328.08 }, // ⑲ 福利厚生費
  'AOIRO.PL.EXP_SALARY': { x: P1_MID_X, y: 310.58 }, // ⑳ 給料賃金
  'AOIRO.PL.EXP_OUTSRC': { x: P1_MID_X, y: 293.08 }, // ㉑ 外注工賃
  'AOIRO.PL.EXP_INTEREST': { x: P1_MID_X, y: 275.75 }, // ㉒ 利子割引料
  'AOIRO.PL.EXP_RENT': { x: P1_MID_X, y: 258.25 }, // ㉓ 地代家賃
  'AOIRO.PL.EXP_BADDEBT': { x: P1_MID_X, y: 240.75 }, // ㉔ 貸倒金
  // 空欄行は官製様式では6行（㉕〜㉚）。rank3 は最大7行を割当てうるが BLANK_7 は本様式に枠がないため
  // オーバーレイでは描かない（7件目の空欄科目は稀。自前レイアウトPDF では表示される）。
  'AOIRO.PL.EXP_BLANK_1': { x: P1_MID_X, y: 223.29 },
  'AOIRO.PL.EXP_BLANK_2': { x: P1_MID_X, y: 205.92 },
  'AOIRO.PL.EXP_BLANK_3': { x: P1_MID_X, y: 188.42 },
  'AOIRO.PL.EXP_BLANK_4': { x: P1_MID_X, y: 170.92 },
  'AOIRO.PL.EXP_BLANK_5': { x: P1_MID_X, y: 153.42 },
  'AOIRO.PL.EXP_BLANK_6': { x: P1_MID_X, y: 136.0 },
  'AOIRO.PL.EXP_MISC': { x: P1_MID_X, y: 118.58 }, // ㉛ 雑費
  'AOIRO.PL.EXP_TOTAL': { x: P1_MID_X, y: 101.08 }, // ㉜ 経費計
  'AOIRO.PL.NET_BEFORE_ADJ': { x: P1_MID_X, y: 74.92 }, // ㉝ 差引金額（⑦−㉜）
  // 右列（繰戻額等㉞・繰入額等㊳㊴・㊸㊹㊺）
  'AOIRO.PL.RESERVE_BACK': { x: P1_RIGHT_X, y: 362.92 }, // ㉞ 貸倒引当金（繰戻額等）
  'AOIRO.PL.SENJU': { x: P1_RIGHT_X, y: 293.08 }, // ㊳ 専従者給与
  'AOIRO.PL.RESERVE_IN': { x: P1_RIGHT_X, y: 275.75 }, // ㊴ 貸倒引当金（繰入額等）
  'AOIRO.PL.INCOME_BEFORE': { x: P1_RIGHT_X, y: 205.88 }, // ㊸ 青色申告特別控除前の所得金額
  'AOIRO.PL.BLUE_DEDUCT': { x: P1_RIGHT_X, y: 188.42 }, // ㊹ 青色申告特別控除額
  'AOIRO.PL.INCOME': { x: P1_RIGHT_X, y: 162.25 }, // ㊺ 所得金額
}

// ===== ページ3: 減価償却費の計算（表形式） =====
// 罫線抽出（scripts/extractBoxes.mts <page> grid）で得た縦罫17本＝16列、横罫＝行ピッチ約18pt。
// 列の右端 x は各列の右罫線−内側パディング。データ行は上から asset 0,1,… に対応。
export interface ColDef {
  /** DepreciationRow から取り出すフィールドキー（描画ロジック側で解決）。 */
  field: string
  /** 配置基準 x（right=右端 / left=左端 / center=中央）。 */
  x: number
  align: 'left' | 'right' | 'center'
  /** baseline からの y シフト（ニ償却期間の分子など、セル上部に置く用）。 */
  yOffset?: number
  size?: number
}
export interface TableDef {
  cols: ColDef[]
  /** データ行の baseline y（上→下）。最大 rowY.length 行を描画。 */
  rowY: number[]
  /** 計（合計）行の baseline y。 */
  totalRowY: number
  size: number
}

// 抽出した縦罫: 59.2 118.1 147.6 177.0 243.3 309.6 339.0 368.5 397.9 427.4 486.3 545.2 604.1 633.5 692.5 751.4 810.2
const P3_DEPRECIATION: TableDef = {
  size: 8,
  cols: [
    { field: 'name', x: 61, align: 'left' }, // 名称等 [59-118]
    { field: 'qty', x: 145, align: 'right' }, // 面積又は数量 [118-148]
    { field: 'acquired', x: 149, align: 'left', size: 7 }, // 取得年月 [148-177]
    { field: 'cost', x: 240, align: 'right' }, // イ取得価額 [177-243]
    { field: 'basis', x: 306, align: 'right' }, // ロ償却の基礎 [243-310]
    { field: 'method', x: 324, align: 'center', size: 7 }, // 償却方法 [310-339]
    { field: 'life', x: 365, align: 'right' }, // 耐用年数 [339-369]
    { field: 'rate', x: 395, align: 'right', size: 7 }, // ハ償却率 [369-398]
    { field: 'months', x: 408, align: 'center', size: 7, yOffset: 7 }, // ニ償却期間 分子 [398-427]
    { field: 'dep', x: 483, align: 'right' }, // ホ普通償却費 [427-486]
    { field: 'special', x: 542, align: 'right' }, // ヘ割増(特別) [486-545]
    { field: 'total', x: 601, align: 'right' }, // ト合計 [545-604]
    { field: 'ratio', x: 631, align: 'right' }, // チ事業専用割合 [604-634]
    { field: 'expense', x: 690, align: 'right' }, // リ必要経費算入額 [634-693]
    { field: 'closing', x: 749, align: 'right' }, // ヌ未償却残高 [693-751]
  ],
  // 様式のデータ行は6行（罫線抽出＋ルーラー較正で確定）。7件目以降は本表に載らないが計には反映。
  rowY: [224, 206.1, 188.2, 170.3, 152.5, 134.6],
  totalRowY: 118,
}

// ===== ページ4: 貸借対照表 =====
// 資産の部（左）と負債・資本の部（右）は同じ行 y を共有（罫線抽出＋較正で確定）。
// データ行は 1..24（行0＝列見出し）。金額は各列の右端 x に右寄せ。空欄行は科目名を左寄せ。
export interface BsTableDef {
  /** 資産 期首/期末・負債 期首/期末 の金額右端 x。 */
  assetKishu: number
  assetKimatsu: number
  liabKishu: number
  liabKimatsu: number
  /** 空欄行の科目名 左端 x（資産側 / 負債側）。 */
  assetLabelX: number
  liabLabelX: number
  /** データ行 baseline y（添字1..24、0は未使用）。 */
  rowY: number[]
  /** 合計行 baseline y。 */
  totalY: number
  size: number
  labelSize: number
}

// 列の右端 x は罫線実測（資産: 科目[64.9..148.8]/期首[..232.6]/期末[..315.4]、
// 負債: 科目[317.4..400.2]/期首[..484.1]/期末[..567.9]）から内側マージン3.5を引いた値。
const P4_BALANCE_SHEET: BsTableDef = {
  assetKishu: 229,
  assetKimatsu: 312,
  liabKishu: 480.5,
  liabKimatsu: 564.5,
  assetLabelX: 70,
  liabLabelX: 322,
  // 罫線抽出（行ピッチ約17.4pt）＋ルーラー較正。rowY[0] はダミー。
  rowY: [0, 473.4, 456, 438.8, 421.6, 404.4, 386.1, 368.5, 351.2, 333.7, 316.2, 298.8, 281.4, 263.9, 246.4, 229, 211.5, 194.1, 176.6, 159.1, 142.5, 124.2, 107.4, 89.3, 71.8],
  totalY: 54,
  size: 8,
  labelSize: 7,
}

// ===== ページ2: 月別売上仕入・各種内訳・青色申告特別控除額の計算 =====
export interface P2Def {
  // 月別売上(収入)金額及び仕入金額（1〜12月は自由記入欄・計行のみ桁マス）
  monthly: {
    salesX: number // 売上(収入)金額 右端（1〜12月）
    purchaseX: number // 仕入金額 右端（1〜12月）
    rowY: number[] // 1..12月 baseline
    totalSales: DigitCell // 計（売上）の桁マス
    totalPurchase: DigitCell // 計（仕入）の桁マス
    size: number
  }
  // 給料賃金の内訳（氏名＋合計のみ／詳細列は未対応）
  salary: { nameX: number; amountX: number; rowY: number[]; totalY: number; size: number; labelSize: number }
  // 専従者給与の内訳
  senju: { nameX: number; amountX: number; rowY: number[]; totalY: number; size: number; labelSize: number }
  // 地代家賃の内訳（支払先＋必要経費算入額）
  rent: { nameX: number; rentX: number; expenseX: number; rowY: number[]; size: number; labelSize: number }
  // 青色申告特別控除額の計算（⑦控除前所得・⑨控除額）
  deduction: { valueX: number; incomeBeforeY: number; deduction65Y: number; deduction10Y: number; size: number }
  // 貸倒引当金繰入額の計算（金額列右端 valueX・①〜⑤の baseline。rowY[0] はダミー）
  reserve: { valueX: number; rowY: number[]; size: number }
}

const P2: P2Def = {
  monthly: {
    salesX: 212,
    purchaseX: 340,
    rowY: [467, 450, 432.5, 415, 398, 381, 363.5, 346, 329, 312, 294.5, 277],
    // 計行は桁マス（マス帯中心 y=223.42・右端マス中心 売上=211.46／仕入=337.17）
    totalSales: { x: 211.46, y: 223.42 },
    totalPurchase: { x: 337.17, y: 223.42 },
    size: 8,
  },
  // 右側: 罫線抽出（横罫[358-778]）＋実描画較正で確定。氏名は左寄せ、金額は合計(支給)列右端へ右寄せ。
  // 給料賃金の内訳: 氏名 / 合計列右端680（源泉列ではない）。データ3行＋計。
  salary: { nameX: 362, amountX: 680, rowY: [481, 464, 446], totalY: 412, size: 8, labelSize: 8 },
  // 専従者給与の内訳: 続柄列があるが 支給列は給料表と縦位置共通。データ3行＋計。
  senju: { nameX: 362, amountX: 680, rowY: [341, 324, 306], totalY: 289, size: 8, labelSize: 8 },
  // 地代家賃の内訳: 支払先 / 本年中の賃借料・必要経費算入額（賃借料サブ行）。データ2件。
  rent: { nameX: 362, rentX: 715, expenseX: 802, rowY: [228, 190], size: 8, labelSize: 8 },
  // 青色申告特別控除額の計算: ⑦控除前所得・⑨青色申告特別控除額（65/55万 or 10万ケースの最終行）。
  deduction: { valueX: 808, incomeBeforeY: 123, deduction65Y: 88, deduction10Y: 53, size: 9 },
  // 貸倒引当金繰入額の計算（左下）: 金額列右端352・①〜⑤（rowY[0]ダミー）。ルーラー較正・行ピッチ17.5。
  reserve: { valueX: 352, rowY: [0, 125, 107.5, 90, 72.5, 55], size: 8 },
}

export const AOIRO_OVERLAY: OverlayTemplate = {
  template: 'aoiro_r05.pdf',
  font: 'ipaexg.ttf',
  digitSize: 12,
  cellPitch: 13.84,
  pages: [P1, {}, {}, {}],
}

export const TABLES = {
  p2: P2,
  p3Depreciation: P3_DEPRECIATION,
  p4BalanceSheet: P4_BALANCE_SHEET,
}
