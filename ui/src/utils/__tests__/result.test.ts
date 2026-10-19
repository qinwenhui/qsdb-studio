import { describe, expect, it } from 'vitest'
import type { WireColumn } from '../../ipc/types'
import {
  clampColumnWidth,
  columnTypeLabel,
  compareValues,
  rowMatches,
  rowToInsert,
  rowToJson,
  rowsToInsert,
  toCsvText,
  toTsv,
} from '../result'

const cols: WireColumn[] = [
  { name: 'id', tag: 'i64', typeName: 'BIGINT', nullable: false },
  { name: 'name', tag: 'utf8', typeName: 'VARCHAR', nullable: true },
  { name: 'amt', tag: 'decimal128', typeName: 'DECIMAL(10,2)', nullable: true },
]

describe('result copy helpers', () => {
  it('copies TSV and escapes tabs/newlines', () => {
    expect(toTsv(cols, [[1, 'a\tb', null]], false)).toBe('1\t"a\tb"\t')
    expect(toTsv(cols, [[1, null, '0.50']])).toBe('id\tname\tamt\r\n1\t\t0.50')
  })

  it('copies CSV with RFC 4180 escaping', () => {
    expect(toCsvText(cols, [[1, 'a,"b"', null]], false)).toBe('1,"a,""b""",\r\n')
  })

  it('copies JSON by column name', () => {
    const json = JSON.parse(rowToJson(cols, [7, 'x', '1.20']))
    expect(json).toEqual({ id: 7, name: 'x', amt: '1.20' })
  })

  it('generates SQL literals without changing decimal strings', () => {
    expect(rowToInsert(cols, [1, "it's", '30.80'])).toBe(
      "INSERT INTO table_name (id, name, amt) VALUES (1, 'it''s', 30.80);",
    )
    expect(rowsToInsert(cols, [[1, null, null]], 't')).toContain('VALUES (1, NULL, NULL)')
    expect(rowsToInsert(cols, [[1, 'a', null], [2, 'b', '1.00']])).toContain('),\n  (2,')
  })
})

describe('filter and sort', () => {
  it('matches every column and NULL by name', () => {
    expect(rowMatches([1, 'Alpha', null], 'alpha', 3)).toBe(true)
    expect(rowMatches([1, 'Alpha', null], 'null', 3)).toBe(true)
    expect(rowMatches([1, 'Alpha', null], 'zzz', 3)).toBe(false)
    expect(rowMatches(undefined, '', 3)).toBe(false)
  })

  it('sorts numbers numerically, strings naturally, NULLs last in both directions', () => {
    expect(compareValues(2, 10)).toBeLessThan(0)
    expect(compareValues('10', '2')).toBeGreaterThan(0)
    expect(compareValues('item10', 'item2')).toBeGreaterThan(0)
    expect(compareValues(null, 1)).toBe(1)
    expect(compareValues(null, 1, -1)).toBe(1)
    expect(compareValues(2, 1, -1)).toBeLessThan(0)
  })
})

describe('columnTypeLabel', () => {
  it('appends decimal precision/scale from wire metadata', () => {
    expect(
      columnTypeLabel({
        name: 'amt',
        tag: 'decimal128',
        typeName: 'Decimal128',
        nullable: true,
        decimal: [38, 2],
      }),
    ).toBe('Decimal128(38, 2)')
  })

  it('does not duplicate parentheses already present in typeName', () => {
    expect(
      columnTypeLabel({
        name: 'amt',
        tag: 'decimal128',
        typeName: 'DECIMAL(10,2)',
        nullable: true,
        decimal: [10, 2],
      }),
    ).toBe('DECIMAL(10,2)')
  })

  it('uses the plain type name for non-decimal columns', () => {
    expect(columnTypeLabel(cols[0])).toBe('BIGINT')
  })
})

describe('clampColumnWidth', () => {
  it('keeps dragged widths within readable bounds and rounds pixels', () => {
    expect(clampColumnWidth(10)).toBe(64)
    expect(clampColumnWidth(1200)).toBe(900)
    expect(clampColumnWidth(123.4)).toBe(123)
    expect(clampColumnWidth(Number.NaN)).toBe(64)
  })
})
