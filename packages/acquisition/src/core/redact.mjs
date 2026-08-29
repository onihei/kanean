// 診断に認証情報とセッション識別子を残さないための伏字化（acquisition spec「認証情報を診断に残さない」）。
// 診断は人にも AI にも渡る。渡してよいのは「画面がどうなっていたか」だけで、
// 「誰としてログインしていたか」は渡してはならない。

/** URL のクエリ・フラグメントに紛れるセッション識別子を伏せる。 */
const SECRET_PARAM = /^(.*(sid|session|token|ticket|auth|key|pass|otp|jsessionid|phpsessid).*)$/i

export function redactUrl(rawUrl) {
  if (rawUrl == null) return null
  let url
  try {
    url = new URL(String(rawUrl))
  } catch {
    return String(rawUrl)
  }
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_PARAM.test(name)) url.searchParams.set(name, '[REDACTED]')
  }
  // フラグメントは中身を解釈せず、値らしきものが載っていれば丸ごと落とす
  if (url.hash && /=/.test(url.hash)) url.hash = '#[REDACTED]'
  return url.toString()
}

/**
 * HTML から入力値と秘密を落とす。
 * `page.content()` は基本的に「初期の属性値」を返すため人の打鍵はそもそも載らないが、
 * SPA が value 属性へ書き戻す実装もあるので、入力欄の値は一律で伏せる。
 */
export function redactHtml(html) {
  if (html == null) return null
  return (
    String(html)
      // <input ... value="..."> の値（type を問わず一律）
      .replace(/(<input\b[^>]*?\bvalue=)(["'])(?:(?!\2)[\s\S])*\2/gi, '$1$2[REDACTED]$2')
      // <textarea>...</textarea> の中身
      .replace(/(<textarea\b[^>]*>)[\s\S]*?(<\/textarea>)/gi, '$1[REDACTED]$2')
      // hidden な CSRF/セッショントークンを持つ meta
      .replace(
        /(<meta\b[^>]*\bname=["'][^"']*(?:csrf|token|session)[^"']*["'][^>]*\bcontent=)(["'])(?:(?!\2)[\s\S])*\2/gi,
        '$1$2[REDACTED]$2'
      )
  )
}
