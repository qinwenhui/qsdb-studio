// grants 矩阵：`SHOW USERS` 的第三列摘要 → 可编辑矩阵 → 整表替换 map。
//
// 服务端摘要形态：`settle=reader,*=-`（`-` = 显式无权）；旧格式用户为空串
// （只有全局角色）。PUT = **整表替换**，所以保存时必须把未展示的旧键也带上，
// 否则会静默丢掉未挂载库的授权。

import type { GrantsMap } from '../ipc/types'

import { t, tt } from '../i18n'

export type GrantCell = 'none' | 'reader' | 'writer' | 'admin'

export const GRANT_OPTIONS: { label: string; value: GrantCell }[] = [
  { label: '无权', value: 'none' },
  { label: 'reader', value: 'reader' },
  { label: 'writer', value: 'writer' },
  { label: 'admin', value: 'admin' },
]

const ROLES: GrantCell[] = ['reader', 'writer', 'admin']

export interface GrantRow {
  user: string
  globalRole: string
  /** 摘要里的原始键（不含矩阵展示的库与 `*`）。 */
  extra: Record<string, string | null>
  /** 列名（数据库名或 `*`）→ 单元格。 */
  cells: Record<string, GrantCell>
  /** 加载时的快照（判 dirty）。 */
  initial: Record<string, GrantCell>
}

export interface ParsedGrants {
  /** 空串 → null（旧格式：只有全局角色）。 */
  map: Record<string, string | null> | null
  error?: string
}

/** 解析 `SHOW USERS` 的 grants 摘要。 */
export function parseGrantsSummary(raw: string): ParsedGrants {
  const s = raw.trim()
  if (!s) return { map: null }
  const map: Record<string, string | null> = {}
  for (const part of s.split(',')) {
    const eq = part.indexOf('=')
    if (eq <= 0) {
      return { map: null, error: tt`grants 摘要格式不合法: ${JSON.stringify(part)}` }
    }
    const k = part.slice(0, eq)
    const v = part.slice(eq + 1)
    map[k] = v === '-' ? null : v
  }
  return { map }
}

function roleOrNone(role: string | null | undefined): GrantCell {
  if (!role) return 'none'
  const r = role.toLowerCase()
  return ROLES.includes(r as GrantCell) ? (r as GrantCell) : 'none'
}

/**
 * 构造一行矩阵。`databases` 是挂载库名。
 *
 * - 有 grants 摘要（白名单制）：每库有效值 = 库键 ?? `*` 键 ?? 无权；
 * - 无摘要（旧格式）：全局角色铺满整行；
 * - 摘要里未挂载的库保留在 `extra`，保存时原样带回。
 */
export function buildGrantRow(
  user: string,
  globalRole: string,
  rawSummary: string,
  databases: string[],
): { row?: GrantRow; error?: string } {
  const parsed = parseGrantsSummary(rawSummary)
  if (parsed.error) return { error: parsed.error }
  const summary = parsed.map
  const cells: Record<string, GrantCell> = {}
  const extra: Record<string, string | null> = {}

  if (summary) {
    const wildcard = summary['*'] ?? null
    for (const [k, v] of Object.entries(summary)) {
      if (k === '*' || databases.includes(k)) continue
      extra[k] = v
    }
    for (const db of databases) {
      cells[db] = roleOrNone(db in summary ? summary[db] : wildcard)
    }
    cells['*'] = roleOrNone(wildcard)
  } else {
    const r = roleOrNone(globalRole)
    for (const db of databases) cells[db] = r
    cells['*'] = r
  }

  const row: GrantRow = {
    user,
    globalRole,
    extra,
    cells,
    initial: { ...cells },
  }
  return { row }
}

/** 矩阵行 → 服务端 PUT 的整表 map（保留 `extra`）。 */
export function rowToGrants(row: GrantRow): GrantsMap {
  const map: GrantsMap = { ...row.extra }
  for (const [col, cell] of Object.entries(row.cells)) {
    map[col] = cell === 'none' ? null : cell
  }
  // 服务端拒绝空表；全拒的正确形态是 {"*": null}。
  if (Object.keys(map).length === 0) map['*'] = null
  return map
}

export function isRowDirty(row: GrantRow): boolean {
  return Object.keys(row.cells).some((k) => row.cells[k] !== row.initial[k])
}

export interface GrantChange {
  /** 库名或 `*`。 */
  col: string
  from: GrantCell
  to: GrantCell
}

/** 单个用户的变更（保存前 diff 预览用；未挂载库的 extra 不在矩阵里，始终保留）。 */
export function rowDiff(row: GrantRow): GrantChange[] {
  const out: GrantChange[] = []
  for (const [col, to] of Object.entries(row.cells)) {
    const from = row.initial[col]
    if (from !== to) out.push({ col, from, to })
  }
  return out.sort((a, b) => a.col.localeCompare(b.col))
}

/** 单元格的人读标签。 */
export function grantLabel(cell: GrantCell): string {
  return cell === 'none' ? t('无权') : cell
}
