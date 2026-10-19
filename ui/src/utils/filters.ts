// 结果字段筛选（服务端 WHERE，纯函数）。
//
// 自动分页结果的原始查询没有 LIMIT，可以安全地包成
//   SELECT * FROM (<原 SQL>) AS qsdb_filtered WHERE <条件>
// 再交给分页器追加 LIMIT/OFFSET —— 筛选作用在**全量查询结果**上，而不是
// 当前页的客户端切片。显式 LIMIT 的查询不做这个包装（否则只筛到那一段）。
//
// 值一律做字面量转义；列名只接受简单标识符，操作符只来自白名单。

import type { Tag, WireColumn } from '../ipc/types'
import { trimTrailingTrivia } from './pagination'

import { t, tt } from '../i18n'

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'isNull'
  | 'notNull'

export interface ColumnFilter {
  column: string
  tag: Tag
  op: FilterOp
  value: string
}

export const FILTER_OP_LABEL: Record<FilterOp, string> = {
  eq: '等于',
  ne: '不等于',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
  contains: '包含',
  isNull: '为空',
  notNull: '不为空',
}

export const FILTER_OP_SYMBOL: Record<FilterOp, string> = {
  eq: '=',
  ne: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  contains: '包含',
  isNull: '为空',
  notNull: '不为空',
}

const SIMPLE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESTRICTED_TAGS = new Set<Tag>(['binary', 'interval'])
const NUMERIC_TAGS = new Set<Tag>(['i8', 'i16', 'i32', 'i64', 'f32', 'f64', 'decimal128'])
const NUMERIC_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/

export function isFilterableColumn(column: WireColumn): boolean {
  return SIMPLE_IDENT.test(column.name) && !RESTRICTED_TAGS.has(column.tag)
}

export function filterOperators(tag: Tag): FilterOp[] {
  if (RESTRICTED_TAGS.has(tag)) return []
  if (tag === 'utf8') {
    return ['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte', 'isNull', 'notNull']
  }
  if (NUMERIC_TAGS.has(tag) || tag === 'date32' || tag === 'time64ns' || tag === 'timestampns') {
    return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'isNull', 'notNull']
  }
  return ['eq', 'ne', 'isNull', 'notNull']
}

export function opNeedsValue(op: FilterOp): boolean {
  return op !== 'isNull' && op !== 'notNull'
}

export function filterValueHint(tag: Tag): string {
  if (tag === 'bool') return 'true / false'
  if (tag === 'date32') return 'YYYY-MM-DD'
  if (tag === 'time64ns') return 'HH:MM:SS'
  if (tag === 'timestampns') return 'YYYY-MM-DD HH:MM:SS'
  if (NUMERIC_TAGS.has(tag)) return t('数字')
  return t('值')
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function escapeLike(value: string): string {
  // 用 ! 作为 ESCAPE 字符，避免反斜杠在 SQL 字符串里的差异。
  return value.replace(/[!%_]/g, '!$&')
}

function literalFor(f: ColumnFilter): { literal?: string; error?: string } {
  const raw = f.value
  const value = raw.trim()
  if (!value) return { error: tt`「${f.column}」的筛选值不能为空` }
  if (NUMERIC_TAGS.has(f.tag)) {
    if (!NUMERIC_RE.test(value)) {
      return { error: tt`「${f.column}」是数值字段，请输入数字（不猜类型）` }
    }
    return { literal: value }
  }
  if (f.tag === 'bool') {
    const v = value.toLowerCase()
    if (v === 'true' || v === '1') return { literal: 'TRUE' }
    if (v === 'false' || v === '0') return { literal: 'FALSE' }
    return { error: t('布尔字段只接受 true / false（或 1 / 0）') }
  }
  if (f.tag === 'date32') {
    if (!DATE_RE.test(value)) return { error: t('日期格式应为 YYYY-MM-DD') }
    return { literal: `DATE ${quoteString(value)}` }
  }
  if (f.tag === 'time64ns') {
    if (!TIME_RE.test(value)) return { error: t('时间格式应为 HH:MM:SS') }
    return { literal: `TIME ${quoteString(value)}` }
  }
  if (f.tag === 'timestampns') {
    if (!TIMESTAMP_RE.test(value)) {
      return { error: t('时间戳格式应为 YYYY-MM-DD HH:MM:SS（可带毫秒/时区）') }
    }
    return { literal: `TIMESTAMP ${quoteString(value.replace('T', ' '))}` }
  }
  if (RESTRICTED_TAGS.has(f.tag)) {
    return { error: tt`暂不支持按 ${f.tag} 类型筛选` }
  }
  return { literal: quoteString(raw) }
}

export function buildFilterCondition(f: ColumnFilter): { sql?: string; error?: string } {
  if (!SIMPLE_IDENT.test(f.column)) {
    return { error: tt`列名 ${f.column} 不是简单标识符，暂不支持字段筛选` }
  }
  if (!filterOperators(f.tag).includes(f.op)) {
    return { error: tt`「${f.column}」不支持该筛选操作` }
  }
  if (!opNeedsValue(f.op)) {
    return { sql: `${f.column} ${f.op === 'isNull' ? 'IS NULL' : 'IS NOT NULL'}` }
  }
  if (f.op === 'contains') {
    const value = f.value
    if (!value.trim()) return { error: tt`「${f.column}」的筛选值不能为空` }
    return {
      sql: `${f.column} LIKE ${quoteString(`%${escapeLike(value)}%`)} ESCAPE '!'`,
    }
  }
  const lit = literalFor(f)
  if (!lit.literal) return { error: lit.error ?? t('筛选值不合法') }
  const sqlOps: Record<string, string> = {
    eq: '=',
    ne: '<>',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
  }
  const op = sqlOps[f.op] ?? '='
  return { sql: `${f.column} ${op} ${lit.literal}` }
}

/**
 * 把原查询包成可按字段过滤的子查询。
 * 只在自动分页（原 SQL 无 LIMIT/OFFSET）的结果上调用。
 */
export function buildFilteredSql(
  baseSql: string,
  filters: ColumnFilter[],
): { sql?: string; error?: string } {
  if (filters.length === 0) return { sql: baseSql }
  const body = trimTrailingTrivia(baseSql)
  if (!body) return { error: t('原查询为空，无法筛选') }
  const conditions: string[] = []
  for (const f of filters) {
    const built = buildFilterCondition(f)
    if (!built.sql) return { error: built.error }
    conditions.push(built.sql)
  }
  return {
    sql: `SELECT * FROM (\n${body}\n) AS qsdb_filtered\nWHERE ${conditions.join(
      '\n  AND ',
    )}`,
  }
}

/** 结果面板上的条件标签（不含列类型细节）。 */
export function filterLabel(f: ColumnFilter): string {
  const op = t(FILTER_OP_SYMBOL[f.op])
  return opNeedsValue(f.op) ? `${f.column} ${op} ${f.value}` : `${f.column} ${op}`
}
