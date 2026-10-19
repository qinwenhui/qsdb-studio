import { describe, expect, it } from 'vitest'
import {
  copyDownloadPath,
  inferCopyDatabase,
  isAbsoluteServerPath,
} from '../copy'

const MOUNTS = ['default', 'settle', 'ops']

describe('inferCopyDatabase', () => {
  it('uses a single qualified mount name', () => {
    expect(
      inferCopyDatabase('COPY (SELECT * FROM settle.t) TO ...', MOUNTS, 'default'),
    ).toEqual({ db: 'settle', reason: 'qualified' })
    // 大小写不敏感；多表同库仍是一个库
    expect(
      inferCopyDatabase(
        'SELECT a.* FROM SETTLE.t a JOIN settle.u b ON a.id = b.id',
        MOUNTS,
        'default',
      ),
    ).toEqual({ db: 'settle', reason: 'qualified' })
  })

  it('falls back to the session default for unqualified tables', () => {
    expect(inferCopyDatabase('SELECT * FROM t WHERE x IN (SELECT y FROM u)', MOUNTS, 'ops')).toEqual(
      { db: 'ops', reason: 'session' },
    )
  })

  it('ignores qualifiers inside strings and comments, and non-mount schemas', () => {
    const sql = `
      -- settle.hidden
      /* ops.also_hidden */
      SELECT 'settle.in_string' AS s, other.column
      FROM t
    `
    expect(inferCopyDatabase(sql, MOUNTS, 'default')).toEqual({
      db: 'default',
      reason: 'session',
    })
  })

  it('reports ambiguity when multiple mounts are referenced', () => {
    expect(
      inferCopyDatabase(
        'SELECT * FROM settle.t JOIN ops.u ON t.id = u.id',
        MOUNTS,
        'default',
      ),
    ).toEqual({ db: null, reason: 'multiple' })
  })
})

describe('copyDownloadPath', () => {
  it('keeps default-DB targets bare', () => {
    expect(copyDownloadPath('exports/x', 'parquet', false, 'default')).toBe(
      'exports/x/part-00000.parquet',
    )
    expect(copyDownloadPath('exports/x.csv', 'csv', false, 'default')).toBe('exports/x.csv')
  })

  it('prefixes the mount name for non-default databases', () => {
    expect(copyDownloadPath('exports/x', 'parquet', false, 'settle')).toBe(
      'settle/exports/x/part-00000.parquet',
    )
    expect(copyDownloadPath('exports/x.csv', 'csv', false, 'ops')).toBe('ops/exports/x.csv')
  })

  it('does not guess a part file for partitioned exports', () => {
    expect(copyDownloadPath('exports/x', 'parquet', true, 'settle')).toBe('')
  })

  it('returns empty for absolute targets (not downloadable via /files)', () => {
    expect(isAbsoluteServerPath('/tmp/exp')).toBe(true)
    expect(isAbsoluteServerPath('C:\\tmp\\exp')).toBe(true)
    expect(isAbsoluteServerPath('exports/x')).toBe(false)
    expect(copyDownloadPath('/tmp/exp', 'csv', false, 'settle')).toBe('')
  })
})
