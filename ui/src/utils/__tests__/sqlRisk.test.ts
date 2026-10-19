import { describe, expect, it } from 'vitest'
import { analyzeSql, dangerTypingText, leadingVerb } from '../sqlRisk'
import { currentStatement, inLiteralOrComment, maskSql } from '../sqlText'

describe('sqlText', () => {
  it('masks literals and comments without changing length', () => {
    const sql = "SELECT 'DROP TABLE t' AS x -- DELETE FROM t\n/* TRUNCATE t */"
    const masked = maskSql(sql)
    expect(masked.length).toBe(sql.length)
    expect(masked).not.toContain('DROP')
    expect(masked).not.toContain('DELETE')
    expect(masked).not.toContain('TRUNCATE')
    // 换行保留（行号/范围计算仍可用）。
    expect(masked.split('\n').length).toBe(sql.split('\n').length)
  })

  it('reports whether the caret is inside a literal or comment', () => {
    expect(inLiteralOrComment("SELECT 'abc")).toBe(true)
    expect(inLiteralOrComment('SELECT 1 -- note')).toBe(true)
    expect(inLiteralOrComment('SELECT 1 /* note')).toBe(true)
    expect(inLiteralOrComment("SELECT 'abc' ")).toBe(false)
    expect(inLiteralOrComment('SELECT 1')).toBe(false)
  })

  it('finds the current statement, ignoring semicolons in strings/comments', () => {
    expect(currentStatement("SELECT 1; SELECT ';' AS s")).toBe(" SELECT ';' AS s")
    expect(currentStatement("SELECT 1; -- ;\nSELECT 2")).toBe(" -- ;\nSELECT 2")
    expect(currentStatement('SELECT 1')).toBe('SELECT 1')
  })
})

describe('analyzeSql', () => {
  it('treats SELECT as read-only and ignores keywords inside literals', () => {
    const a = analyzeSql("SELECT * FROM sales WHERE note = 'DROP TABLE sales'")
    expect(a.readOnly).toBe(true)
    expect(a.dangerous).toBe(false)
    expect(leadingVerb('-- DELETE FROM t\nSELECT 1')).toBe('SELECT')
  })

  it('flags DELETE without WHERE as hard danger', () => {
    const a = analyzeSql('DELETE FROM default.sales')
    expect(a.readOnly).toBe(false)
    expect(a.dangerous).toBe(true)
    expect(a.hard).toBe(true)
    expect(a.table).toBe('default.sales')
    expect(a.reason).toContain('没有 WHERE')
  })

  it('flags DELETE / UPDATE with WHERE as dangerous but not hard', () => {
    const del = analyzeSql('DELETE FROM sales WHERE id = 1')
    expect(del.dangerous).toBe(true)
    expect(del.hard).toBe(false)
    const upd = analyzeSql('UPDATE sales SET amount = 0')
    expect(upd.hard).toBe(true)
    const updWhere = analyzeSql('UPDATE sales SET amount = 0 WHERE id = 1')
    expect(updWhere.dangerous).toBe(true)
    expect(updWhere.hard).toBe(false)
    expect(updWhere.table).toBe('sales')
  })

  it('flags DROP / TRUNCATE / ALTER / INSERT OVERWRITE', () => {
    expect(analyzeSql('DROP TABLE IF EXISTS sales')).toMatchObject({
      dangerous: true,
      hard: true,
      table: 'sales',
    })
    expect(analyzeSql('TRUNCATE TABLE sales')).toMatchObject({
      dangerous: true,
      hard: true,
      table: 'sales',
    })
    expect(analyzeSql('ALTER TABLE sales ADD COLUMN x BIGINT')).toMatchObject({
      dangerous: true,
      table: 'sales',
    })
    const ov = analyzeSql('INSERT OVERWRITE sales SELECT * FROM src')
    expect(ov.verb).toBe('INSERT OVERWRITE')
    expect(ov.dangerous).toBe(true)
    expect(ov.table).toBe('sales')
  })

  it('does not flag EXPLAIN or read-only CTEs', () => {
    expect(analyzeSql('EXPLAIN DROP TABLE sales')).toMatchObject({
      readOnly: true,
      dangerous: false,
    })
    expect(
      analyzeSql('WITH x AS (SELECT 1) SELECT * FROM x'),
    ).toMatchObject({ readOnly: true, dangerous: false })
  })

  it('keeps INSERT INTO and COPY out of the danger list but not read-only', () => {
    expect(analyzeSql('INSERT INTO sales VALUES (1)')).toMatchObject({
      readOnly: false,
      dangerous: false,
    })
    expect(analyzeSql("COPY (SELECT 1) TO 'exports/x'")).toMatchObject({
      readOnly: false,
      dangerous: false,
    })
  })
})

describe('dangerTypingText', () => {
  it('requires the table for one hard statement, EXECUTE for several', () => {
    const one = analyzeSql('DROP TABLE sales')
    const two = analyzeSql('TRUNCATE orders')
    expect(dangerTypingText([one])).toBe('sales')
    expect(dangerTypingText([one, two])).toBe('EXECUTE')
    expect(dangerTypingText([analyzeSql('DELETE FROM t WHERE id = 1')])).toBeNull()
    expect(dangerTypingText([analyzeSql('SELECT 1')])).toBeNull()
  })
})
