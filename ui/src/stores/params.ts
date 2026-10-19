// 参数弹窗状态 + 内存草稿缓存（不落盘）。

import { reactive } from 'vue'
import type { ParamInput } from '../ipc/types'
import { paramsFromDrafts, sqlKey, type ParamDraft } from '../utils/params'

const cache = new Map<string, ParamDraft[]>()

export const paramsState = reactive({
  visible: false,
  sql: '',
  count: 0,
  drafts: [] as ParamDraft[],
})

let onConfirm: ((params: ParamInput[]) => void) | null = null

export function openParams(
  sql: string,
  count: number,
  confirm: (params: ParamInput[]) => void,
) {
  const saved = cache.get(sqlKey(sql))
  paramsState.sql = sql
  paramsState.count = count
  paramsState.drafts = Array.from({ length: count }, (_, i) => {
    const prev = saved?.[i]
    return prev ? { ty: prev.ty, value: prev.value } : { ty: '', value: '' }
  })
  paramsState.visible = true
  onConfirm = confirm
}

export function confirmParams() {
  const params = paramsFromDrafts(paramsState.drafts)
  cache.set(
    sqlKey(paramsState.sql),
    paramsState.drafts.map((d) => ({ ty: d.ty, value: d.value })),
  )
  paramsState.visible = false
  const cb = onConfirm
  onConfirm = null
  cb?.(params)
}

export function cancelParams() {
  paramsState.visible = false
  onConfirm = null
}
