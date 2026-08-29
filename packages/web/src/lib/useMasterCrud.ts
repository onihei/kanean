import { useEffect, useState } from 'react'
import { okMsg, errMsg } from '../components/common.js'
import type { MsgState } from '../components/common.js'

/**
 * マスタ CRUD パネルの状態機械（issue #133 = C6）。
 * 取引先・補助科目・部門・品目・自動仕訳ルールの5パネルで同文だった
 * rows / editId / form / msg / busy と reload → reset → startEdit → save → toggle の遷移を1本化する。
 *
 * フックが持つのは**状態機械だけ**。ペイロード変換（0→null 等）・追加の参照マスタ読込・
 * 削除（確認ダイアログ付き）はパネル側のクロージャに残す（issue の注意どおり）。
 * TagsPanel は編集の無い別機械なので対象外。
 */
export interface MasterCrudOpts<Row, Form> {
  /** 一覧の読込（絞り込み条件はクロージャで参照し、変化は第2引数 reloadDeps で伝える）。 */
  load: () => Promise<Row[]>
  /** 新規フォームの初期値。 */
  empty: Form
  idOf: (row: Row) => number
  /** 行 → 編集フォーム（編集開始時）。 */
  toForm: (row: Row) => Form
  create: (form: Form) => Promise<unknown>
  update: (id: number, form: Form) => Promise<unknown>
  /** 有効/無効トグル（!row.isActive の反転はクロージャ側で）。 */
  setActive: (row: Row) => Promise<unknown>
  /** 保存ボタンの活性条件（必須項目チェック）。 */
  canSave: (form: Form) => boolean
}

export function useMasterCrud<Row, Form>(opts: MasterCrudOpts<Row, Form>, reloadDeps: unknown[] = []) {
  const [rows, setRows] = useState<Row[]>([])
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState<Form>(opts.empty)
  const [msg, setMsg] = useState<MsgState>(null)
  const [busy, setBusy] = useState(false)

  const reload = () => opts.load().then(setRows).catch((e) => setMsg(errMsg(e)))
  useEffect(() => {
    void reload()
    // 絞り込み条件（includeInactive / accountId 等）は load クロージャが読む＝依存は呼び出し側が列挙する
    // （useReport と同じ設計。リテラル配列でない deps への警告は意図的なので抑止）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, reloadDeps)

  const reset = () => {
    setEditId(null)
    setForm(opts.empty)
  }
  const startEdit = (row: Row) => {
    setEditId(opts.idOf(row))
    setForm(opts.toForm(row))
  }
  const save = async () => {
    if (!opts.canSave(form)) return
    setBusy(true)
    setMsg(null)
    try {
      if (editId) await opts.update(editId, form)
      else await opts.create(form)
      reset()
      await reload()
      setMsg(okMsg('保存しました'))
    } catch (e) {
      setMsg(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const toggle = (row: Row) => opts.setActive(row).then(reload).catch((e) => setMsg(errMsg(e)))

  return { rows, editId, form, setForm, msg, setMsg, busy, reload, reset, startEdit, save, toggle }
}
