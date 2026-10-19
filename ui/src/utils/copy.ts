// COPY 向导的路径辅助（内核十九批Ⅵ语义）。
//
// - COPY 相对目标 → **所执行库的根**（TO 'exp' ⇒ <库根>/exp）；
// - `/files` 下载：default 库用库根内相对路径本身；其他挂载加 `<库名>/`
//   前缀（settle/exp/...）。这是内核契约锁定的存储布局形态。
//
// 这里只在**前端**推断“执行库”用于建议下载路径，不改变 COPY 的实际路由：
// 路由由服务端按查询里的库限定名 / 会话默认库决定。

export type CopyDbReason = 'qualified' | 'session' | 'multiple'

export interface CopyDbInference {
  /** 可信的执行库；`multiple` 时为 null（无法确定）。 */
  db: string | null
  reason: CopyDbReason
}

function isIdentStart(c: string | undefined): boolean {
  return Boolean(c && /[A-Za-z_]/.test(c))
}

function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c)
}

/** 扫描字符串/注释之外的 `ident.` 限定符（用于识别 `db.table`）。 */
function qualifierCandidates(sql: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i += 1
      while (i < sql.length) {
        if (sql[i] === quote) {
          // SQL 的双写转义（'' / "" / ``）
          if (sql[i + 1] === quote) {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2)
      if (nl < 0) break
      i = nl + 1
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) break
      i = end + 2
      continue
    }
    if (isIdentStart(c)) {
      let j = i + 1
      while (j < sql.length && isIdentPart(sql[j])) j += 1
      const ident = sql.slice(i, j)
      let k = j
      while (k < sql.length && /\s/.test(sql[k])) k += 1
      if (sql[k] === '.') {
        let m = k + 1
        while (m < sql.length && /\s/.test(sql[m])) m += 1
        if (isIdentStart(sql[m])) out.push(ident)
      }
      i = j
      continue
    }
    i += 1
  }
  return out
}

/**
 * 推断 COPY 会落在哪个库根：
 * - 查询里只有一个挂载库限定名 → 该库（qualified）；
 * - 没有任何库限定名 → 会话默认库（session）；
 * - 出现多个不同挂载库 → 无法确定（multiple，多库查询内核本身也会拒绝）。
 */
export function inferCopyDatabase(
  query: string,
  mountedDatabases: string[],
  sessionDefault: string,
): CopyDbInference {
  const known = new Map(mountedDatabases.map((n) => [n.toLowerCase(), n]))
  const found = new Set<string>()
  for (const ident of qualifierCandidates(query)) {
    const hit = known.get(ident.toLowerCase())
    if (hit) found.add(hit)
  }
  if (found.size === 1) {
    return { db: [...found][0], reason: 'qualified' }
  }
  if (found.size > 1) {
    return { db: null, reason: 'multiple' }
  }
  return { db: sessionDefault || 'default', reason: 'session' }
}

/** 服务端绝对路径：不走 `/files`（下载根只暴露库根内文件）。 */
export function isAbsoluteServerPath(path: string): boolean {
  const s = path.trim()
  return s.startsWith('/') || s.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(s)
}

/**
 * COPY 完成后建议的 `/files` 下载路径：
 * - CSV：目标文件本身；
 * - Parquet 且无分区：`<target>/part-00000.parquet`；
 * - 分区导出：不猜具体 part（返回空串，让用户填具体文件）；
 * - 非 default 执行库：加 `<库名>/` 前缀；
 * - 绝对目标：返回空串（不能经 `/files` 下载）。
 */
export function copyDownloadPath(
  target: string,
  format: 'csv' | 'parquet',
  partitioned: boolean,
  database: string | null,
): string {
  const t = target.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!t || isAbsoluteServerPath(target)) return ''
  let path = format === 'csv' ? t : partitioned ? '' : `${t}/part-00000.parquet`
  if (path && database && database !== 'default') {
    path = `${database}/${path}`
  }
  return path
}
