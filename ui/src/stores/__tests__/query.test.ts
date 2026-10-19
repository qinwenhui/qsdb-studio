import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryResult, WireValue } from '../../ipc/types'
import { appState } from '../app'
import { resetNotifications } from '../notifications'
import {
  applyTabFilters,
  countTotalRows,
  queryState,
  runSql,
  type ResultTab,
} from '../query'

vi.mock('../../ipc', () => ({
  sqlExecute: vi.fn(),
  connSession: vi.fn(),
  sqlCancel: vi.fn(),
  sqlStreamStart: vi.fn(),
  sqlStreamRelease: vi.fn(),
  isIpcError: () => false,
}))

import * as ipc from '../../ipc'

const sqlExecute = vi.mocked(ipc.sqlExecute)
const connSession = vi.mocked(ipc.connSession)

const COLUMN = { name: 'id', tag: 'i64' as const, typeName: 'BIGINT', nullable: false }

function pageResult(count: number): QueryResult {
  const rows: WireValue[][] = Array.from({ length: count }, (_, i) => [i + 1])
  return {
    kind: 'rows',
    columns: [COLUMN],
    rows,
    rowCount: count,
    elapsedMs: 1,
    truncated: false,
    warnings: [],
  }
}

function countResult(value: WireValue): QueryResult {
  return {
    kind: 'rows',
    columns: [COLUMN],
    rows: [[value]],
    rowCount: 1,
    elapsedMs: 1,
    truncated: false,
    warnings: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function connect() {
  appState.connections = {
    p1: {
      info: {
        profileId: 'p1',
        profileName: 'local',
        url: 'http://127.0.0.1:9430',
        version: '0.1.0',
        auth: { kind: 'none' },
      },
      session: null,
      databases: [],
      tables: [],
      metaLoading: false,
      defaultDb: 'default',
    },
  }
  appState.activeProfileId = 'p1'
}

async function seedTab(sql = 'SELECT * FROM sales'): Promise<ResultTab> {
  connect()
  sqlExecute.mockResolvedValueOnce(pageResult(501))
  return runSql('editor-1', 'p1', sql, { params: [] }, { stream: false, title: 'test' })
}

beforeEach(() => {
  vi.resetAllMocks()
  connSession.mockResolvedValue(null)
  queryState.tabs.splice(0, queryState.tabs.length)
  queryState.activeKeys = {}
  queryState.batchRunning = false
  resetNotifications()
})

afterEach(() => {
  appState.connections = {}
  appState.activeProfileId = null
})

describe('结果总行数统计', () => {
  it('counts the full result set with a separate, history-free query', async () => {
    const tab = await seedTab()
    expect(tab.hasNextPage).toBe(true)
    expect(tab.totalCount).toBeNull()

    sqlExecute.mockResolvedValueOnce(countResult(1200))
    const err = await countTotalRows(tab.key)

    expect(err).toBeNull()
    expect(tab.totalCount).toBe('1200')
    expect(tab.totalCountState).toBe('idle')
    const [profileId, sql, opts] = sqlExecute.mock.calls[1]
    expect(profileId).toBe('p1')
    expect(sql).toBe(
      'SELECT count(*) AS qsdb_total_rows FROM (\nSELECT * FROM sales\n) AS qsdb_count',
    )
    expect(opts.skipHistory).toBe(true)
  })

  it('keeps an i64 count beyond Number.MAX_SAFE_INTEGER as a string', async () => {
    const tab = await seedTab()
    sqlExecute.mockResolvedValueOnce(countResult('9007199254740993'))
    await countTotalRows(tab.key)
    expect(tab.totalCount).toBe('9007199254740993')
  })

  it('uses the filtered base SQL and invalidates the count when filters change', async () => {
    const tab = await seedTab()
    sqlExecute.mockResolvedValueOnce(countResult(1200))
    await countTotalRows(tab.key)
    expect(tab.totalCount).toBe('1200')

    // 添加筛选会重跑第一页；旧总数立即失效。
    sqlExecute.mockResolvedValueOnce(pageResult(501))
    const filterErr = await applyTabFilters(tab.key, [
      { column: 'region', tag: 'utf8', op: 'eq', value: 'APAC' },
    ])
    expect(filterErr).toBeNull()
    expect(tab.totalCount).toBeNull()

    sqlExecute.mockResolvedValueOnce(countResult(400))
    await countTotalRows(tab.key)
    const sql = sqlExecute.mock.calls.at(-1)?.[1] ?? ''
    expect(sql).toContain("WHERE region = 'APAC'")
    expect(sql).toContain('SELECT count(*) AS qsdb_total_rows FROM (')
    expect(tab.totalCount).toBe('400')
  })

  it('drops a late count response after the query was filtered again', async () => {
    const tab = await seedTab()
    const late = deferred<QueryResult>()
    sqlExecute.mockReturnValueOnce(late.promise)
    const pending = countTotalRows(tab.key)
    expect(tab.totalCountState).toBe('loading')

    sqlExecute.mockResolvedValueOnce(pageResult(501))
    await applyTabFilters(tab.key, [
      { column: 'region', tag: 'utf8', op: 'eq', value: 'EMEA' },
    ])
    late.resolve(countResult(1200))
    await pending

    expect(tab.totalCount).toBeNull()
    expect(tab.totalCountState).toBe('idle')
  })

  it('knows the total without a count query when the first page is complete', async () => {
    connect()
    sqlExecute.mockResolvedValueOnce(pageResult(200))
    const tab = await runSql('editor-1', 'p1', 'SELECT * FROM sales', { params: [] }, {
      stream: false,
      title: 'test',
    })
    expect(tab.hasNextPage).toBe(false)
    expect(tab.totalCount).toBe('200')
    expect(sqlExecute).toHaveBeenCalledTimes(1)
  })

  it('does not offer a broken count for bare VALUES results', async () => {
    connect()
    sqlExecute.mockResolvedValueOnce(pageResult(2))
    const tab = await runSql('editor-1', 'p1', 'VALUES (1), (2)', { params: [] }, {
      stream: false,
      title: 'values',
    })
    const calls = sqlExecute.mock.calls.length
    const err = await countTotalRows(tab.key)
    expect(err).toContain('不支持')
    expect(sqlExecute).toHaveBeenCalledTimes(calls)
  })
})
