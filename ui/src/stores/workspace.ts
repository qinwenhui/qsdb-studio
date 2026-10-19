// 编辑器多标签工作区。
//
// 一个标签 = 一份 SQL 草稿 + 一条连接绑定（多连接：不同标签可以是不同实例）。
// 结果页按 `editorKey` 隔离（query store）；关闭标签会一并释放它名下的结果
// 与流式 spool。标签本身持久化到 localStorage（SQL 防丢稿），连接档案只在
// 启动时按 id 复原——**不会自动重连**（凭证/服务可用性由用户显式决定）。

import { computed, reactive, watch } from 'vue'
import { closeResultsOf } from './query'
import { appState } from './app'
import { clearErrorMarker, uiState } from './ui'
import {
  DEFAULT_TAB_VIEW,
  MAX_STORED_TABS,
  cycleKey,
  nextTabTitle,
  parseWorkspace,
  pickNeighbor,
  reorderKeys,
  type StoredTabView,
  type StoredWorkspace,
} from '../utils/workspace'

import { tt } from '../i18n'

const STORAGE_KEY = 'qsdb-studio.workspace.v1'
/** M2 之前的单编辑器草稿：首次升级时迁移进第一个标签。 */
const LEGACY_SQL_KEY = 'qsdb-studio.sql'

export const DEFAULT_SQL = `-- Ctrl/Cmd+Enter 执行光标所在语句（有选区时只执行选区）
-- Ctrl/Cmd+Shift+Enter 执行整篇（逐条执行，失败即停）
-- Ctrl/Cmd+T 新建标签；Ctrl/Cmd+W 关闭标签
-- 多挂载时表名可写 db.table；参数占位符支持 $1 或 ?
SELECT 1 AS hello;`

export interface EditorTab {
  key: string
  title: string
  sql: string
  /** 绑定的连接档案；null = 未绑定（可以只写 SQL）。 */
  profileId: string | null
  /** 该标签的执行通道开关（按标签记忆）。 */
  stream: boolean
  /** 打开的 .sql 文件路径；null = 未命名草稿。 */
  filePath: string | null
  /** 上次保存/打开时的内容；null = 未命名草稿。 */
  savedSql: string | null
  /** 光标偏移与滚动位置（切换标签/重启后恢复）。 */
  view: StoredTabView
  /** 查询目标库；null = 跟随连接默认（不向服务端传 database）。 */
  database: string | null
}

interface WorkspaceStore {
  tabs: EditorTab[]
  activeKey: string
  seq: number
}

export const workspaceState = reactive<WorkspaceStore>({
  tabs: [],
  activeKey: '',
  seq: 0,
})

export const activeEditor = computed<EditorTab | null>(
  () => workspaceState.tabs.find((t) => t.key === workspaceState.activeKey) ?? null,
)

export const activeSql = computed(() => activeEditor.value?.sql ?? '')

let tabSeq = 0

function makeKey(): string {
  tabSeq += 1
  return `ed-${Date.now()}-${tabSeq}`
}

function toStored(): StoredWorkspace {
  return {
    tabs: workspaceState.tabs.slice(0, MAX_STORED_TABS).map(
      ({ key, title, sql, profileId, stream, filePath, savedSql, view, database }) => ({
        key,
        title,
        sql,
        profileId,
        stream,
        filePath,
        savedSql,
        view: { cursor: view.cursor, scrollTop: view.scrollTop },
        database,
      }),
    ),
    activeKey: workspaceState.activeKey,
    seq: workspaceState.seq,
  }
}

let persistTimer: number | undefined

function persistNow() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStored()))
  } catch {
    // localStorage 满了/被禁用：草稿仍在本会话内可用，不打断编辑。
  }
}

function schedulePersist() {
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(persistNow, 300)
}

/** 把活动标签的连接同步到 app 状态（侧栏/身份徽章都读它）。 */
function syncBinding() {
  appState.activeProfileId = activeEditor.value?.profileId ?? null
  // 通知层用它判断查询是不是在“看不见的后台标签”里完成。
  uiState.activeEditorKey = activeEditor.value?.key ?? ''
}

function addTab(
  profileId: string | null,
  sql: string,
  database: string | null = null,
): EditorTab {
  workspaceState.seq += 1
  const tab: EditorTab = {
    key: makeKey(),
    title: nextTabTitle(workspaceState.seq),
    sql,
    profileId,
    stream: false,
    filePath: null,
    savedSql: null,
    view: { ...DEFAULT_TAB_VIEW },
    database,
  }
  workspaceState.tabs.push(tab)
  workspaceState.activeKey = tab.key
  syncBinding()
  return tab
}

/**
 * 新建编辑器标签（默认沿用当前标签的连接与目标库）。
 * 显式换到另一条连接时不继承目标库，避免把旧库名带到新连接。
 */
export function newEditorTab(profileId?: string | null, sql = ''): EditorTab {
  const pid =
    profileId === undefined ? (activeEditor.value?.profileId ?? appState.activeProfileId) : profileId
  const inheritDb =
    activeEditor.value && activeEditor.value.profileId === (pid ?? null)
      ? activeEditor.value.database
      : null
  const tab = addTab(pid ?? null, sql, inheritDb)
  clearErrorMarker()
  return tab
}

/** 关闭编辑器标签（同时关闭其名下结果页、释放流）。 */
export function closeEditorTab(key: string): void {
  const idx = workspaceState.tabs.findIndex((t) => t.key === key)
  if (idx < 0) return
  const closing = workspaceState.tabs[idx]
  const dirty = Boolean(closing.filePath) && closing.sql !== (closing.savedSql ?? '')
  if (
    dirty &&
    !window.confirm(
      tt`「${closing.title}」有未保存修改。关闭后这些修改会丢失（未命名草稿会自动保存，文件标签不会）。\n\n仍要关闭吗？`,
    )
  ) {
    return
  }
  const keys = workspaceState.tabs.map((t) => t.key)
  const next = pickNeighbor(keys, key)

  closeResultsOf(key)
  workspaceState.tabs.splice(idx, 1)

  if (workspaceState.activeKey === key) {
    workspaceState.activeKey = next
    clearErrorMarker()
  }
  if (workspaceState.tabs.length === 0) {
    addTab(closing.profileId, '', closing.database)
  } else {
    syncBinding()
  }
}

/** 重命名标签（空名称忽略；文件标签另存为后仍会回到文件名）。 */
export function renameEditorTab(key: string, title: string): void {
  const tab = workspaceState.tabs.find((t) => t.key === key)
  const next = title.trim()
  if (!tab || !next) return
  tab.title = next
}

/** 拖拽排序：把 fromKey 插到 targetKey 之前。 */
export function moveEditorTab(fromKey: string, targetKey: string): void {
  const order = reorderKeys(
    workspaceState.tabs.map((t) => t.key),
    fromKey,
    targetKey,
  )
  const byKey = new Map(workspaceState.tabs.map((t) => [t.key, t]))
  workspaceState.tabs.splice(
    0,
    workspaceState.tabs.length,
    ...order.map((k) => byKey.get(k)).filter((t): t is EditorTab => Boolean(t)),
  )
}

/** Ctrl+Tab / Ctrl+Shift+Tab：按标签顺序循环。 */
export function cycleEditorTab(delta: number): void {
  const next = cycleKey(
    workspaceState.tabs.map((t) => t.key),
    workspaceState.activeKey,
    delta,
  )
  if (next) activateEditorTab(next)
}

/**
 * 批量关闭标签（关闭其他/右侧）。
 * 脏文件只确认一次；全部关闭时保留一个空白标签，与单标签关闭语义一致。
 */
export function closeEditorTabs(keys: string[]): void {
  const set = new Set(keys)
  const targets = workspaceState.tabs.filter((t) => set.has(t.key))
  if (targets.length === 0) return

  const dirty = targets.filter(
    (t) => Boolean(t.filePath) && t.sql !== (t.savedSql ?? ''),
  )
  if (
    dirty.length > 0 &&
    !window.confirm(
      tt`有 ${dirty.length} 个 SQL 文件标签存在未保存修改（${dirty
        .slice(0, 3)
        .map((t) => t.title)
        .join('、')}${dirty.length > 3 ? ' 等' : ''}）。关闭后这些修改会丢失。\n\n仍要关闭吗？`,
    )
  ) {
    return
  }

  const activeIdx = workspaceState.tabs.findIndex(
    (t) => t.key === workspaceState.activeKey,
  )
  const closingActive = set.has(workspaceState.activeKey)
  for (const t of targets) closeResultsOf(t.key)
  const remaining = workspaceState.tabs.filter((t) => !set.has(t.key))
  workspaceState.tabs.splice(0, workspaceState.tabs.length, ...remaining)

  if (remaining.length === 0) {
    addTab(targets[0]?.profileId ?? null, '', targets[0]?.database ?? null)
    clearErrorMarker()
    return
  }
  if (closingActive) {
    const idx = Math.max(0, Math.min(activeIdx - 1, remaining.length - 1))
    workspaceState.activeKey = remaining[idx].key
    clearErrorMarker()
  }
  syncBinding()
}

/** 激活标签：把连接绑定同步给 app（侧栏/身份徽章跟着变）。 */
export function activateEditorTab(key: string): void {
  const tab = workspaceState.tabs.find((t) => t.key === key)
  if (!tab || workspaceState.activeKey === key) return
  workspaceState.activeKey = key
  syncBinding()
  clearErrorMarker()
}

/**
 * 找一个绑定指定连接的编辑器标签：优先当前标签，其次已有标签，
 * 都没有就新建一个（用于“从面板发起的查询”仍回到自己的连接）。
 */
export function editorForProfile(profileId: string): EditorTab {
  const active = activeEditor.value
  if (active?.profileId === profileId) return active
  const existing = workspaceState.tabs.find((t) => t.profileId === profileId)
  if (existing) {
    // 结果要落在用户看得见的标签上。
    activateEditorTab(existing.key)
    return existing
  }
  return newEditorTab(profileId)
}

/** 把当前标签换绑到另一条连接（不发起网络请求）。 */
export function bindActiveProfile(profileId: string | null): void {
  const tab = activeEditor.value
  if (!tab) return
  // 换连接时清掉目标库：旧库名对新连接通常不存在，避免 404。
  if (tab.profileId !== profileId) tab.database = null
  tab.profileId = profileId
  syncBinding()
  clearErrorMarker()
}

/** 历史/收藏回填到当前编辑器。 */
export function setActiveSql(sql: string): void {
  const tab = activeEditor.value
  if (!tab) return
  tab.sql = sql
  schedulePersist()
}

/**
 * 记录指定标签的光标/滚动位置。
 * 用原地赋值而不是替换对象：Monaco 的滚动回调很频繁，避免制造无谓的
 * watcher 触发；持久化本身由 workspace 的防抖 watcher 负责。
 * 按 key 而不是“当前活动标签”写，专门规避切标签瞬间的迟到事件。
 */
export function updateEditorView(tabKey: string, view: StoredTabView): void {
  const tab = workspaceState.tabs.find((t) => t.key === tabKey)
  if (!tab) return
  tab.view.cursor = Math.max(0, Math.round(view.cursor))
  tab.view.scrollTop = Math.max(0, Math.round(view.scrollTop))
}

/** 档案被删除：清掉所有标签对它的绑定（结果页仍可只读浏览）。 */
export function dropProfile(profileId: string): void {
  for (const tab of workspaceState.tabs) {
    if (tab.profileId === profileId) {
      tab.profileId = null
      tab.database = null
    }
  }
  syncBinding()
}

/**
 * 启动时对齐档案列表：
 * - 删除已不存在的档案绑定；
 * - 当前标签未绑定 → 默认绑到第一条可用档案（有档案时）。
 */
export function ensureBindings(validIds: string[]): void {
  const valid = new Set(validIds)
  for (const tab of workspaceState.tabs) {
    if (tab.profileId && !valid.has(tab.profileId)) {
      tab.profileId = null
      tab.database = null
    }
  }
  const tab = activeEditor.value
  if (tab && !tab.profileId) {
    const fallback =
      appState.activeProfileId && valid.has(appState.activeProfileId)
        ? appState.activeProfileId
        : (validIds[0] ?? null)
    tab.profileId = fallback
  }
  syncBinding()
}

// ---------------------------------------------------------------------------
// 初始化 / 持久化
// ---------------------------------------------------------------------------

const saved = parseWorkspace(localStorage.getItem(STORAGE_KEY))
if (saved) {
  workspaceState.tabs = saved.tabs
  workspaceState.activeKey = saved.activeKey
  workspaceState.seq = saved.seq
} else {
  const legacy = localStorage.getItem(LEGACY_SQL_KEY)
  addTab(null, legacy ?? DEFAULT_SQL)
}
if (!activeEditor.value) {
  // 理论上不会发生（parseWorkspace 保证非空）；兜底建一个可用标签。
  addTab(null, DEFAULT_SQL)
}
syncBinding()

// 任何改动（SQL 输入、标签切换、绑定变化、流式开关）都防抖落盘。
watch(
  () => [workspaceState.tabs, workspaceState.activeKey, workspaceState.seq],
  schedulePersist,
  { deep: true },
)
