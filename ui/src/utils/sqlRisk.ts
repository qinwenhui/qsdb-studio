// 危险 SQL 识别 + 只读连接判定（纯函数，单测直接对撞）。
//
// **不是 SQL 解析器**：只取“第一个关键字 + 掩码后的目标表”，判据宁可保守。
// 危险语句一律再确认一次；只读连接拦截所有非查询类语句。
// 最终授权边界仍在服务端（grants），这里是客户端护栏。

import { maskSql } from './sqlText'
import { t } from '../i18n'

export interface SqlAnalysis {
  /** 归一化动词：`SELECT` / `INSERT OVERWRITE` / … */
  verb: string
  /** 是否为不会修改数据的查询类语句（只读连接据此放行）。 */
  readOnly: boolean
  /** 是否需要在执行前二次确认。 */
  dangerous: boolean
  /** 是否必须输入目标表名/动词才能确认（DROP/TRUNCATE/无 WHERE 的 UPDATE/DELETE）。 */
  hard: boolean
  /** 能解析出的目标表（限定名原样）；解析不出为 null。 */
  table: string | null
  /** 人读原因（用于确认弹窗）。 */
  reason: string
}

const READ_VERBS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'WITH'])

/** WITH 里出现这些词就不再视为只读（保守；避免 `WITH … INSERT` 漏网）。 */
const WRITE_TOKENS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'TRUNCATE',
  'ALTER',
  'GRANT',
  'REVOKE',
  'COPY',
  'IMPORT',
  'EXPORT',
])

interface TablePattern {
  re: RegExp
}

const TABLE_PATTERNS: Record<string, TablePattern> = {
  DROP: { re: /\bDROP\s+(?:TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w.]*)/i },
  TRUNCATE: { re: /\bTRUNCATE\s+(?:TABLE\s+)?([A-Za-z_][\w.]*)/i },
  DELETE: { re: /\bDELETE\s+FROM\s+([A-Za-z_][\w.]*)/i },
  UPDATE: { re: /\bUPDATE\s+([A-Za-z_][\w.]*)/i },
  'INSERT OVERWRITE': { re: /\bINSERT\s+OVERWRITE\s+([A-Za-z_][\w.]*)/i },
  ALTER: { re: /\bALTER\s+TABLE\s+([A-Za-z_][\w.]*)/i },
}

/** 掩码后的词元（大写；字符串/注释内容不参与）。 */
export function sqlTokens(sql: string): string[] {
  const masked = maskSql(sql)
  return (masked.match(/[A-Za-z_][\w$]*/g) ?? []).map((w) => w.toUpperCase())
}

/** 第一个词元（跳过前导空白/注释）。 */
export function leadingVerb(sql: string): string | null {
  return sqlTokens(sql)[0] ?? null
}

function tableFor(verb: string, masked: string): string | null {
  const p = TABLE_PATTERNS[verb]
  return p ? (masked.match(p.re)?.[1] ?? null) : null
}

/** 分析一条语句：只读性、危险级别、目标表与原因。 */
export function analyzeSql(sql: string): SqlAnalysis {
  const masked = maskSql(sql)
  const tokens = sqlTokens(sql)
  const first = tokens[0] ?? ''
  const verb =
    first === 'INSERT' && tokens[1] === 'OVERWRITE' ? 'INSERT OVERWRITE' : first

  let readOnly = READ_VERBS.has(verb)
  if (verb === 'WITH' && tokens.some((t) => WRITE_TOKENS.has(t))) {
    readOnly = false
  }
  // EXPLAIN 只做计划，不执行内部语句。
  if (first === 'EXPLAIN') readOnly = true

  const hasWhere = tokens.includes('WHERE')
  const table = tableFor(verb, masked)

  let dangerous = false
  let hard = false
  let reason = ''

  switch (verb) {
    case 'DROP':
      dangerous = true
      hard = true
      reason = t('DROP 会删除表/对象及其数据')
      break
    case 'TRUNCATE':
      dangerous = true
      hard = true
      reason = t('TRUNCATE 会清空表数据')
      break
    case 'DELETE':
      dangerous = true
      hard = !hasWhere
      reason = hasWhere ? t('DELETE 会删除数据') : t('DELETE 没有 WHERE，可能删除整表数据')
      break
    case 'UPDATE':
      dangerous = true
      hard = !hasWhere
      reason = hasWhere ? t('UPDATE 会修改数据') : t('UPDATE 没有 WHERE，可能更新整表')
      break
    case 'INSERT OVERWRITE':
      dangerous = true
      reason = t('INSERT OVERWRITE 会覆盖目标表/分区的数据')
      break
    case 'ALTER':
      dangerous = true
      reason = t('ALTER 会修改表结构')
      break
  }

  if (dangerous && !table && verb in TABLE_PATTERNS) {
    reason += t('（未能解析出目标表）')
  }

  return { verb: verb || 'UNKNOWN', readOnly, dangerous, hard, table, reason }
}

/**
 * 批量执行时要求用户键入的确认文本：
 * - 没有 hard 风险 → null（普通确认即可）；
 * - 只有一个 hard 风险且有表名 → 表名；
 * - 其余 → `EXECUTE`。
 */
export function dangerTypingText(items: SqlAnalysis[]): string | null {
  const hard = items.filter((a) => a.dangerous && a.hard)
  if (hard.length === 0) return null
  if (hard.length === 1) return hard[0].table ?? hard[0].verb
  return 'EXECUTE'
}
