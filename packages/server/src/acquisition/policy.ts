import fs from 'node:fs'
import type { ClassificationPolicy } from '@kanean/shared'
import path from 'node:path'
import { dataDir } from '../config.js'
import { policyFile } from './paths.js'

/**
 * 分類方針（[docs/classification-policy.md]）を**外部クライアントへ渡せるデータ**として持つ。
 *
 * スキル経路（Claude Code）は `docs/` を直接読めたが、Claude Desktop にファイルシステムは無い。
 * 方針が届かないと、履歴の無い品名は「一般知識だけ」で判断されることになり、
 * とくに §法的に決定的な項目（利息の源泉・国税/地方税）が伝わらない。
 *
 * 置き場所は較正データと同じ考え方（design D3）:
 *   同梱の既定（読み取り専用） ← いつでも戻れる
 *   $DATA_DIR/acquisition/classification-policy.md ← あれば優先。UI から編集する
 *
 * **受け取るのは文章だけ**。ここに書かれたものは AI への指示であって、
 * アプリの動作（期間ゲート・冪等・科目検証）を変える力は持たない。
 */

/** 上限。会話へ毎回載るものなので、際限なく膨らませない。 */
export const MAX_POLICY_BYTES = 20_000

export class PolicyTooLargeError extends Error {
  readonly code = 'policy_too_large'
  constructor(bytes: number) {
    super(`分類方針が大きすぎます（${bytes} バイト / 上限 ${MAX_POLICY_BYTES}）`)
    this.name = 'PolicyTooLargeError'
  }
}

/**
 * 同梱の既定。`docs/classification-policy.md` の要点を、会話に載せられる分量へ畳んだもの。
 * 詳細版は docs にあり、そちらが設計の正（ここは配布物に含める実務用の抜粋）。
 */
export const BUNDLED_POLICY = `# 分類方針（既定）

この方針は Kanean の設定画面から編集できます。あなたの事業に合わせて例を足してください。

## 大原則

- **推測で科目を作らない。** 判断がつかないものは分類せずに残す（未確定のままでよい）。
- 事業と私用が混ざる。**私用は「事業主貸」**（経費にしない）。
- 迷ったら経費にしない側へ倒す。過大計上より未確定のほうが安全。

## 適用の優先順位

1. 過去の確定履歴（history として渡されるもの）。同じ摘要・品名があればそれに倣う。
2. 下の決定的ルール。
3. 品名・摘要からの判断。
4. どれでもなければ **分類しない**。

## 決定的な項目（必ずこの科目にする・未確定にしない）

| 摘要・品名 | 科目 |
|---|---|
| 受取利息・普通預金利息 | 事業主借（利息は事業所得ではない） |
| 国税・地方税の引き落とし（所得税・住民税・予定納税） | 事業主貸 |
| 消費税の納付 | 租税公課 |
| 国民健康保険・国民年金 | 事業主貸（経費ではない・確定申告の所得控除） |
| 生命保険料・個人の保険 | 事業主貸 |
| クレジットカードの引き落とし（銀行側） | 未払金の decrease（費用にしない・カード側で計上済み） |
| 現金の引き出し（ATM） | 事業主貸 |

## よくある科目

- 通信費 … 携帯・回線・ドメイン・サーバ
- 消耗品費 … 1件10万円未満の備品・文具
- 新聞図書費 … 書籍・技術文書・有料記事
- 支払手数料 … 振込手数料・決済手数料・各種サービス利用料
- 旅費交通費 … 電車・タクシー・宿泊
- 会議費 … 打ち合わせの飲食（1人あたり少額）
- 接待交際費 … 取引先との飲食・贈答
- 水道光熱費 … 電気・ガス・水道
- 外注費 … 業務委託・制作委託

## ガード

- 同じ取引を2つの経路で計上しない（カード利用は**カード側**、銀行の引き落としは未払金の消込）。
- 10万円以上の備品は消耗品費にしない（固定資産の判断が要る＝分類せずに残す）。
- 判断の理由を1行で添える。確定する人がそれを読んで判断する。
`

export function policyPath(dir = dataDir()): string {
  return policyFile(dir)
}


export function getPolicy(dir = dataDir()): ClassificationPolicy {
  const file = policyPath(dir)
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8')
    // 空ファイルは「消したつもり」とみなして既定へ倒す（空の方針を配ると害しかない）
    if (text.trim() !== '') return { text, origin: 'override', bundled: BUNDLED_POLICY }
  }
  return { text: BUNDLED_POLICY, origin: 'bundled', bundled: BUNDLED_POLICY }
}

export function setPolicy(text: string, dir = dataDir()): ClassificationPolicy {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_POLICY_BYTES) throw new PolicyTooLargeError(bytes)
  const file = policyPath(dir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return getPolicy(dir)
}

/** 上書きを消して同梱の既定へ戻す。 */
export function resetPolicy(dir = dataDir()): ClassificationPolicy & { hadOverride: boolean } {
  const file = policyPath(dir)
  const existed = fs.existsSync(file)
  if (existed) fs.rmSync(file)
  return { ...getPolicy(dir), hadOverride: existed }
}
