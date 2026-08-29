// EC 注文の突合と結果組み立て。純関数＝殻（Playwright / Electron）によらず同一の結果になる。
//
// amazon / rakuten の突合式・失敗理由テンプレート・末尾の結果組み立ては同文の二重実装だった。
// 金額の検算に直結するのでここへ抽出する。挙動（理由の文言・ログ・返り値の形）は抽出前と同一。

/**
 * 注文の突合: Σ lineAmount + shipping − pointsUsed == orderTotal。
 * 合わなければ**合わせ込まない**（按分・推測はしない。理由を付けて failedOrders へ）。
 *
 * @param {{lines: {lineAmount:number}[], shipping:number, pointsUsed:number, orderTotal:number}} order
 * @returns {{ok:true, sum:number} | {ok:false, sum:number, reason:string}}
 */
export function reconcileOrder({ lines, shipping, pointsUsed, orderTotal }) {
  const sum = lines.reduce((a, l) => a + l.lineAmount, 0)
  if (sum + shipping - pointsUsed === orderTotal) return { ok: true, sum }
  return {
    ok: false,
    sum,
    reason: `突合NG: Σline=${sum} + shipping=${shipping} − points=${pointsUsed} ≠ total=${orderTotal}`,
  }
}

/**
 * 明細へ 1 始まりの lineNo と証憑参照を付ける。
 *
 * @template {object} L
 * @param {L[]} lines
 * @param {unknown} evidenceRef
 * @returns {(L & {lineNo:number, evidenceRef:unknown})[]}
 */
export function withLineNumbers(lines, evidenceRef) {
  return lines.map((l, i) => ({ lineNo: i + 1, ...l, evidenceRef }))
}

/**
 * failedOrders の要素形をここで固定する（orderId / orderDate / reason のみ）。
 * `{...head, reason}` のスプレッドだと head にフィールドが増えたとき出力へ漏れる。
 *
 * @param {{orderId:string, orderDate:string|null}} head
 * @param {string} reason
 */
export function failedOrder(head, reason) {
  return { orderId: head.orderId, orderDate: head.orderDate, reason }
}

/**
 * EC 巡回の結果組み立て。failedOrders があれば PARTIAL（部分成功を黙って完了扱いにしない）。
 *
 * @param {object[]} orders 突合OKのみ
 * @param {{orderId:string, orderDate:string|null, reason:string}[]} failedOrders スキルが MCP で個別補完する対象
 * @param {string[]} warnings
 * @param {(msg: string) => void} log
 */
export function finishEcResult(orders, failedOrders, warnings, log) {
  const tail = failedOrders.length ? ` / 要MCP補完 ${failedOrders.length}件` : ''
  log(`${failedOrders.length ? 'PARTIAL' : 'OK'} 突合済 ${orders.length}件${tail}`)
  // partial/exitCode は run.mjs が FAILURE_GRANULARITY から導出する（二重判定にしない・issue #171）。
  return { orders, failedOrders, warnings }
}
