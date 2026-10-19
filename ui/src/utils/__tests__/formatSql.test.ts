import { describe, expect, it } from 'vitest'
import { formatSql } from '../formatSql'

describe('formatSql', () => {
  it('uppercases keywords and puts clauses on separate lines', () => {
    const out = formatSql('select a,b from t where x=1 order by a')
    expect(out).toContain('SELECT')
    expect(out).toContain('FROM')
    expect(out).toContain('WHERE')
    expect(out).toContain('ORDER BY')
    expect(out.split('\n').length).toBeGreaterThan(3)
    // 不改变表达式内容与标识符。
    expect(out).toContain('x = 1')
  })

  it('keeps QSDB-specific statements intact', () => {
    const copy = formatSql(
      "COPY (SELECT * FROM settle.t) TO 'exp' (FORMAT PARQUET, PARTITION_BY (dt));",
    )
    expect(copy).toContain('COPY')
    expect(copy).toContain('PARTITION_BY (dt)')
    expect(copy).toContain("TO 'exp'")

    const overwrite = formatSql(
      "INSERT OVERWRITE t SELECT a, 'x' AS b FROM src WHERE dt = DATE '2026-01-01';",
    )
    expect(overwrite).toContain('INSERT OVERWRITE t')
    expect(overwrite).toContain("DATE '2026-01-01'")
  })

  it('keeps comments and string literals', () => {
    const out = formatSql("-- note\nselect 'a;b' as v from t;")
    expect(out).toContain('-- note')
    expect(out).toContain("'a;b'")
  })

  it('returns empty input unchanged', () => {
    expect(formatSql('')).toBe('')
    expect(formatSql('  \n ')).toBe('  \n ')
  })
})
