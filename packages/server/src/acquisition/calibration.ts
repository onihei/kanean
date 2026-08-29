import {
  CalibrationRejected,
  bundledVersion,
  clearOverride,
  getSite,
  mergeSelectors,
  readOverride,
  writeOverride,
  type Sel,
} from '@kanean/acquisition'
import { dataDir } from '../config.js'
import { UnknownSourceError } from './range.js'

/**
 * サイト較正の参照と更新（acquisition spec「サイト較正の外出しと更新」）。
 * 受け付けるのは**データのみ**。検証は `@kanean/acquisition` 側が持ち、ここは置き場所を与えるだけ。
 */

export interface CalibrationView {
  source: string
  origin: 'bundled' | 'override'
  version: string
  overridden: string[]
  /** 同梱の較正（これが「戻す先」）。 */
  bundled: Sel
  /** 実際に使われる較正。 */
  effective: Sel
  /** `page.goto` へ渡るキー（http/https しか受け付けない）。 */
  navigableKeys: string[]
}

function siteOf(source: string) {
  const site = getSite(source)
  if (!site) throw new UnknownSourceError(source)
  return site
}

export function getCalibration(source: string): CalibrationView {
  const site = siteOf(source)
  const override = readOverride(dataDir(), source)
  const { sel, calibration } = mergeSelectors(source, site.DEFAULT_SEL, override, site.NAVIGABLE_KEYS)
  return {
    source,
    origin: calibration.origin,
    version: calibration.version,
    overridden: calibration.overridden,
    bundled: site.DEFAULT_SEL,
    effective: sel,
    navigableKeys: site.NAVIGABLE_KEYS,
  }
}

/**
 * 較正を更新する。拒否された場合は理由を添えて投げる（既存の上書きは壊さない）。
 * **プログラムに相当するものは受け付けない**（銀行のログイン済みセッションで任意コードを動かさない）。
 */
export function updateCalibration(source: string, patch: unknown): CalibrationView {
  const site = siteOf(source)
  writeOverride(dataDir(), source, site.DEFAULT_SEL, patch, site.NAVIGABLE_KEYS)
  return getCalibration(source)
}

/** 上書きを消して同梱較正へ戻す（壊れた較正からの復帰）。 */
export function resetCalibration(source: string): CalibrationView & { hadOverride: boolean } {
  const site = siteOf(source)
  const { existed } = clearOverride(dataDir(), source)
  return {
    ...getCalibration(source),
    version: bundledVersion(site.DEFAULT_SEL),
    hadOverride: existed,
  }
}

export { CalibrationRejected }
