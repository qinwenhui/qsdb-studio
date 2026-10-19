import { describe, expect, it } from 'vitest'
import { toCsv } from '../csv'
import { errorHint, isGuardrailError, retryable } from '../errors'
import { draftToParam, scanPlaceholders } from '../params'
import { formatBigCount, formatMs } from '../format'
import { wrapWithLimit, lineAtOffset, statementAtCursor } from '../sql'

describe('scanPlaceholders', () => {
  it('finds $n and ? outside literals', () => {
    expect(scanPlaceholders('SELECT * FROM t WHERE a = $1 AND b = $2').count).toBe(2)
    expect(scanPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?').count).toBe(2)
    expect(
      scanPlaceholders("SELECT '$1 ?' AS s -- $2\nWHERE a = $1").count,
    ).toBe(1)
  })

  it('reports mixed placeholder styles instead of guessing', () => {
    const p = scanPlaceholders('SELECT $1, ?')
    expect(p.mixed).toBe(true)
  })

  it('ignores placeholders inside quoted identifiers and comments', () => {
    expect(scanPlaceholders('SELECT "a?b" /* $9 */ FROM t').count).toBe(0)
  })
})

describe('draftToParam', () => {
  it('parses JSON values and falls back to string', () => {
    expect(draftToParam({ ty: '', value: '10' })).toEqual({ value: 10 })
    expect(draftToParam({ ty: '', value: 'true' })).toEqual({ value: true })
    expect(draftToParam({ ty: '', value: 'abc' })).toEqual({ value: 'abc' })
    expect(draftToParam({ ty: 'DATE', value: '2026-01-01' })).toEqual({
      ty: 'DATE',
      value: '2026-01-01',
    })
  })
})

describe('toCsv', () => {
  it('keeps NULL empty and escapes RFC4180 specials', () => {
    const csv = toCsv(
      [
        { name: 'name', tag: 'utf8', typeName: 'VARCHAR', nullable: true },
        { name: 'n', tag: 'i64', typeName: 'BIGINT', nullable: true },
      ],
      [
        ['中文', 1],
        ['a,"b"', null],
      ],
    )
    expect(csv).toBe('name,n\r\n中文,1\r\n"a,""b""",\r\n')
  })
})

describe('guardrail helpers', () => {
  it('wraps with LIMIT and strips the trailing semicolon', () => {
    expect(wrapWithLimit('SELECT 1;\n', 100)).toBe(
      'SELECT * FROM (\nSELECT 1\n) AS qsdb_studio_limit LIMIT 100',
    )
  })

  it('maps codes to actions and retryability', () => {
    expect(isGuardrailError({ kind: 'api', code: 'RESULT_TOO_LARGE', message: '', retriable: false })).toBe(true)
    expect(
      retryable({
        kind: 'api',
        code: 'TOO_MANY_QUERIES',
        message: '',
        retriable: false,
      }),
    ).toBe(true)
    expect(
      retryable({
        kind: 'api',
        code: 'TOO_MANY_SESSIONS',
        message: '',
        retriable: false,
      }),
    ).toBe(true)
    expect(
      errorHint({ kind: 'api', code: 'TOO_MANY_SESSIONS', message: '', retriable: false }),
    ).toContain('上限')
    expect(errorHint({ kind: 'api', code: 'READ_ONLY', message: '', retriable: false })).toContain(
      '只读',
    )
  })
})

describe('statementAtCursor', () => {
  const statements = [
    { sql: 'SELECT 1', startLine: 1, endLine: 1 },
    { sql: 'SELECT 2', startLine: 3, endLine: 5 },
    { sql: 'SELECT 3', startLine: 7, endLine: 7 },
  ]

  it('maps offsets to 1-based lines', () => {
    const text = 'a\nb\nc'
    expect(lineAtOffset(text, 0)).toBe(1)
    expect(lineAtOffset(text, 1)).toBe(1)
    expect(lineAtOffset(text, 2)).toBe(2)
    expect(lineAtOffset(text, 999)).toBe(3)
  })

  it('picks the statement containing the caret', () => {
    expect(statementAtCursor(statements, 1)?.sql).toBe('SELECT 1')
    expect(statementAtCursor(statements, 4)?.sql).toBe('SELECT 2')
    expect(statementAtCursor(statements, 7)?.sql).toBe('SELECT 3')
  })

  it('falls back to the nearest statement and prefers the following one on ties', () => {
    // 第 2 行是空行：离第 1 行和第 3 行都是 1 行 → 取后面的。
    expect(statementAtCursor(statements, 2)?.sql).toBe('SELECT 2')
    // 第 6 行：离第 5 行（前）和第 7 行（后）都是 1 行 → 取后面的。
    expect(statementAtCursor(statements, 6)?.sql).toBe('SELECT 3')
    // 光标在所有语句之前 / 之后。
    expect(statementAtCursor(statements, 0)?.sql).toBe('SELECT 1')
    expect(statementAtCursor(statements, 99)?.sql).toBe('SELECT 3')
  })

  it('returns null when there is no statement', () => {
    expect(statementAtCursor([], 1)).toBeNull()
  })
})

describe('formatMs', () => {
  it('switches units', () => {
    expect(formatMs(12.34)).toBe('12.3 ms')
    expect(formatMs(1500)).toBe('1.50 s')
    expect(formatMs(null)).toBe('—')
  })
})

describe('formatBigCount', () => {
  it('groups numbers and preserves i64 precision beyond Number.MAX_SAFE_INTEGER', () => {
    expect(formatBigCount(1234567)).toBe('1,234,567')
    expect(formatBigCount('9007199254740993')).toBe('9,007,199,254,740,993')
    expect(formatBigCount(null)).toBe('—')
  })
})
