// 结果自动分页（纯函数，单测不启动 Vue/Tauri）。
//
// 只给“用户没写 LIMIT/OFFSET 的 SELECT / VALUES / WITH-SELECT”补上分页：
// 默认每页 500 行，页码从 1 开始。用户显式写了 LIMIT/OFFSET/FETCH、或语句
// 不是行集查询（DDL/DML/SHOW/EXPLAIN…）时不碰，避免改变语义。

import { maskSql } from './sqlText'

export const DEFAULT_PAGE_SIZE = 500

export interface PaginationPlan {
  pageSize: number
}

/** 顶层出现这些词就不再自动分页（用户已控制行数）。 */
const LIMIT_WORDS = new Set(['LIMIT', 'OFFSET', 'FETCH'])

/** WITH 里出现这些顶层词说明不是纯查询（保守，不自动改 SQL）。 */
const WRITE_WORDS = new Set([
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

/**
 * 掩码字符串/注释后，取括号深度为 0 的词元（大写）。
 * 子查询里的 LIMIT 不阻塞外层自动分页。
 */
export function topLevelWords(sql: string): string[] {
  const masked = maskSql(sql)
  const words: string[] = []
  let depth = 0
  let i = 0
  while (i < masked.length) {
    const ch = masked[i]
    if (ch === '(') {
      depth += 1
      i += 1
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      i += 1
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1
      while (j < masked.length && /[\w$]/.test(masked[j])) j += 1
      if (depth === 0) words.push(masked.slice(i, j).toUpperCase())
      i = j
      continue
    }
    i += 1
  }
  return words
}

/**
 * 去掉末尾分号与注释（长度/换行无关，只用于拼接 LIMIT）。
 * 字符串原样保留；截止位置是最后一个“代码字符”。
 */
export function trimTrailingTrivia(sql: string): string {
  let i = 0
  let lastCode = -1
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl < 0 ? sql.length : nl
      continue
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? sql.length : end + 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      lastCode = i
      i += 1
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2
            lastCode = i - 1
            continue
          }
          lastCode = i
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    // 分号是语句终止符，不算“需要保留的末尾代码”：
    // 这样 `SELECT 1 /* tail */ ;` 会截到 `SELECT 1`（注释也被丢掉）。
    if (!/\s/.test(ch) && ch !== ';') lastCode = i
    i += 1
  }
  let body = lastCode >= 0 ? sql.slice(0, lastCode + 1) : ''
  while (/[;\s]$/.test(body)) body = body.replace(/[;\s]+$/, '')
  return body
}

/** 判断一条 SQL 是否应自动分页；不满足时返回 null（原样执行）。 */
export function planPagination(
  sql: string,
  pageSize = DEFAULT_PAGE_SIZE,
): PaginationPlan | null {
  const words = topLevelWords(sql)
  const first = words[0]
  if (!first) return null
  if (words.some((w) => LIMIT_WORDS.has(w))) return null
  if (first === 'SELECT' || first === 'VALUES') {
    return { pageSize: Math.max(1, Math.floor(pageSize)) }
  }
  if (first === 'WITH') {
    if (words.some((w) => WRITE_WORDS.has(w))) return null
    return { pageSize: Math.max(1, Math.floor(pageSize)) }
  }
  return null
}

export function pageOffset(page: number, pageSize: number): number {
  return Math.max(0, Math.floor(page) - 1) * Math.max(1, Math.floor(pageSize))
}

/**
 * 统计自动分页结果的总行数：把**当前基准 SQL**（已含服务端字段筛选）包成
 * 子查询再 count。只在 pagination.baseSql 上调用——它不带每页的 LIMIT/OFFSET。
 */
export function totalCountSql(baseSql: string): string {
  const body = trimTrailingTrivia(baseSql)
  return `SELECT count(*) AS qsdb_total_rows FROM (\n${body}\n) AS qsdb_count`
}

/**
 * QSDB 当前不支持把裸 VALUES 放进子查询（`FROM (VALUES ...)` 报
 * UNSUPPORTED）。自动分页仍支持 VALUES，但总行数统计只对 SELECT/WITH
 * 提供——不提供会失败的按钮。
 */
export function canCountTotal(baseSql: string): boolean {
  const first = topLevelWords(baseSql)[0]
  return first === 'SELECT' || first === 'WITH'
}

/**
 * 给原始 SQL 追加当前页的 LIMIT/OFFSET。
 * 仅在 `planPagination` 非 null 时调用；用户原始 SQL 始终保留在结果页/历史里。
 */
export function pageSql(
  baseSql: string,
  page: number,
  pageSize = DEFAULT_PAGE_SIZE,
  /** 实际取多少行；默认 = pageSize。多取 1 行用于判断“是否还有下一页”。 */
  fetchLimit = pageSize,
): string {
  const body = trimTrailingTrivia(baseSql)
  const size = Math.max(1, Math.floor(pageSize))
  const limit = Math.max(1, Math.floor(fetchLimit))
  const offset = pageOffset(page, size)
  // 换行让 SQL 末尾的 `-- 注释` 不会吞掉 LIMIT。
  return offset === 0
    ? `${body}\nLIMIT ${limit}`
    : `${body}\nLIMIT ${limit} OFFSET ${offset}`
}
