// 连接颜色标签：只存 UI 偏好（localStorage），不进入档案/日志/凭据。
// 用途：多连接同时打开时，在顶栏、编辑器标签、结果页、连接卡片上保持
// 同一颜色，降低“把 prod 当 dev”的概率。

import { reactive, watch } from 'vue'

const STORAGE_KEY = 'qsdb-studio.connection-colors.v1'

/** 8 个在浅/深色主题下都可辨认的颜色。 */
export const CONNECTION_COLORS = [
  '#3b6ef5',
  '#16a34a',
  '#d97706',
  '#dc2626',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#475569',
]

type ColorMap = Record<string, string>

function load(): ColorMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object') return {}
    const out: ColorMap = {}
    for (const [id, color] of Object.entries(data as Record<string, unknown>)) {
      if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) out[id] = color
    }
    return out
  } catch {
    return {}
  }
}

const colors = reactive<ColorMap>(load())

watch(
  colors,
  () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(colors))
    } catch {
      // 颜色只是辅助信息，存储失败不影响功能。
    }
  },
  { deep: true },
)

function hash(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h
}

/** 未手动设置时按档案 id 稳定分配一个默认色。 */
export function colorForProfile(profileId: string): string {
  return colors[profileId] ?? CONNECTION_COLORS[hash(profileId) % CONNECTION_COLORS.length]
}

export function setProfileColor(profileId: string, color: string): void {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return
  colors[profileId] = color
}

export function clearProfileColor(profileId: string): void {
  delete colors[profileId]
}
