import { describe, expect, it } from 'vitest'
import {
  cycleKey,
  nextTabTitle,
  parseWorkspace,
  pickNeighbor,
  reorderKeys,
  sanitizeView,
} from '../workspace'

describe('parseWorkspace', () => {
  it('restores tabs, active key and sequence', () => {
    const raw = JSON.stringify({
      tabs: [
        { key: 'a', title: 'SQL 1', sql: 'SELECT 1', profileId: 'p1', stream: true },
        { key: 'b', title: 'SQL 2', sql: 'SELECT 2', profileId: null, stream: false },
      ],
      activeKey: 'b',
      seq: 2,
    })
    expect(parseWorkspace(raw)).toEqual({
      tabs: [
        {
          key: 'a',
          title: 'SQL 1',
          sql: 'SELECT 1',
          profileId: 'p1',
          stream: true,
          filePath: null,
          savedSql: null,
          view: { cursor: 0, scrollTop: 0 },
          database: null,
        },
        {
          key: 'b',
          title: 'SQL 2',
          sql: 'SELECT 2',
          profileId: null,
          stream: false,
          filePath: null,
          savedSql: null,
          view: { cursor: 0, scrollTop: 0 },
          database: null,
        },
      ],
      activeKey: 'b',
      seq: 2,
    })
  })

  it('rejects corrupt or empty state instead of half-restoring', () => {
    expect(parseWorkspace(null)).toBeNull()
    expect(parseWorkspace('not json')).toBeNull()
    expect(parseWorkspace('{"tabs":[]}')).toBeNull()
    expect(parseWorkspace('{"tabs":[{"key":""}]}')).toBeNull()
    // 类型不对的标签整体丢弃。
    expect(parseWorkspace('{"tabs":[{"key":"a","title":"x","sql":1}]}')).toBeNull()
  })

  it('drops duplicate keys and falls back to the first tab', () => {
    const raw = JSON.stringify({
      tabs: [
        { key: 'dup', title: 'A', sql: 'a', profileId: null, stream: false },
        { key: 'dup', title: 'B', sql: 'b', profileId: null, stream: false },
        { key: 'ok', title: 'C', sql: 'c', profileId: 'p', stream: false },
      ],
      activeKey: 'missing',
      seq: 99,
    })
    const parsed = parseWorkspace(raw)
    expect(parsed?.tabs.map((t) => t.title)).toEqual(['A', 'C'])
    expect(parsed?.activeKey).toBe('dup')
    expect(parsed?.seq).toBe(99)
  })

  it('repairs an implausible sequence number', () => {
    const raw = JSON.stringify({
      tabs: [
        { key: 'a', title: 'A', sql: '', profileId: null, stream: false },
        { key: 'b', title: 'B', sql: '', profileId: null, stream: false },
      ],
      activeKey: 'a',
      seq: 1,
    })
    expect(parseWorkspace(raw)?.seq).toBe(2)
  })

  it('treats non-string profileId and non-boolean stream as absent', () => {
    const raw = JSON.stringify({
      tabs: [{ key: 'a', title: 'A', sql: '', profileId: 42, stream: 'yes' }],
    })
    expect(parseWorkspace(raw)?.tabs[0]).toMatchObject({
      profileId: null,
      stream: false,
      filePath: null,
      savedSql: null,
    })
  })

  it('restores file path and saved content for dirty tracking', () => {
    const raw = JSON.stringify({
      tabs: [
        {
          key: 'a',
          title: 'q.sql',
          sql: 'SELECT 2;',
          profileId: null,
          stream: false,
          filePath: 'D:/sql/q.sql',
          savedSql: 'SELECT 1;',
        },
      ],
    })
    const tab = parseWorkspace(raw)?.tabs[0]
    expect(tab?.filePath).toBe('D:/sql/q.sql')
    expect(tab?.savedSql).toBe('SELECT 1;')
  })

  it('restores cursor and scroll position, clamping to the saved SQL length', () => {
    const raw = JSON.stringify({
      tabs: [
        {
          key: 'a',
          title: 'A',
          sql: 'SELECT 1',
          view: { cursor: 999, scrollTop: 123.4 },
        },
        {
          key: 'b',
          title: 'B',
          sql: 'SELECT 2',
          view: { cursor: -3, scrollTop: 'down' },
        },
      ],
    })
    const tabs = parseWorkspace(raw)?.tabs ?? []
    expect(tabs[0].view).toEqual({ cursor: 8, scrollTop: 123 })
    expect(tabs[1].view).toEqual({ cursor: 0, scrollTop: 0 })
  })
})

describe('sanitizeView', () => {
  it('rejects non-finite / negative / non-numeric values', () => {
    expect(sanitizeView(null)).toEqual({ cursor: 0, scrollTop: 0 })
    expect(sanitizeView({ cursor: Number.NaN, scrollTop: -1 })).toEqual({
      cursor: 0,
      scrollTop: 0,
    })
    expect(sanitizeView({ cursor: '3', scrollTop: Infinity })).toEqual({
      cursor: 0,
      scrollTop: 0,
    })
  })

  it('rounds and clamps to the supplied document length', () => {
    expect(sanitizeView({ cursor: 99.6, scrollTop: 42.7 }, 10)).toEqual({
      cursor: 10,
      scrollTop: 43,
    })
    expect(sanitizeView({ cursor: 3.2, scrollTop: 50_000_001 }, 10)).toEqual({
      cursor: 3,
      scrollTop: 50_000_000,
    })
  })
})

describe('nextTabTitle', () => {
  it('numbers tabs from 1 and ignores fractional input', () => {
    expect(nextTabTitle(1)).toBe('SQL 1')
    expect(nextTabTitle(7.8)).toBe('SQL 7')
    expect(nextTabTitle(0)).toBe('SQL 1')
  })
})

describe('pickNeighbor', () => {
  it('prefers the left neighbor, then the right, then empty', () => {
    expect(pickNeighbor(['a', 'b', 'c'], 'b')).toBe('a')
    expect(pickNeighbor(['a', 'b', 'c'], 'c')).toBe('b')
    expect(pickNeighbor(['a', 'b', 'c'], 'a')).toBe('b')
    expect(pickNeighbor(['a'], 'a')).toBe('')
    expect(pickNeighbor([], 'a')).toBe('')
  })
})

describe('reorderKeys', () => {
  it('moves a tab before the drop target', () => {
    expect(reorderKeys(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
    expect(reorderKeys(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'a', 'c', 'd'])
    expect(reorderKeys(['a', 'b'], 'a', 'a')).toEqual(['a', 'b'])
    expect(reorderKeys(['a', 'b'], 'x', 'b')).toEqual(['a', 'b'])
    expect(reorderKeys(['a', 'b'], 'a', 'missing')).toEqual(['b', 'a'])
  })
})

describe('cycleKey', () => {
  it('wraps in both directions and handles edge cases', () => {
    expect(cycleKey(['a', 'b', 'c'], 'a', 1)).toBe('b')
    expect(cycleKey(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(cycleKey(['a', 'b', 'c'], 'a', -1)).toBe('c')
    expect(cycleKey(['a'], 'a', 1)).toBeNull()
    expect(cycleKey(['a', 'b'], 'x', 1)).toBeNull()
  })
})

describe('workspace database selection', () => {
  it('restores a persisted target database and resets empty/non-string values', () => {
    const raw = JSON.stringify({
      tabs: [
        { key: 'a', title: 'A', sql: '', database: 'settle' },
        { key: 'b', title: 'B', sql: '', database: '   ' },
        { key: 'c', title: 'C', sql: '', database: 42 },
      ],
    })
    const tabs = parseWorkspace(raw)?.tabs ?? []
    expect(tabs.map((t) => t.database)).toEqual(['settle', null, null])
  })
})
