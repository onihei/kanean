// 自己検算（acquisition spec「取得結果の自己検算」）。純関数＝殻によらず同一に働く。

// 古い順の {amount, direction, balance} で残高チェーンを検証（銀行トラックの生命線）
export function verifyBalanceChain(txns) {
  for (let i = 1; i < txns.length; i++) {
    const prev = txns[i - 1]
    const cur = txns[i]
    const expected = prev.balance + (cur.direction === 'in' ? cur.amount : -cur.amount)
    if (cur.balance !== expected) {
      return { ok: false, index: i, expected, actual: cur.balance, row: cur }
    }
  }
  return { ok: true }
}
