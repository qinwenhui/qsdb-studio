// SQL 文件：打开/保存/另存为 + 最近文件。
//
// 文件读写全部走 Rust IPC（`read_text_file` / `save_text_file`），前端不碰
// 文件系统；标签的 filePath/savedSql 决定“未保存”标记。未命名标签仍由
// workspace 的自动草稿兜底（localStorage），不会因为没保存而丢 SQL。

import { open, save } from '@tauri-apps/plugin-dialog'
import { reactive } from 'vue'
import * as ipc from '../ipc'
import { appState } from './app'
import {
  activateEditorTab,
  activeEditor,
  newEditorTab,
  workspaceState,
  type EditorTab,
} from './workspace'

import { t, tt } from '../i18n'

const RECENT_KEY = 'qsdb-studio.recent-sql-files.v1'
const MAX_RECENT = 10
const SQL_FILTER = [{ name: 'SQL', extensions: ['sql'] }]

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    return data
      .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      .slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

export const sqlFilesState = reactive({
  recent: loadRecent(),
})

function persistRecent() {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(sqlFilesState.recent))
  } catch {
    // 最近文件只是便利功能，不做降级处理。
  }
}

function pushRecent(path: string) {
  sqlFilesState.recent = [path, ...sqlFilesState.recent.filter((p) => p !== path)].slice(
    0,
    MAX_RECENT,
  )
  persistRecent()
}

function dropRecent(path: string) {
  const next = sqlFilesState.recent.filter((p) => p !== path)
  if (next.length !== sqlFilesState.recent.length) {
    sqlFilesState.recent = next
    persistRecent()
  }
}

/** 路径 → 文件名（Windows / POSIX 都支持）。 */
export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(i + 1) || path
}

/** 文件标签是否有未保存修改（未命名草稿不显示脏点，草稿自动保存）。 */
export function isTabDirty(tab: EditorTab): boolean {
  if (!tab.filePath) return false
  return tab.sql !== (tab.savedSql ?? '')
}

export interface SqlOpenOutcome {
  tab: EditorTab
  /** true = 该文件已在某个标签里打开，直接激活而没有重新读盘。 */
  existing: boolean
}

/** 打开一个 .sql 文件：已有同路径标签则激活，否则新标签并继承当前连接。 */
export async function openSqlFile(path: string): Promise<SqlOpenOutcome> {
  const target = path.trim()
  if (!/\.sql$/i.test(target)) {
    throw new Error(tt`只支持打开 .sql 文件：${target}`)
  }
  const existing = workspaceState.tabs.find((t) => t.filePath === target)
  if (existing) {
    activateEditorTab(existing.key)
    pushRecent(target)
    return { tab: existing, existing: true }
  }

  let text: string
  try {
    text = await ipc.readTextFile(target)
  } catch (e) {
    // 文件被移动/删除：从最近文件里移除，避免每次点都失败。
    dropRecent(target)
    throw e
  }

  const pid = activeEditor.value?.profileId ?? appState.activeProfileId ?? null
  const tab = newEditorTab(pid, text)
  tab.title = basename(target)
  tab.filePath = target
  tab.savedSql = text
  pushRecent(target)
  return { tab, existing: false }
}

/** 弹出文件选择框并打开（取消返回 null）。 */
export async function openSqlFileDialog(): Promise<SqlOpenOutcome | null> {
  const picked = await open({
    title: t('打开 SQL 文件'),
    multiple: false,
    directory: false,
    filters: SQL_FILTER,
  })
  const path = Array.isArray(picked) ? picked[0] : picked
  if (!path) return null
  return openSqlFile(path)
}

export interface SqlSaveOutcome {
  saved: boolean
  path: string | null
}

/** 保存标签到已有路径；`saveAs` 或无路径时弹保存框。 */
export async function saveSqlTab(
  tab: EditorTab,
  saveAs = false,
): Promise<SqlSaveOutcome> {
  let path = tab.filePath
  if (!path || saveAs) {
    const suggested = path ?? `${tab.title.replace(/[\\/:*?"<>|]+/g, '-')}.sql`
    const picked = await save({
      title: saveAs ? t('SQL 另存为') : t('保存 SQL 文件'),
      defaultPath: suggested,
      filters: SQL_FILTER,
    })
    if (!picked) return { saved: false, path: null }
    path = picked
  }
  if (!/\.[^\\/]+$/.test(path)) path += '.sql'

  await ipc.saveTextFile(path, tab.sql, false)
  tab.filePath = path
  tab.title = basename(path)
  tab.savedSql = tab.sql
  pushRecent(path)
  return { saved: true, path }
}

/** 保存当前标签（快捷键/命令面板共用）。 */
export async function saveActiveSql(saveAs = false): Promise<SqlSaveOutcome | null> {
  const tab = activeEditor.value
  if (!tab) return null
  return saveSqlTab(tab, saveAs)
}
