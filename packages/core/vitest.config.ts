import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // vitest 4 は既定 exclude から dist を外した（tsc が dist/__tests__ にもテストを出すため二重実行になる）。
    exclude: ['**/node_modules/**', '**/dist/**'],
    globals: true,
    passWithNoTests: true,
  },
})
