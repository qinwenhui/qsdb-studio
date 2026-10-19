// 字体与密度偏好的纯解析/收敛规则（单测不启动 Vue 或 DOM）。

export interface UiPrefs {
  /** Monaco 字号（px，0.5 步进）。 */
  editorFontSize: number
  /** Monaco 行高（px）；始终 ≥ 字号 + 4，避免字叠字。 */
  editorLineHeight: number
  /** 结果网格字号（px，0.5 步进）。 */
  gridFontSize: number
  /** 结果网格行高（px）；与字号联动，保证文字不裁切。 */
  gridRowHeight: number
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  editorFontSize: 13.5,
  editorLineHeight: 21,
  gridFontSize: 12.5,
  gridRowHeight: 30,
}

export const UI_PREF_LIMITS = {
  editorFontSize: { min: 10, max: 22 },
  editorLineHeight: { min: 16, max: 40 },
  gridFontSize: { min: 9, max: 20 },
  gridRowHeight: { min: 22, max: 56 },
} as const

export function editorLineMin(fontSize: number): number {
  return Math.max(UI_PREF_LIMITS.editorLineHeight.min, Math.ceil(fontSize) + 4)
}

export function gridRowMin(fontSize: number): number {
  return Math.max(UI_PREF_LIMITS.gridRowHeight.min, Math.ceil(fontSize) + 10)
}

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.round(v * 2) / 2))
}

/** 收敛任意输入：坏字段用默认值；字号变化后行高不足时自动抬到可读下限。 */
export function normalizeUiPrefs(raw: unknown): UiPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const editorFontSize = clampNumber(
    o.editorFontSize,
    UI_PREF_LIMITS.editorFontSize.min,
    UI_PREF_LIMITS.editorFontSize.max,
    DEFAULT_UI_PREFS.editorFontSize,
  )
  const editorLineHeight = clampNumber(
    o.editorLineHeight,
    editorLineMin(editorFontSize),
    UI_PREF_LIMITS.editorLineHeight.max,
    Math.max(DEFAULT_UI_PREFS.editorLineHeight, editorLineMin(editorFontSize)),
  )
  const gridFontSize = clampNumber(
    o.gridFontSize,
    UI_PREF_LIMITS.gridFontSize.min,
    UI_PREF_LIMITS.gridFontSize.max,
    DEFAULT_UI_PREFS.gridFontSize,
  )
  const gridRowHeight = clampNumber(
    o.gridRowHeight,
    gridRowMin(gridFontSize),
    UI_PREF_LIMITS.gridRowHeight.max,
    Math.max(DEFAULT_UI_PREFS.gridRowHeight, gridRowMin(gridFontSize)),
  )
  return { editorFontSize, editorLineHeight, gridFontSize, gridRowHeight }
}

export function parseUiPrefs(raw: string | null): UiPrefs {
  if (!raw) return { ...DEFAULT_UI_PREFS }
  try {
    return normalizeUiPrefs(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}
