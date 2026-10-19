import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAGE_SIZE,
  canCountTotal,
  pageOffset,
  pageSql,
  planPagination,
  topLevelWords,
  totalCountSql,
} from '../pagination'

describe('planPagination', () => {
  it('paginates plain SELECT / VALUES / WITH-SELECT', () => {
    expect(planPagination('SELECT * FROM t')).toEqual({ pageSize: DEFAULT_PAGE_SIZE })
    expect(planPagination('  values (1), (2)')).toEqual({ pageSize: DEFAULT_PAGE_SIZE })
    expect(
      planPagination('WITH x AS (SELECT * FROM t) SELECT * FROM x'),
    ).toEqual({ pageSize: DEFAULT_PAGE_SIZE })
  })

  it('leaves explicit LIMIT / OFFSET / FETCH alone', () => {
    expect(planPagination('SELECT * FROM t LIMIT 10')).toBeNull()
    expect(planPagination('SELECT * FROM t OFFSET 10')).toBeNull()
    expect(planPagination('SELECT * FROM t FETCH FIRST 5 ROWS ONLY')).toBeNull()
    expect(
      planPagination('WITH x AS (SELECT * FROM t) SELECT * FROM x LIMIT 5'),
    ).toBeNull()
  })

  it('ignores LIMIT inside strings, comments, and subqueries', () => {
    expect(planPagination("SELECT 'LIMIT 10' AS s FROM t")).toEqual({
      pageSize: DEFAULT_PAGE_SIZE,
    })
    expect(planPagination('SELECT * FROM t -- LIMIT 10\n')).toEqual({
      pageSize: DEFAULT_PAGE_SIZE,
    })
    expect(
      planPagination('SELECT * FROM (SELECT * FROM t LIMIT 10) x'),
    ).toEqual({ pageSize: DEFAULT_PAGE_SIZE })
  })

  it('does not paginate non-row statements or WITH writes', () => {
    expect(planPagination('CREATE TABLE t (id BIGINT)')).toBeNull()
    expect(planPagination('SHOW USERS')).toBeNull()
    expect(planPagination('EXPLAIN SELECT * FROM t')).toBeNull()
    expect(
      planPagination('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x'),
    ).toBeNull()
  })

  it('keeps an explicit custom page size', () => {
    expect(planPagination('SELECT 1', 200)).toEqual({ pageSize: 200 })
  })
})

describe('pageSql', () => {
  it('adds LIMIT and OFFSET with a 1-based page', () => {
    expect(pageSql('SELECT * FROM t', 1, 500)).toBe('SELECT * FROM t\nLIMIT 500')
    expect(pageSql('SELECT * FROM t;', 3, 500)).toBe(
      'SELECT * FROM t\nLIMIT 500 OFFSET 1000',
    )
    // 前瞻多取一行时，OFFSET 仍按 pageSize 计算。
    expect(pageSql('SELECT * FROM t', 2, 500, 501)).toBe(
      'SELECT * FROM t\nLIMIT 501 OFFSET 500',
    )
    expect(pageOffset(3, 500)).toBe(1000)
    expect(pageOffset(0, 500)).toBe(0)
  })

  it('strips trailing comments/semicolons without eating strings', () => {
    expect(pageSql("SELECT ';' AS s -- trailing\n", 2, 10)).toBe(
      "SELECT ';' AS s\nLIMIT 10 OFFSET 10",
    )
    expect(pageSql('SELECT 1 /* tail */ ;', 1, 10)).toBe('SELECT 1\nLIMIT 10')
    expect(pageSql("SELECT '*/' AS s /* tail */", 1, 10)).toBe(
      "SELECT '*/' AS s\nLIMIT 10",
    )
  })
})

describe('totalCountSql', () => {
  it('wraps the base query without the per-page LIMIT/OFFSET', () => {
    expect(totalCountSql('SELECT * FROM sales')).toBe(
      'SELECT count(*) AS qsdb_total_rows FROM (\nSELECT * FROM sales\n) AS qsdb_count',
    )
  })

  it('keeps filtered wrappers and strips trailing comments/semicolons', () => {
    const filtered =
      'SELECT * FROM (\nSELECT * FROM sales\n) AS qsdb_filtered\nWHERE region = \'APAC\''
    expect(totalCountSql(`${filtered};\n-- tail`)).toBe(
      `SELECT count(*) AS qsdb_total_rows FROM (\n${filtered}\n) AS qsdb_count`,
    )
  })
})

describe('canCountTotal', () => {
  it('offers counts for SELECT and WITH, but not bare VALUES', () => {
    expect(canCountTotal('SELECT * FROM sales')).toBe(true)
    expect(canCountTotal('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true)
    expect(canCountTotal('VALUES (1), (2)')).toBe(false)
  })
})

describe('topLevelWords', () => {
  it('tracks parentheses and masks literals', () => {
    expect(
      topLevelWords("SELECT f('x') FROM (SELECT 1 LIMIT 1) t WHERE s = 'LIMIT'"),
    ).toEqual(['SELECT', 'F', 'FROM', 'T', 'WHERE', 'S'])
  })
})
