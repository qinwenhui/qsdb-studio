// 布局持久化：侧栏宽度/折叠、编辑器与结果分割比例、窗口位置尺寸。
//
// 全部是**纯 UI 偏好**，与连接/结果无关；localStorage 不可用时静默退回默认值，
// 不影响功能。窗口状态由 Tauri window API 在启动/变化时应用（见 MainView）。

import { reactive, watch } from 'vue'

const STORAGE_KEY = 'qsdb-studio.layout.v1'

export interface StoredLayout {
  sidebarWidth: number
  sidebarCollapsed: boolean
  /** 编辑器面板占垂直空间的比例（NSplit size）。 */
  splitSize: number
  windowWidth: number | null
  windowHeight: number | null
  windowX: number | null
  windowY: number | null
  windowMaximized: boolean
}

export const DEFAULT_LAYOUT: StoredLayout = {
  sidebarWidth: 300,
  sidebarCollapsed: false,
  splitSize: 0.44,
  windowWidth: null,
  windowHeight: null,
  windowX: null,
  windowY: null,
  windowMaximized: false,
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function parse(raw: string | null): StoredLayout {
  if (!raw) return { ...DEFAULT_LAYOUT }
  try {
    const o = JSON.parse(raw) as Partial<StoredLayout>
    return {
      sidebarWidth: clamp(
        typeof o.sidebarWidth === 'number' ? o.sidebarWidth : DEFAULT_LAYOUT.sidebarWidth,
        220,
        560,
      ),
      sidebarCollapsed: Boolean(o.sidebarCollapsed),
      splitSize: clamp(
        typeof o.splitSize === 'number' ? o.splitSize : DEFAULT_LAYOUT.splitSize,
        0.18,
        0.85,
      ),
      windowWidth: numOrNull(o.windowWidth),
      windowHeight: numOrNull(o.windowHeight),
      windowX: numOrNull(o.windowX),
      windowY: numOrNull(o.windowY),
      windowMaximized: Boolean(o.windowMaximized),
    }
  } catch {
    return { ...DEFAULT_LAYOUT }
  }
}

export const layoutState = reactive<StoredLayout>(
  parse(localStorage.getItem(STORAGE_KEY)),
)

let timer: number | undefined

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layoutState))
  } catch {
    // 满/禁用：布局仍在本会话生效。
  }
}

watch(
  layoutState,
  () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(persist, 300)
  },
  { deep: true },
)

/** 恢复默认布局（窗口尺寸位置除外；窗口由用户在系统层控制）。 */
export function resetLayout(): void {
  layoutState.sidebarWidth = DEFAULT_LAYOUT.sidebarWidth
  layoutState.sidebarCollapsed = DEFAULT_LAYOUT.sidebarCollapsed
  layoutState.splitSize = DEFAULT_LAYOUT.splitSize
}
