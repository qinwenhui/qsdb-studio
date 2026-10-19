import { describe, expect, it } from 'vitest'
import {
  addRecentTarget,
  loadRecentTargets,
  parseRecentTargets,
  RECENT_COPY_TARGETS_KEY,
  recentTargetValue,
  saveRecentTargets,
  type RecentCopyTarget,
} from '../copyTargets'

describe('recent COPY targets', () => {
  it('dedupes by format + target and keeps newest first', () => {
    let list = addRecentTarget([], 'exports/a', 'parquet', 1)
    list = addRecentTarget(list, 'exports/b', 'csv', 2)
    list = addRecentTarget(list, 'exports/a', 'parquet', 3)
    expect(list.map((r) => `${r.format}:${r.target}`)).toEqual([
      'parquet:exports/a',
      'csv:exports/b',
    ])
    expect(list[0].at).toBe(3)
    // 同路径不同格式是两条（CSV 单文件 vs Parquet 目录）。
    list = addRecentTarget(list, 'exports/a', 'csv', 4)
    expect(list).toHaveLength(3)
  })

  it('caps the list and ignores blank targets', () => {
    let list: RecentCopyTarget[] = []
    for (let i = 0; i < 12; i++) list = addRecentTarget(list, `exports/${i}`, 'parquet', i)
    expect(list).toHaveLength(8)
    expect(list[0].target).toBe('exports/11')
    expect(addRecentTarget(list, '   ', 'parquet', 99)).toEqual(list)
  })

  it('tolerates malformed persisted data instead of guessing', () => {
    expect(parseRecentTargets(null)).toEqual([])
    expect(parseRecentTargets([{ target: 'x' }])).toEqual([])
    expect(
      parseRecentTargets([
        { target: ' ok ', format: 'csv', at: 5 },
        { target: ' ok ', format: 'csv', at: 6 },
        { target: 42, format: 'csv' },
        { target: 'y', format: 'parquet', at: 'bad' },
      ]),
    ).toEqual([
      { target: 'ok', format: 'csv', at: 5 },
      { target: 'y', format: 'parquet', at: 0 },
    ])
  })

  it('round-trips through storage and survives broken JSON', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
    saveRecentTargets(storage, [{ target: 'exports/x', format: 'parquet', at: 7 }])
    expect(loadRecentTargets(storage)).toEqual([
      { target: 'exports/x', format: 'parquet', at: 7 },
    ])
    expect(store.has(RECENT_COPY_TARGETS_KEY)).toBe(true)
    store.set(RECENT_COPY_TARGETS_KEY, '{not json')
    expect(loadRecentTargets(storage)).toEqual([])
  })

  it('builds unique select values', () => {
    expect(recentTargetValue({ target: 'a', format: 'csv', at: 0 })).toBe('csv|a')
    expect(recentTargetValue({ target: 'a', format: 'parquet', at: 0 })).toBe('parquet|a')
  })
})
