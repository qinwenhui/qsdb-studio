// 结果网格的复制/过滤/排序纯函数（单测不启动 Vue/Tauri）。

import type { Tag, WireColumn, WireValue } from '../ipc/types'

/**
 * 表头第二行的类型文本：Decimal 在类型名后补 `(precision, scale)`。
 * 服务端 typeName 有时已带括号（JSON schema），此时不重复追加。
 */
export function columnTypeLabel(c: WireColumn): string {
  if (!c.decimal) return c.typeName
  if (/\(\s*\d+\s*,\s*-?\d+\s*\)/.test(c.typeName)) return c.typeName
  return `${c.typeName}(${c.decimal[0]}, ${c.decimal[1]})`
}

/** 列宽拖动范围（px）：太窄看不清，太宽会挤掉其它列。 */
export function clampColumnWidth(width: number, min = 64, max = 900): number {
  if (!Number.isFinite(width)) return min
  return Math.max(min, Math.min(max, Math.round(width)))
}

/** 复制用的值文本：NULL = 空串（与 CSV 语义一致）。 */
export function valueText(v: WireValue): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

/** 过滤用的值文本：NULL 可被 "null" 命中。 */
export function filterValueText(v: WireValue): string {
  return v === null || v === undefined ? 'NULL' : valueText(v)
}

/** 行是否命中过滤词（所有列，大小写不敏感的子串匹配）。 */
export function rowMatches(
  row: WireValue[] | undefined,
  needle: string,
  colCount: number,
): boolean {
  if (!row) return false
  const q = needle.trim().toLowerCase()
  if (!q) return true
  for (let i = 0; i < colCount; i++) {
    if (filterValueText(row[i]).toLowerCase().includes(q)) return true
  }
  return false
}

/**
 * 值排序：NULL 永远排最后（升序/降序都不改变 NULL 位置），
 * 类型相同时数字按数值、其余按 locale 字符串（数字感知）。
 */
export function compareValues(
  a: WireValue,
  b: WireValue,
  direction: 1 | -1 = 1,
): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  let cmp = 0
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    cmp = a === b ? 0 : a ? 1 : -1
  } else if (typeof a === 'number' && typeof b === 'number') {
    cmp = a < b ? -1 : a > b ? 1 : 0
  } else {
    const sa = valueText(a)
    const sb = valueText(b)
    const na = Number(sa)
    const nb = Number(sb)
    if (sa.trim() !== '' && sb.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) {
      cmp = na < nb ? -1 : na > nb ? 1 : 0
    } else {
      cmp = sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' })
    }
  }
  return cmp * direction
}

function tsvCell(v: WireValue): string {
  const s = valueText(v)
  return /[\t\r\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 行 → TSV（无表头；粘 Excel 列不乱）。 */
export function rowToTsv(row: WireValue[]): string {
  return row.map(tsvCell).join('\t')
}

/** 行集合 → TSV（可选表头）。 */
export function toTsv(
  columns: WireColumn[],
  rows: WireValue[][],
  header = true,
): string {
  const lines = []
  if (header) lines.push(columns.map((c) => tsvCell(c.name)).join('\t'))
  for (const r of rows) lines.push(rowToTsv(r))
  return lines.join('\r\n')
}

function csvCell(v: WireValue): string {
  const s = valueText(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 行 → CSV 行（无表头）。 */
export function rowToCsvLine(row: WireValue[]): string {
  return row.map(csvCell).join(',')
}

/** 行集合 → CSV（可选表头，RFC 4180 换行）。 */
export function toCsvText(
  columns: WireColumn[],
  rows: WireValue[][],
  header = true,
): string {
  const lines = []
  if (header) lines.push(columns.map((c) => csvCell(c.name)).join(','))
  for (const r of rows) lines.push(rowToCsvLine(r))
  return lines.join('\r\n') + (lines.length ? '\r\n' : '')
}

/** 行 → JSON 对象（列名做 key；重复列名后者覆盖，和 JSON 本身一致）。 */
export function rowToObject(columns: WireColumn[], row: WireValue[]): Record<string, WireValue> {
  const o: Record<string, WireValue> = {}
  columns.forEach((c, i) => {
    o[c.name] = row[i] ?? null
  })
  return o
}

export function rowToJson(columns: WireColumn[], row: WireValue[]): string {
  return JSON.stringify(rowToObject(columns, row), null, 2)
}

export function rowsToJson(columns: WireColumn[], rows: WireValue[][]): string {
  return JSON.stringify(rows.map((r) => rowToObject(columns, r)), null, 2)
}

const NUMERIC_TAGS = new Set<Tag>([
  'i8',
  'i16',
  'i32',
  'i64',
  'f32',
  'f64',
  'decimal128',
])

/** SQL 字面量：数字/布尔不加引号，NULL 写 NULL，其余单引号转义。 */
export function sqlLiteral(v: WireValue, column: WireColumn): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return String(v)
  if (NUMERIC_TAGS.has(column.tag) && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v)) {
    return v
  }
  return `'${v.replace(/'/g, "''")}'`
}

function quoteIdent(name: string): string {
  // QSDB 解析器不接受双引号标识符，裸标识符与 Studio 其它生成 SQL 一致。
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : name
}

/** 行 → INSERT（表名用占位符；用户粘到目标表后替换）。 */
export function rowToInsert(
  columns: WireColumn[],
  row: WireValue[],
  table = 'table_name',
): string {
  const cols = columns.map((c) => quoteIdent(c.name)).join(', ')
  const vals = columns.map((c, i) => sqlLiteral(row[i] ?? null, c)).join(', ')
  return `INSERT INTO ${table} (${cols}) VALUES (${vals});`
}

export function rowsToInsert(
  columns: WireColumn[],
  rows: WireValue[][],
  table = 'table_name',
): string {
  if (rows.length === 0) return ''
  if (rows.length === 1) return rowToInsert(columns, rows[0], table)
  const cols = columns.map((c) => quoteIdent(c.name)).join(', ')
  const body = rows
    .map((r) => `  (${columns.map((c, i) => sqlLiteral(r[i] ?? null, c)).join(', ')})`)
    .join(',\n')
  return `INSERT INTO ${table} (${cols}) VALUES\n${body};`
}
