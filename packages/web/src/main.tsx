import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { normalizeLegacyTabParam } from './nav/route.js'
import './styles/app.css'
import './styles/forms.css'

// 旧形式 `?tab=…` のディープリンクを hash ルートへ読み替えてから描画する（issue #129）。
normalizeLegacyTabParam()

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
