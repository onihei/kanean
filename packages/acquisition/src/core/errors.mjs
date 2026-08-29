// 巡回の失敗を「どの手順で・何が起きたか」の形に固定する（acquisition spec「失敗時の診断」）。
// 汎用の Error で片付けると、較正の見直しに必要な step / hint が失われる。

/** 終了コード契約（`.claude/skills/acquisition/SKILL.md` と一致させる）。 */
export const EXIT = { OK: 0, FAIL: 1, PROFILE_LOCKED: 2, PARTIAL: 4 }

export class ScrapeError extends Error {
  constructor(step, message, hint) {
    super(message)
    this.name = 'ScrapeError'
    this.step = step
    this.hint = hint
  }
}
