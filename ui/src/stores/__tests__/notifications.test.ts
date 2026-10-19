import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResultTab } from '../query'
import {
  clearNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationsState,
  notify,
  notifyQueryFinished,
  resetNotifications,
  unreadNotifications,
} from '../notifications'
import { uiState } from '../ui'

beforeEach(() => {
  resetNotifications()
  uiState.activeEditorKey = 'active'
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-18T10:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  resetNotifications()
})

describe('notify', () => {
  it('adds newest first and dedupes identical content inside 5s', () => {
    const first = notify({ kind: 'error', title: '查询失败', detail: 'boom', code: 'X' })
    vi.advanceTimersByTime(2000)
    const second = notify({ kind: 'error', title: '查询失败', detail: 'boom', code: 'X' })
    expect(second.id).toBe(first.id)
    expect(notificationsState.items).toHaveLength(1)
    expect(second.at).toBe(Date.now())

    // 合并会刷新时间戳（滑动窗口）：持续重复的事件仍合并成一条，
    // 直到安静超过 5s 后再次出现才记新的一条。
    vi.advanceTimersByTime(6000)
    notify({ kind: 'error', title: '查询失败', detail: 'boom', code: 'X' })
    expect(notificationsState.items).toHaveLength(2)
  })

  it('caps the list at 200 entries keeping the newest', () => {
    for (let i = 0; i < 205; i++) {
      vi.advanceTimersByTime(1)
      notify({ kind: 'info', title: `事件 ${i}` })
    }
    expect(notificationsState.items).toHaveLength(200)
    expect(notificationsState.items[0].title).toBe('事件 204')
    expect(notificationsState.items[199].title).toBe('事件 5')
  })

  it('tracks unread state per item and in bulk', () => {
    const a = notify({ kind: 'info', title: 'A' })
    notify({ kind: 'warn', title: 'B' })
    expect(unreadNotifications.value).toBe(2)
    markNotificationRead(a.id)
    expect(unreadNotifications.value).toBe(1)
    expect(markAllNotificationsRead()).toBe(1)
    expect(unreadNotifications.value).toBe(0)
  })

  it('clear removes every entry', () => {
    notify({ kind: 'info', title: 'A' })
    clearNotifications()
    expect(notificationsState.items).toEqual([])
  })
})

function resultTab(overrides: Partial<ResultTab> = {}): ResultTab {
  return {
    key: 'res-1',
    editorKey: 'active',
    profileName: 'dev',
    title: 'SELECT 1',
    startedAt: Date.now(),
    result: { kind: 'rows', rowCount: 3 } as ResultTab['result'],
    stream: null,
    error: null,
    ...overrides,
  } as ResultTab
}

describe('notifyQueryFinished', () => {
  it('skips quick foreground successes but records slow ones', () => {
    notifyQueryFinished(resultTab(), 'ok')
    expect(notificationsState.items).toHaveLength(0)

    notifyQueryFinished(resultTab({ startedAt: Date.now() - 3500 }), 'ok')
    expect(notificationsState.items).toHaveLength(1)
    expect(notificationsState.items[0].title).toBe('查询完成')
    expect(notificationsState.items[0].target).toMatchObject({
      kind: 'result',
      editorKey: 'active',
      tabKey: 'res-1',
    })
  })

  it('records successes from background editor tabs immediately', () => {
    notifyQueryFinished(resultTab({ editorKey: 'other' }), 'ok')
    expect(notificationsState.items[0].title).toBe('后台查询完成')
  })

  it('always records failures but not user cancellations', () => {
    notifyQueryFinished(
      resultTab({
        error: { kind: 'api', code: 'PARSE_ERROR', message: 'bad sql', retriable: false },
      }),
      'error',
    )
    expect(notificationsState.items[0]).toMatchObject({
      kind: 'error',
      title: '查询失败',
      code: 'PARSE_ERROR',
    })

    resetNotifications()
    notifyQueryFinished(
      resultTab({
        error: {
          kind: 'api',
          code: 'QUERY_CANCELLED',
          message: 'cancelled',
          retriable: false,
        },
      }),
      'error',
    )
    expect(notificationsState.items).toHaveLength(0)
  })
})
