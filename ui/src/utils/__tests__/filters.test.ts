import { describe, expect, it } from 'vitest'
import {
  buildFilterCondition,
  buildFilteredSql,
  filterLabel,
  filterOperators,
  isFilterableColumn,
  type ColumnFilter,
} from '../filters'

const num: ColumnFilter = { column: 'id', tag: 'i64', op: 'gt', value: '100' }

describe('filter capabilities', () => {
  it('rejects non-identifier columns and unsupported tags', () => {
    expect(
      isFilterableColumn({ name: 'count(*)', tag: 'i64', typeName: 'BIGINT', nullable: false }),
    ).toBe(false)
    expect(
      isFilterableColumn({ name: 'blob', tag: 'binary', typeName: 'BINARY', nullable: true }),
    ).toBe(false)
    expect(
      isFilterableColumn({ name: 'amount', tag: 'decimal128', typeName: 'DECIMAL', nullable: true }),
    ).toBe(true)
  })

  it('offers contains only for text and null checks everywhere', () => {
    expect(filterOperators('utf8')).toContain('contains')
    expect(filterOperators('i64')).not.toContain('contains')
    expect(filterOperators('binary')).toEqual([])
    expect(filterOperators('timestampns')).toContain('gte')
  })
})

describe('buildFilterCondition', () => {
  it('formats numeric, null, boolean and typed date/time literals', () => {
    expect(buildFilterCondition(num)).toEqual({ sql: 'id > 100' })
    expect(
      buildFilterCondition({ column: 'name', tag: 'utf8', op: 'isNull', value: '' }),
    ).toEqual({ sql: 'name IS NULL' })
    expect(
      buildFilterCondition({ column: 'ok', tag: 'bool', op: 'eq', value: 'TRUE' }),
    ).toEqual({ sql: 'ok = TRUE' })
    expect(
      buildFilterCondition({ column: 'dt', tag: 'date32', op: 'gte', value: '2026-01-01' }),
    ).toEqual({ sql: "dt >= DATE '2026-01-01'" })
    expect(
      buildFilterCondition({
        column: 'ts',
        tag: 'timestampns',
        op: 'lt',
        value: '2026-01-01T12:30:00',
      }),
    ).toEqual({ sql: "ts < TIMESTAMP '2026-01-01 12:30:00'" })
  })

  it('escapes strings and LIKE wildcards', () => {
    expect(
      buildFilterCondition({ column: 'name', tag: 'utf8', op: 'eq', value: "O'Brien" }),
    ).toEqual({ sql: "name = 'O''Brien'" })
    expect(
      buildFilterCondition({ column: 'name', tag: 'utf8', op: 'contains', value: '50%_!' }),
    ).toEqual({ sql: "name LIKE '%50!%!_!!%' ESCAPE '!'" })
  })

  it('rejects values that would silently change type', () => {
    expect(buildFilterCondition({ column: 'id', tag: 'i64', op: 'eq', value: 'abc' }).error).toContain(
      '数值字段',
    )
    expect(
      buildFilterCondition({ column: 'dt', tag: 'date32', op: 'eq', value: '2026/01/01' }).error,
    ).toContain('YYYY-MM-DD')
    expect(
      buildFilterCondition({ column: 'ok', tag: 'bool', op: 'eq', value: 'yes' }).error,
    ).toContain('true / false')
  })
})

describe('buildFilteredSql', () => {
  it('wraps the original query and joins conditions with AND', () => {
    const built = buildFilteredSql('SELECT * FROM t ORDER BY id;', [
      num,
      { column: 'name', tag: 'utf8', op: 'contains', value: 'a' },
    ])
    expect(built.error).toBeUndefined()
    expect(built.sql).toBe(
      "SELECT * FROM (\nSELECT * FROM t ORDER BY id\n) AS qsdb_filtered\nWHERE id > 100\n  AND name LIKE '%a%' ESCAPE '!'",
    )
  })

  it('returns the original SQL when no filters are active', () => {
    expect(buildFilteredSql('SELECT 1', [])).toEqual({ sql: 'SELECT 1' })
  })

  it('reports the first invalid condition without modifying anything', () => {
    const built = buildFilteredSql('SELECT * FROM t', [
      num,
      { column: 'id', tag: 'i64', op: 'eq', value: 'oops' },
    ])
    expect(built.sql).toBeUndefined()
    expect(built.error).toContain('数值字段')
  })
})

describe('filterLabel', () => {
  it('renders compact labels', () => {
    expect(filterLabel(num)).toBe('id > 100')
    expect(
      filterLabel({ column: 'name', tag: 'utf8', op: 'isNull', value: '' }),
    ).toBe('name 为空')
  })
})
