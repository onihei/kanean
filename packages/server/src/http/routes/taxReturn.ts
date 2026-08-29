import type { BlueStatementReport } from '@kanean/shared'
import { Hono } from 'hono'
import type { DbRouter, DataDb } from '../../db/router.js'
import type { BookVariables } from '../../books/middleware.js'
import { buildBlueReturnStatement } from '../../reports/blueReturnStatement.js'
import { buildBlueBalanceSheet } from '../../reports/blueBalanceSheet.js'
import {
  depreciationBreakdown,
  salaryBreakdown,
  rentBreakdown,
  senjuBreakdown,
  monthlySalesPurchase,
  reserveAllowanceCalc,
} from '../../reports/breakdowns.js'
import { renderAoiroPage1 } from '../../pdf/aoiroPdf.js'
import { renderIncomeTaxReturn } from '../../pdf/incomeTaxPdf.js'
import { renderKakuteiOverlay } from '../../pdf/kakuteiOverlay.js'
import { renderConsumptionTaxReturn } from '../../pdf/consumptionTaxPdf.js'
import { renderShohiOverlay } from '../../pdf/shohiOverlay.js'
import { renderAoiroOverlay } from '../../pdf/aoiroOverlay.js'
import { buildConsumptionTaxReturn } from '../../taxreturn/consumptionTax.js'
import { buildBlueReturnSummary, setBlueDeductionETax } from '../../taxreturn/blueReturn.js'
import { buildIncomeTaxReturn, upsertTaxReturnInputs, type UpsertTaxReturnInputs } from '../../taxreturn/incomeTax.js'
import { postRewardSale, type PostRewardSaleInput } from '../../taxreturn/withholding.js'
import { bookHelpers, pdfResponse } from '../helpers.js'

/**
 * 税務申告ルート（消費税・青色決算書・確定申告書と各 PDF 出力）。
 * issue #114 で api.ts から分割（ハンドラは逐語移動・挙動不変）。
 */
export function taxReturnRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()
  const { dbOf, withOpenYearOrNull, requireOpenYear } = bookHelpers(router)

  /**
   * 様式 PDF の定型登録（B6=#118）: open 年度で描画し inline PDF で返す。
   * 描画失敗は入力起因でない（テンプレート・フォント等）ので 500 を保つ。
   */
  const pdfReport = (
    path: string,
    filename: string,
    render: (db: DataDb, fyId: number) => Promise<Uint8Array>,
  ): void => {
    app.get(path, async (c) => {
      const { db, fyId } = requireOpenYear(c)
      try {
        return pdfResponse(c, filename, await render(db, fyId))
      } catch (err) {
        return c.json({ error: (err as Error).message }, 500)
      }
    })
  }

  // 消費税及び地方消費税申告書（簡易課税。roadmap Phase4・税理士サインオフ前の参考値）。
  app.get('/tax-return/consumption', (c) => {
    const report = withOpenYearOrNull(c, (db, fyId) => buildConsumptionTaxReturn(db, fyId))
    return c.json({ report: report ?? null })
  })
  // 消費税申告書（簡易課税）のPDF出力（自前レイアウト・参考帳票）。
  pdfReport('/tax-return/consumption.pdf', '消費税申告書_簡易課税.pdf', renderConsumptionTaxReturn)
  // 官製様式PDF（消費税申告書 簡易課税 第一表）への座標オーバーレイ出力（参考帳票）。
  pdfReport('/tax-return/consumption-official.pdf', '消費税申告書_公式様式.pdf', renderShohiOverlay)
  // 青色申告特別控除㊹・所得金額㊺（青色決算書 損益。roadmap Phase4・税理士サインオフ前）。
  app.get('/tax-return/blue-deduction', (c) => {
    const report = withOpenYearOrNull(c, (db, fyId) => buildBlueReturnSummary(db, fyId))
    return c.json({ report: report ?? null })
  })
  app.post('/tax-return/blue-deduction/settings', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { qualifiesFor65?: boolean } | null
    if (typeof body?.qualifiesFor65 !== 'boolean') return c.json({ error: 'qualifiesFor65 (boolean) が必要' }, 400)
    setBlueDeductionETax(dbOf(c), body.qualifiesFor65)
    return c.json({ ok: true })
  })
  // 青色申告決算書（4ページ分の様式データを集約。Webの官製様式プレビュー用。各関数は (db,fyId) の純関数で
  // 官製様式PDF（blue-statement-official.pdf）と同じ集計を返すため、プレビューとPDFの金額は構造上一致する）。
  app.get('/tax-return/blue-statement', (c) =>
    c.json({
      report: withOpenYearOrNull(c, (db, fyId): BlueStatementReport => ({
        pl: buildBlueReturnStatement(db, fyId).pl, // 損益（FormBox: code/label/box/amount）
        balanceSheet: buildBlueBalanceSheet(db, fyId), // 貸借対照表（資産/負債・資本の期首・期末）
        summary: buildBlueReturnSummary(db, fyId), // ㊸㊹㊺ 青色申告特別控除額の計算
        monthly: monthlySalesPurchase(db, fyId), // 月別 売上仕入（12行＋年計）
        salary: salaryBreakdown(db, fyId), // 給料賃金の内訳
        senju: senjuBreakdown(db, fyId), // 専従者給与の内訳
        rent: rentBreakdown(db, fyId), // 地代家賃の内訳
        depreciation: depreciationBreakdown(db, fyId), // 減価償却費の計算
        reserveAllowance: reserveAllowanceCalc(db, fyId), // 貸倒引当金繰入額の計算
      })),
    }),
  )
  // 青色申告決算書（損益ページ）のPDF出力（rank2・自前レイアウト・参考帳票）。
  pdfReport('/tax-return/blue-statement.pdf', '青色申告決算書_損益.pdf', renderAoiroPage1)
  // 官製様式PDF（青色決算書 一般用）への座標オーバーレイ出力（損益ページ＝1枚目を差込済み・参考帳票）。
  pdfReport('/tax-return/blue-statement-official.pdf', '青色申告決算書_公式様式.pdf', renderAoiroOverlay)
  // 確定申告書 第一表・第二表（所得税。roadmap Phase4・担当human・税理士サインオフ前）。
  app.get('/tax-return/income-tax', (c) => {
    const report = withOpenYearOrNull(c, (db, fyId) => buildIncomeTaxReturn(db, fyId))
    return c.json({ report: report ?? null })
  })
  // 確定申告書 第一表・第二表のPDF出力（自前レイアウト・参考帳票）。
  pdfReport('/tax-return/income-tax.pdf', '確定申告書_第一表第二表.pdf', renderIncomeTaxReturn)
  // 官製様式PDF（確定申告書 第一表・第二表）への座標オーバーレイ出力（参考帳票）。
  pdfReport('/tax-return/income-tax-official.pdf', '確定申告書_公式様式.pdf', renderKakuteiOverlay)
  app.post('/tax-return/income-tax/inputs', async (c) => {
    const body = (await c.req.json().catch(() => null)) as UpsertTaxReturnInputs | null
    if (!body || typeof body !== 'object') return c.json({ error: 'JSON body が必要' }, 400)
    const { db, fyId } = requireOpenYear(c)
    upsertTaxReturnInputs(db, fyId, body)
    return c.json({ ok: true })
  })
  // 源泉徴収された報酬売上の複合仕訳を起票（accounting-spec §5）。
  app.post('/tax-return/withholding-sale', async (c) => {
    const body = (await c.req.json().catch(() => null)) as PostRewardSaleInput | null
    if (!body?.entryDate || typeof body.gross !== 'number') return c.json({ error: 'entryDate と gross が必要' }, 400)
    const { db, fyId } = requireOpenYear(c)
    return c.json({ result: postRewardSale(db, fyId, body) })
  })

  return app
}
