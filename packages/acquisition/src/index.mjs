// @kanean/acquisition の公開面。巡回手順の実体は sites/ にあり、殻は runtime/ にある。
export { EXIT, ScrapeError } from './core/errors.mjs'
export { parseArgs, SCRAPE_ARG_SPEC } from './core/args.mjs'
export { yen, isoDate } from './core/normalize.mjs'
export { verifyBalanceChain } from './core/verify.mjs'
export { BROWSER_API } from './core/page.mjs'
export { makeRunner, captureDiagnostic } from './core/runner.mjs'
export { redactHtml, redactUrl } from './core/redact.mjs'
export {
  validateSelectors,
  mergeSelectors,
  bundledVersion,
  CalibrationRejected,
} from './core/selectors.mjs'
export {
  selectorsDir,
  selectorsPath,
  readOverride,
  writeOverride,
  clearOverride,
} from './core/calibrationStore.mjs'
export { diagnosticsDir, dataDirDiagnosticsSink, readDiagnostic } from './core/diagnosticsStore.mjs'
export { evidenceDir, dataDirEvidenceStore } from './core/evidenceStore.mjs'
export { pdfToText, layoutFromItems } from './core/pdfText.mjs'
export { SITES, SOURCES, ALIASES, getSite } from './sites/index.mjs'
export { runScrape, NO_EVIDENCE } from './run.mjs'
