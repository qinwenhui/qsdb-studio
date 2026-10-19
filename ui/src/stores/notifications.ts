// 会话内通知中心：后台查询收尾、CSV 导入、watch 重置等可回看的事件。
//
// 设计边界：
// - **不落盘**：错误/详情可能含 SQL 片段；只在内存保留，退出即清。
// - **不替代 toast**：行内错误区/横幅仍是一等反馈；这里负责“当时没看到”。
// - 同内容短窗口合并，最多 200 条，避免轮询/重连把列表刷爆。
// - 每条可带跳转目标（结果页 / 面板）；目标失效时由 UI 显式提示。

import { computed, reactive } from 'vue'
import { formatCount, formatMs } from '../utils/format'
import {
  countUnread,
  excessCount,
  findDuplicate,
  markEveryRead,
  type AppNotification,
  type NotificationInput,
} from '../utils/notifications'
import type { ResultTab } from './query'
import { uiState } from './ui'

import { t, tt } from '../i18n'

export const notificationsState = reactive({
  items: [] as AppNotification[],
})

export const unreadNotifications = computed(() =>
  countUnread(notificationsState.items),
)

let seq = 0

function nextId(): string {
  seq += 1
  return `ntf-${Date.now()}-${seq}`
}

/** 记一条通知（同内容 5s 内合并；返回最终保留的那条）。 */
export function notify(input: NotificationInput): AppNotification {
  const now = Date.now()
  const duplicate = findDuplicate(notificationsState.items, input, now)
  if (duplicate) {
    duplicate.at = now
    return duplicate
  }
  const item: AppNotification = {
    ...input,
    id: nextId(),
    at: now,
    read: false,
  }
  notificationsState.items.unshift(item)
  const excess = excessCount(notificationsState.items)
  if (excess > 0) notificationsState.items.splice(notificationsState.items.length - excess)
  return item
}

export function markNotificationRead(id: string): void {
  const item = notificationsState.items.find((n) => n.id === id)
  if (item) item.read = true
}

export function markAllNotificationsRead(): number {
  return markEveryRead(notificationsState.items)
}

export function removeNotification(id: string): void {
  const idx = notificationsState.items.findIndex((n) => n.id === id)
  if (idx >= 0) notificationsState.items.splice(idx, 1)
}

export function clearNotifications(): void {
  notificationsState.items.splice(0, notificationsState.items.length)
}

/** 测试用：清空并重置 id 序列。 */
export function resetNotifications(): void {
  clearNotifications()
  seq = 0
}

function resultTarget(tab: ResultTab) {
  return {
    kind: 'result' as const,
    editorKey: tab.editorKey,
    tabKey: tab.key,
  }
}

function rowCountOf(tab: ResultTab): number | null {
  if (tab.stream) return tab.stream.totalRows
  if (tab.result?.kind === 'rows') return tab.result.rowCount
  return null
}

/**
 * 查询收尾：失败总是记录；成功只在“后台标签”或耗时 ≥3s 时记录。
 * 前台秒回的小查询不制造噪声（结果页本身就是反馈）。
 * 用户主动取消不记录：结果页横幅已经说明“不是完整结果”。
 */
export function notifyQueryFinished(tab: ResultTab, outcome: 'ok' | 'error'): void {
  const elapsed = Math.max(0, Date.now() - tab.startedAt)
  if (outcome === 'ok') {
    const background = tab.editorKey !== uiState.activeEditorKey
    if (!background && elapsed < 3000) return
    const rows = rowCountOf(tab)
    const parts = [tab.profileName]
    if (rows !== null) parts.push(tt`${formatCount(rows)} 行`)
    parts.push(formatMs(elapsed))
    notify({
      kind: 'success',
      title: background ? t('后台查询完成') : t('查询完成'),
      detail: `${tab.title} · ${parts.join(' · ')}`,
      target: resultTarget(tab),
    })
    return
  }

  const err = tab.error ?? tab.stream?.error ?? null
  if (!err || err.code === 'QUERY_CANCELLED') return
  notify({
    kind: 'error',
    title: t('查询失败'),
    code: err.code ?? err.kind,
    detail: `${tab.title}\n${err.message}`,
    target: resultTarget(tab),
  })
}
