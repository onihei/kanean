// 巡回手順の登録簿。`source`（連携サービス識別子）から site モジュールを引く。
import * as ufjvisa from './ufjvisa.mjs'
import * as mufg from './mufg.mjs'
import * as shinsei from './shinsei.mjs'
import * as amazon from './amazon.mjs'
import * as rakuten from './rakuten.mjs'

const MODULES = [ufjvisa, mufg, shinsei, amazon, rakuten]

/** source → site モジュール（`card_mufg_visa` など）。 */
export const SITES = Object.fromEntries(MODULES.map((m) => [m.SOURCE, m]))

/** CLI・スキルが使う短い別名（`ufjvisa` など）。 */
export const ALIASES = Object.fromEntries(MODULES.map((m) => [m.EVIDENCE_KEY, m.SOURCE]))

export const SOURCES = MODULES.map((m) => m.SOURCE)

export function getSite(nameOrSource) {
  return SITES[nameOrSource] ?? SITES[ALIASES[nameOrSource]] ?? null
}
