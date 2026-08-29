// 金額・日付の正規化。純関数＝殻（Playwright / Electron）によらず同一の結果になる。

const Z2H = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))

// '￥1,234' '1,234円' '１２３４' '-1,234' '▲1,234' → 円整数（解釈不能は null）
export function yen(s) {
  if (s == null) return null
  let t = Z2H(String(s)).replace(/[\s,，円￥¥]/g, '')
  let sign = 1
  if (/^[-−－▲△]/.test(t)) {
    sign = -1
    t = t.slice(1)
  }
  if (!/^\d+$/.test(t)) return null
  return sign * parseInt(t, 10)
}

// 'YYYY/M/D' 'YYYY-MM-DD' 'YYYY年M月D日' 'M月D日'(+yearHint) → ISO 'YYYY-MM-DD'（不能は null）
export function isoDate(s, yearHint) {
  if (s == null) return null
  const t = Z2H(String(s)).trim()
  let m = /^(\d{4})[/年.-](\d{1,2})[/月.-](\d{1,2})日?/.exec(t)
  if (!m && yearHint) {
    // 年なし「M/D」「M月D日」「M.D」「M-D」を yearHint で補完（MUFG新サイトは "4/10" 形式）
    const md = /^(\d{1,2})[/月.-](\d{1,2})日?/.exec(t)
    if (md) m = [null, String(yearHint), md[1], md[2]]
  }
  if (!m) return null
  const [y, mo, d] = [m[1], m[2], m[3]].map((x) => parseInt(x, 10))
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
