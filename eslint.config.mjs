import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // mobile/ は Flutter（Dart）。pnpm workspace は packages/* だけなので turbo からは
    // 見えないが、web プラットフォームを足すと JS が生えるため eslint には明示的に伏せる。
    ignores: ['**/dist/**', '**/node_modules/**', 'mobile/**'],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // React hooks の機械検査（issue #159）。web が唯一の React パッケージ。
    // exhaustive-deps は warn 始まり＝既存の依存もれを一度に直さない（順次解消してから error 化）。
    // v7 の React Compiler 系ルール（purity / set-state-in-effect 等）は既存コードの書き換えを
    // 伴うため未導入。入れるなら別 issue で。
    files: ['packages/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // 巡回パッケージは素の ESM(.mjs)。`page.evaluate` に渡すコールバックは**ページ内**で動くので、
    // 1つのファイルに Node のグローバルとブラウザのグローバルが同居する。
    files: ['packages/acquisition/**/*.mjs'],
    languageOptions: {
      globals: {
        // Node 側
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        structuredClone: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        TextEncoder: 'readonly',
        // page.evaluate の中（ブラウザ側）
        document: 'readonly',
        window: 'readonly',
        Event: 'readonly',
      },
    },
  },
)
