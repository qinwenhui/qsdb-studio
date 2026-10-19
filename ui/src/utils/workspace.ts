// 编辑器工作区的持久化形状与纯函数（localStorage ↔ 内存）。
//
// 恢复时宁可丢标签也不能把坏数据塞进 UI：字段类型不对的标签被丢弃；
// 全部无效 → 返回 null，由 store 建一个全新标签。

/** 编辑器的可恢复视图状态（切换标签/重启后回到原处）。 */
export interface StoredTabView {
  /** 光标在全文中的 0 基偏移；解析时按该标签 SQL 长度收敛。 */
  cursor: number
  /** Monaco 垂直滚动位置（像素）；0 = 顶部。 */
  scrollTop: number
}

export const DEFAULT_TAB_VIEW: StoredTabView = { cursor: 0, scrollTop: 0 }

function finiteInt(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return min
  return Math.max(min, Math.min(max, Math.round(v)))
}

/** 解析/收敛视图状态：坏值退化为顶部，绝不把 NaN/负数塞进 Monaco。 */
export function sanitizeView(v: unknown, maxCursor = 0): StoredTabView {
  if (!v || typeof v !== 'object') return { ...DEFAULT_TAB_VIEW }
  const o = v as Record<string, unknown>
  return {
    cursor: finiteInt(o.cursor, 0, Math.max(0, maxCursor)),
    // 50M px 远大于任何可见文档；只防 NaN/负值/荒谬数值。
    scrollTop: finiteInt(o.scrollTop, 0, 50_000_000),
  }
}

export interface StoredTab {
  key: string
  title: string
  sql: string
  profileId: string | null
  stream: boolean
  /** 打开的 .sql 文件路径；null = 未命名草稿（自动保存到 localStorage）。 */
  filePath: string | null
  /** 上次保存/打开时的内容（脏标记用）；null = 未命名草稿。 */
  savedSql: string | null
  /** 光标/滚动位置；旧版本存档没有该字段时按顶部处理。 */
  view: StoredTabView
  /** 查询目标库；null = 跟随连接默认。跨重启保留（连接后校验挂载）。 */
  database: string | null
}

export interface StoredWorkspace {
  tabs: StoredTab[]
  activeKey: string
  seq: number
}

export const MAX_STORED_TABS = 50

function asTab(v: unknown): StoredTab | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.key !== 'string' || !o.key.trim()) return null
  if (typeof o.title !== 'string') return null
  if (typeof o.sql !== 'string') return null
  const profileId =
    o.profileId === null || o.profileId === undefined
      ? null
      : typeof o.profileId === 'string'
        ? o.profileId
        : null
  return {
    key: o.key,
    title: o.title,
    sql: o.sql,
    profileId,
    stream: o.stream === true,
    filePath:
      typeof o.filePath === 'string' && o.filePath.trim() ? o.filePath : null,
    savedSql: typeof o.savedSql === 'string' ? o.savedSql : null,
    view: sanitizeView(o.view, o.sql.length),
    database:
      typeof o.database === 'string' && o.database.trim() ? o.database.trim() : null,
  }
}

/** 解析 localStorage 里的工作区；无法可靠恢复时返回 null。 */
export function parseWorkspace(raw: string | null): StoredWorkspace | null {
  if (!raw) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  if (!Array.isArray(o.tabs)) return null

  const seen = new Set<string>()
  const tabs: StoredTab[] = []
  for (const item of o.tabs) {
    const tab = asTab(item)
    if (!tab || seen.has(tab.key)) continue
    seen.add(tab.key)
    tabs.push(tab)
    if (tabs.length >= MAX_STORED_TABS) break
  }
  if (tabs.length === 0) return null

  const activeKey =
    typeof o.activeKey === 'string' && seen.has(o.activeKey) ? o.activeKey : tabs[0].key
  const rawSeq = typeof o.seq === 'number' ? Math.floor(o.seq) : 0
  const seq = Number.isFinite(rawSeq) && rawSeq >= tabs.length ? rawSeq : tabs.length
  return { tabs, activeKey, seq }
}

/** 新标签标题：SQL 1 / SQL 2 …（seq 单调递增，不复用已关闭的编号）。 */
export function nextTabTitle(seq: number): string {
  return `SQL ${Math.max(1, Math.floor(seq))}`
}

/** 关闭 `closing` 后应激活的标签：优先左侧邻居，其次右侧，最后空串。 */
export function pickNeighbor(keys: string[], closing: string): string {
  const i = keys.indexOf(closing)
  if (i < 0) return keys[0] ?? ''
  const remaining = keys.filter((k) => k !== closing)
  if (remaining.length === 0) return ''
  return remaining[Math.min(Math.max(0, i - 1), remaining.length - 1)] ?? remaining[0]
}

/** 拖拽排序：把 `fromKey` 插到 `targetKey` 之前（目标不存在则放到末尾）。 */
export function reorderKeys(
  keys: string[],
  fromKey: string,
  targetKey: string,
): string[] {
  if (fromKey === targetKey) return [...keys]
  const from = keys.indexOf(fromKey)
  if (from < 0) return [...keys]
  const moved = keys[from]
  const rest = keys.filter((k) => k !== fromKey)
  const to = rest.indexOf(targetKey)
  rest.splice(to < 0 ? rest.length : to, 0, moved)
  return rest
}

/** Ctrl+Tab 循环：返回下一个标签 key；不足两个或找不到当前标签时返回 null。 */
export function cycleKey(
  keys: string[],
  activeKey: string,
  delta: number,
): string | null {
  if (keys.length < 2) return null
  const i = keys.indexOf(activeKey)
  if (i < 0) return null
  const next = keys[((i + delta) % keys.length + keys.length) % keys.length]
  return next === activeKey ? null : next
}
