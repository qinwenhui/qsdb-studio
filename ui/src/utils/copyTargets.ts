// COPY 最近目标路径：只存本地偏好（localStorage），不含任何秘密。
//
// 去重按「格式 + 目标」；同一路径先后用 CSV / PARQUET 导出时保留两条——
// 两种格式的语义不同（CSV 单文件、Parquet 目录），不能互相覆盖。

export type RecentCopyFormat = 'parquet' | 'csv'

export interface RecentCopyTarget {
  target: string
  format: RecentCopyFormat
  /** 最近使用时间（ms）。 */
  at: number
}

export const RECENT_COPY_TARGETS_KEY = 'qsdb-studio.copy.recent-targets.v1'
export const RECENT_COPY_TARGETS_MAX = 8

function isFormat(v: unknown): v is RecentCopyFormat {
  return v === 'parquet' || v === 'csv'
}

/** 宽容读取（localStorage 可能被旧版本/手工改坏）；坏条目丢弃，不猜。 */
export function parseRecentTargets(raw: unknown): RecentCopyTarget[] {
  if (!Array.isArray(raw)) return []
  const out: RecentCopyTarget[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Partial<RecentCopyTarget>
    if (typeof o.target !== 'string') continue
    const target = o.target.trim()
    if (!target || !isFormat(o.format)) continue
    const key = `${o.format}|${target}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      target,
      format: o.format,
      at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0,
    })
    if (out.length >= RECENT_COPY_TARGETS_MAX) break
  }
  return out
}

/** 把一次成功使用的目标置顶；同格式同路径去重，最多保留 8 条。 */
export function addRecentTarget(
  list: RecentCopyTarget[],
  target: string,
  format: RecentCopyFormat,
  at: number,
): RecentCopyTarget[] {
  const t = target.trim()
  if (!t) return list.slice(0, RECENT_COPY_TARGETS_MAX)
  const rest = list.filter((r) => !(r.target === t && r.format === format))
  return [{ target: t, format, at }, ...rest].slice(0, RECENT_COPY_TARGETS_MAX)
}

export function loadRecentTargets(storage: Pick<Storage, 'getItem'>): RecentCopyTarget[] {
  try {
    const raw = storage.getItem(RECENT_COPY_TARGETS_KEY)
    return raw ? parseRecentTargets(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

export function saveRecentTargets(
  storage: Pick<Storage, 'setItem'>,
  list: RecentCopyTarget[],
): void {
  try {
    storage.setItem(RECENT_COPY_TARGETS_KEY, JSON.stringify(list.slice(0, RECENT_COPY_TARGETS_MAX)))
  } catch {
    // 隐私模式/配额满：偏好存不下不影响导出本身。
  }
}

/** 选项值（格式 + 路径）用于 NSelect 唯一键。 */
export function recentTargetValue(r: RecentCopyTarget): string {
  return `${r.format}|${r.target}`
}
