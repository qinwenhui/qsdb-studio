// 危险 SQL 二次确认：异步 Promise 化的确认队列。
//
// 执行路径（单条/批量/参数弹窗回调）都先 await 这里；弹窗组件只负责显示。
// 关闭弹窗 = 取消；不会静默合并两次确认。

import { reactive } from 'vue'
import type { SqlAnalysis } from '../utils/sqlRisk'

export interface DangerousItem {
  /** 语句起始行（1 基，用于提示用户具体位置）。 */
  line: number
  sql: string
  analysis: SqlAnalysis
}

export interface DangerRequest {
  items: DangerousItem[]
  profileName: string
  profileColor: string
  /** 必须原样输入的确认文本；null = 普通确认。 */
  typingText: string | null
}

export const dangerState = reactive<{
  visible: boolean
  request: DangerRequest | null
}>({
  visible: false,
  request: null,
})

let resolver: ((ok: boolean) => void) | null = null

/** 请求一次确认；返回用户是否同意执行。 */
export function confirmDangerous(request: DangerRequest): Promise<boolean> {
  if (resolver) {
    const prev = resolver
    resolver = null
    prev(false)
  }
  dangerState.request = request
  dangerState.visible = true
  return new Promise<boolean>((resolve) => {
    resolver = resolve
  })
}

/** 弹窗收尾（确认/取消/关闭）。 */
export function settleDanger(ok: boolean): void {
  const r = resolver
  resolver = null
  dangerState.visible = false
  dangerState.request = null
  r?.(ok)
}
