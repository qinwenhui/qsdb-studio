/** SQL 文本小工具（纯函数，单测不启动 Vue/Tauri）。 */

import type { SqlStatement } from '../ipc/types'

/** 把查询包成 `SELECT * FROM (…) LIMIT n`（护栏三选一之一）。 */
export function wrapWithLimit(sql: string, n: number): string {
  const body = sql.trim().replace(/;+\s*$/, '')
  return `SELECT * FROM (\n${body}\n) AS qsdb_studio_limit LIMIT ${n}`
}

/** 统计换行数（批量执行的起始行偏移）。 */
export function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

/** 光标偏移 → 1 基行号（与 `sql_split` 的行号口径一致）。 */
export function lineAtOffset(text: string, offset: number): number {
  const end = Math.max(0, Math.min(offset, text.length))
  return countNewlines(text.slice(0, end)) + 1
}

/**
 * 光标所在语句（`Ctrl/Cmd+Enter` 的默认执行目标）。
 *
 * 语句行号来自 `sql_split`。光标落在语句之间的空行/注释区时取**最近**
 * 一条；与前后等距时优先取后面的语句（与 DataGrip 的习惯一致）。
 */
export function statementAtCursor(
  statements: SqlStatement[],
  line: number,
): SqlStatement | null {
  let best: SqlStatement | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const st of statements) {
    const dist =
      line < st.startLine
        ? st.startLine - line
        : line > st.endLine
          ? line - st.endLine
          : 0
    const tiePreferFollowing =
      dist === bestDist && best !== null && best.endLine < line && st.startLine > line
    if (dist < bestDist || tiePreferFollowing) {
      best = st
      bestDist = dist
    }
  }
  return best
}
