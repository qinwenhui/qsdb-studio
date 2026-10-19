import { describe, expect, it } from 'vitest'
import type { AppNotification, NotificationInput } from '../notifications'
import {
  countUnread,
  excessCount,
  findDuplicate,
  markEveryRead,
} from '../notifications'

function item(
  id: string,
  at: number,
  overrides: Partial<AppNotification> = {},
): AppNotification {
  return {
    id,
    at,
    read: false,
    kind: 'error',
    title: '查询失败',
    detail: 'boom',
    code: 'PARSE_ERROR',
    ...overrides,
  }
}

describe('findDuplicate', () => {
  it('merges only identical unread notifications inside the window', () => {
    const items = [item('a', 1000)]
    const same: NotificationInput = {
      kind: 'error',
      title: '查询失败',
      detail: 'boom',
      code: 'PARSE_ERROR',
    }
    expect(findDuplicate(items, same, 4000)?.id).toBe('a')
    expect(findDuplicate(items, same, 7001)).toBeNull()
    expect(
      findDuplicate(items, { ...same, title: 'CSV 导入失败' }, 2000),
    ).toBeNull()
  })

  it('does not merge into an already-read notification', () => {
    const items = [item('a', 1000, { read: true })]
    expect(
      findDuplicate(
        items,
        { kind: 'error', title: '查询失败', detail: 'boom', code: 'PARSE_ERROR' },
        2000,
      ),
    ).toBeNull()
  })
})

describe('countUnread / markEveryRead / excessCount', () => {
  it('counts and marks only unread items', () => {
    const items = [item('a', 1), item('b', 2, { read: true }), item('c', 3)]
    expect(countUnread(items)).toBe(2)
    expect(markEveryRead(items)).toBe(2)
    expect(countUnread(items)).toBe(0)
    expect(markEveryRead(items)).toBe(0)
  })

  it('reports how many entries exceed the cap', () => {
    expect(excessCount([], 2)).toBe(0)
    expect(excessCount([1, 2], 2)).toBe(0)
    expect(excessCount([1, 2, 3, 4], 2)).toBe(2)
  })
})
