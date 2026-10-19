// 字体与密度偏好：编辑器字号/行高、结果网格字号/行高。
//
// 偏好在启动时同步读取并写入 CSS 变量（结果网格），Monaco 通过 props 直接
// 消费；两者都只影响渲染，不改变任何查询/结果语义。

import { reactive } from 'vue'
import {
  DEFAULT_UI_PREFS,
  UI_PREF_LIMITS,
  editorLineMin,
  gridRowMin,
  parseUiPrefs,
  type UiPrefs,
} from '../utils/uiPrefs'

const STORAGE_KEY = 'qsdb-studio.ui-prefs.v1'

function load(): UiPrefs {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_UI_PREFS }
  return parseUiPrefs(localStorage.getItem(STORAGE_KEY))
}

export const uiPrefs = reactive<UiPrefs>(load())

function persist() {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...uiPrefs }))
  } catch {
    // 满/禁用：当前会话仍生效。
  }
}

export function applyUiPrefs(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty('--grid-font-size', `${uiPrefs.gridFontSize}px`)
  root.style.setProperty(
    '--grid-mono-font-size',
    `${Math.max(8.5, uiPrefs.gridFontSize - 0.5)}px`,
  )
  root.style.setProperty('--grid-row-height', `${uiPrefs.gridRowHeight}px`)
}

applyUiPrefs()

export function setEditorFontSize(v: number): void {
  uiPrefs.editorFontSize = Math.max(
    UI_PREF_LIMITS.editorFontSize.min,
    Math.min(UI_PREF_LIMITS.editorFontSize.max, Math.round(v * 2) / 2),
  )
  uiPrefs.editorLineHeight = Math.max(uiPrefs.editorLineHeight, editorLineMin(uiPrefs.editorFontSize))
  persist()
}

export function setEditorLineHeight(v: number): void {
  const min = editorLineMin(uiPrefs.editorFontSize)
  uiPrefs.editorLineHeight = Math.max(
    min,
    Math.min(UI_PREF_LIMITS.editorLineHeight.max, Math.round(v)),
  )
  persist()
}

export function setGridFontSize(v: number): void {
  uiPrefs.gridFontSize = Math.max(
    UI_PREF_LIMITS.gridFontSize.min,
    Math.min(UI_PREF_LIMITS.gridFontSize.max, Math.round(v * 2) / 2),
  )
  uiPrefs.gridRowHeight = Math.max(uiPrefs.gridRowHeight, gridRowMin(uiPrefs.gridFontSize))
  applyUiPrefs()
  persist()
}

export function setGridRowHeight(v: number): void {
  const min = gridRowMin(uiPrefs.gridFontSize)
  uiPrefs.gridRowHeight = Math.max(
    min,
    Math.min(UI_PREF_LIMITS.gridRowHeight.max, Math.round(v)),
  )
  applyUiPrefs()
  persist()
}

export function resetUiPrefs(): void {
  Object.assign(uiPrefs, DEFAULT_UI_PREFS)
  applyUiPrefs()
  persist()
}
