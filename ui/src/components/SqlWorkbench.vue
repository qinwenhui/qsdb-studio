<script setup lang="ts">
import {
  NButton,
  NDropdown,
  NInput,
  NSelect,
  NSplit,
  NSwitch,
  NTooltip,
  useMessage,
  type DropdownOption,
  type SelectOption,
} from 'naive-ui'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import * as ipc from '../ipc'
import type { ParamInput, QueryOptionsInput, SqlStatement } from '../ipc/types'
import { appState, baseQueryOptions, toStudioError } from '../stores/app'
import { openParams } from '../stores/params'
import {
  closeResultsOf,
  queryState,
  resultsOf,
  runBatch,
  runSql,
} from '../stores/query'
import { editorActions } from '../stores/actions'
import { colorForProfile } from '../stores/connectionColors'
import { guardSqlForExecution } from '../stores/execGuard'
import { layoutState } from '../stores/layout'
import { tableDragState } from '../stores/tableDrag'
import {
  basename,
  isTabDirty,
  openSqlFile,
  openSqlFileDialog,
  saveActiveSql,
  sqlFilesState,
} from '../stores/sqlFiles'
import { clearErrorMarker, uiState } from '../stores/ui'
import {
  activeEditor,
  activateEditorTab,
  closeEditorTab,
  closeEditorTabs,
  moveEditorTab,
  newEditorTab,
  renameEditorTab,
  updateEditorView,
  workspaceState,
  type EditorTab,
} from '../stores/workspace'
import { copyText } from '../utils/clipboard'
import { scanPlaceholders } from '../utils/params'
import { countNewlines, statementAtCursor } from '../utils/sql'
import DangerConfirmModal from './DangerConfirmModal.vue'
import GuardrailModal from './GuardrailModal.vue'
import ParamsModal from './ParamsModal.vue'
import ResultPanel from './ResultPanel.vue'
import SqlEditor, {
  type EditorViewReport,
  type EditorViewState,
  type ExecuteMode,
  type ExecuteRequest,
} from './SqlEditor.vue'

import { t, tt } from '../i18n'

const message = useMessage()
const editorRef = ref<InstanceType<typeof SqlEditor> | null>(null)

const sql = computed({
  get: () => activeEditor.value?.sql ?? '',
  set: (v: string) => {
    if (activeEditor.value) activeEditor.value.sql = v
  },
})

const streamEnabled = computed({
  get: () => activeEditor.value?.stream ?? false,
  set: (v: boolean) => {
    if (activeEditor.value) activeEditor.value.stream = v
  },
})

const placeholders = computed(() => scanPlaceholders(sql.value))

// ---------------------------------------------------------------------------
// 查询目标库（按标签记忆；null = 跟随连接默认，不向服务端传 database）
// ---------------------------------------------------------------------------

const DB_FOLLOW = '__follow__'
const effectiveDefaultDb = computed(
  () => appState.session?.defaultDb ?? appState.defaultDb ?? 'default',
)

const databaseValue = computed<string>({
  get: () => activeEditor.value?.database ?? DB_FOLLOW,
  set: (v) => {
    const tab = activeEditor.value
    if (!tab) return
    tab.database = v === DB_FOLLOW ? null : v
  },
})

const databaseOptions = computed<SelectOption[]>(() => {
  const opts: SelectOption[] = [
    { label: tt`跟随连接默认（${effectiveDefaultDb.value}）`, value: DB_FOLLOW },
  ]
  for (const db of appState.databases) {
    opts.push({
      label: db.readOnly ? tt`${db.name}（只读）` : db.name,
      value: db.name,
    })
  }
  const selected = activeEditor.value?.database
  if (selected && !appState.databases.some((d) => d.name === selected)) {
    opts.push({ label: tt`${selected}（未知挂载）`, value: selected })
  }
  return opts
})

// 连接切换/元数据刷新后，目标库若已不在挂载列表就回到“跟随默认”。
watch(
  () => [activeEditor.value?.key, appState.databases.map((d) => d.name).join('|')] as const,
  () => {
    const tab = activeEditor.value
    if (!tab?.database || appState.databases.length === 0) return
    if (!appState.databases.some((d) => d.name === tab.database)) tab.database = null
  },
  { immediate: true },
)

/** 执行参数：有显式目标库才传 database；不改变连接会话默认库。 */
function queryOptions(params: ParamInput[] = []): QueryOptionsInput {
  const opts: QueryOptionsInput = { ...baseQueryOptions(), params }
  const db = activeEditor.value?.database
  if (db) opts.database = db
  return opts
}

/** 当前标签的光标/滚动位置（由 SqlEditor 回报，切标签前已写入该标签）。 */
const editorView = computed<EditorViewState>(() => activeEditor.value?.view ?? { cursor: 0, scrollTop: 0 })

function onEditorViewChange(view: EditorViewReport) {
  const { tabKey, cursor, scrollTop } = view
  updateEditorView(tabKey, { cursor, scrollTop })
}

// 元数据树表行 → 查询窗口（pointer 拖拽由 MetadataTree 驱动，这里只负责落点提示）。
const tableDragOver = computed(
  () => tableDragState.active && tableDragState.overEditor,
)

// 切标签前同步抓取旧标签的最后位置（滚动节流的尾事件可能还没回报）。
watch(
  () => workspaceState.activeKey,
  (_next, previous) => {
    if (!previous) return
    const view = editorRef.value?.snapshotView()
    if (view) updateEditorView(previous, view)
  },
  { flush: 'sync' },
)

/** 错误行内标只属于发起批执行的标签，切走再切回也不会错标。 */
const marker = computed(() =>
  uiState.errorMarker && uiState.errorMarker.editorKey === activeEditor.value?.key
    ? uiState.errorMarker
    : null,
)

/** 当前标签绑定的连接是否真的打开了。 */
const connected = computed(() => {
  const id = activeEditor.value?.profileId
  return Boolean(id && appState.connections[id])
})

const boundProfile = computed(() =>
  activeEditor.value?.profileId
    ? (appState.profiles.find((p) => p.id === activeEditor.value?.profileId) ?? null)
    : null,
)

const resultCount = computed(() =>
  activeEditor.value ? resultsOf(activeEditor.value.key).length : 0,
)

const readOnly = computed(() => boundProfile.value?.readOnly ?? false)

interface GuardItem {
  sql: string
  line: number
}

/**
 * 执行前的客户端护栏：
 * 1. 只读连接拦截所有非查询类语句（服务端 grants 仍是最终边界）；
 * 2. 危险语句弹二次确认（DROP/TRUNCATE/无 WHERE 的 UPDATE/DELETE 需输入表名）。
 */
async function guardStatements(
  items: GuardItem[],
  ctx: { editorKey: string; profileId: string },
): Promise<boolean> {
  const outcome = await guardSqlForExecution(ctx.profileId, items)
  if (!outcome.ok && !outcome.cancelled && outcome.reason) {
    message.error(outcome.reason, { duration: 9000 })
  }
  return outcome.ok
}

function tabConnected(tab: EditorTab): boolean {
  return Boolean(tab.profileId && appState.connections[tab.profileId])
}

function tabColor(tab: EditorTab): string | undefined {
  return tab.profileId ? colorForProfile(tab.profileId) : undefined
}

function tabConnLabel(tab: EditorTab): string {
  if (!tab.profileId) return t('未绑定')
  const name = appState.profiles.find((p) => p.id === tab.profileId)?.name ?? t('已删除')
  return tabConnected(tab) ? name : tt`${name} · 未连接`
}

function tabTooltip(tab: EditorTab): string {
  const parts = [tab.filePath ?? t('未命名草稿（自动保存到本地）')]
  if (isTabDirty(tab)) parts.push(t('有未保存修改'))
  const preview = tab.sql.trim()
  if (preview) parts.push(preview.slice(0, 300))
  return parts.join('\n')
}

async function doOpenSql() {
  try {
    const outcome = await openSqlFileDialog()
    if (!outcome) return
    message.success(
      outcome.existing
        ? tt`已切换到已打开的文件：${outcome.tab.title}`
        : tt`已打开 ${outcome.tab.title}`,
    )
  } catch (e) {
    const err = toStudioError(e)
    message.error(`${err.code ?? err.kind}: ${err.message}`, { duration: 6000 })
  }
}

async function doSaveSql(saveAs: boolean) {
  try {
    const outcome = await saveActiveSql(saveAs)
    if (outcome?.saved) message.success(tt`已保存 ${outcome.path}`)
  } catch (e) {
    const err = toStudioError(e)
    message.error(`${err.code ?? err.kind}: ${err.message}`, { duration: 6000 })
  }
}

async function openRecent(path: string) {
  try {
    const outcome = await openSqlFile(path)
    if (!outcome.existing) message.success(tt`已打开 ${outcome.tab.title}`)
  } catch (e) {
    const err = toStudioError(e)
    message.error(`${err.code ?? err.kind}: ${err.message}`, { duration: 6000 })
  }
}

const fileOptions = computed<DropdownOption[]>(() => {
  const tabs: DropdownOption[] = [
    { label: t('打开 SQL 文件…  Ctrl/⌘+O'), key: 'open' },
    {
      label: t('保存  Ctrl/⌘+S'),
      key: 'save',
      disabled: !activeEditor.value,
    },
    {
      label: t('另存为…  Ctrl/⌘+Shift+S'),
      key: 'save-as',
      disabled: !activeEditor.value,
    },
  ]
  tabs.push({ type: 'divider', key: 'd1' })
  if (sqlFilesState.recent.length === 0) {
    tabs.push({ label: t('（没有最近文件）'), key: 'noop', disabled: true })
  } else {
    for (const p of sqlFilesState.recent) {
      tabs.push({ label: tt`最近：${basename(p)}`, key: `recent:${p}` })
    }
  }
  return tabs
})

function onFileSelect(key: string) {
  if (key === 'open') void doOpenSql()
  else if (key === 'save') void doSaveSql(false)
  else if (key === 'save-as') void doSaveSql(true)
  else if (key.startsWith('recent:')) void openRecent(key.slice('recent:'.length))
}

/** 执行上下文：编辑器标签 + 连接在**点击瞬间**快照，切标签不影响在跑的任务。 */
function context(): { editorKey: string; profileId: string } | null {
  const tab = activeEditor.value
  if (!tab) return null
  if (!tab.profileId) {
    message.warning(t('当前标签未绑定连接：请在顶栏或连接管理里选择一条连接'))
    return null
  }
  if (!appState.connections[tab.profileId]) {
    message.warning(
      tt`连接「${boundProfile.value?.name ?? tab.profileId}」未打开：请先连接，或把该标签换到其他连接。`,
      { duration: 6000 },
    )
    return null
  }
  return { editorKey: tab.key, profileId: tab.profileId }
}

/** 拆语句（失败时给出可见错误并返回 null）。 */
async function splitStatements(
  text: string,
  lineOffset: number,
): Promise<SqlStatement[] | null> {
  try {
    const statements = await ipc.sqlSplit(text)
    if (lineOffset === 0) return statements
    return statements.map((s) => ({
      ...s,
      startLine: s.startLine + lineOffset,
      endLine: s.endLine + lineOffset,
    }))
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
    return null
  }
}

/**
 * 执行一段文本：单条走参数弹窗/普通执行；多条走逐条批量（失败即停）。
 * `lineOffset` 用于把拆分行号映射回编辑器（选区/光标到结尾）。
 */
async function executeText(
  text: string,
  lineOffset: number,
  ctx: { editorKey: string; profileId: string },
): Promise<void> {
  if (!text.trim()) {
    message.info(t('没有可执行的 SQL'))
    return
  }
  const statements = await splitStatements(text, lineOffset)
  if (!statements) return
  if (statements.length === 0) {
    message.info(t('没有可执行的 SQL 语句（只有注释或空内容）'))
    return
  }
  if (statements.length === 1) {
    await runStatement(statements[0].sql, ctx, statements[0].startLine)
    return
  }

  const ph = scanPlaceholders(text)
  if (ph.mixed) {
    message.error(t('同一句不能混用 $n 与 ? 占位符'))
    return
  }
  if (ph.count > 0) {
    message.warning(t('批量执行不支持参数占位符：请选中单条执行并填写参数。'), {
      duration: 6000,
    })
    return
  }
  const allowed = await guardStatements(
    statements.map((st) => ({ sql: st.sql, line: st.startLine })),
    ctx,
  )
  if (!allowed) return
  await runBatch(ctx.editorKey, ctx.profileId, statements, queryOptions([]))
}

async function handleExecute(req: ExecuteRequest) {
  const ctx = context()
  if (!ctx) return
  clearErrorMarker()

  // 选区优先（Ctrl+Enter / Ctrl+Shift+Enter / 下拉都一致）：
  // 选中一段就只执行这一段；选中多条则逐条执行。
  if (req.selection) {
    const lineOffset = countNewlines(sql.value.slice(0, req.selectionStart))
    await executeText(req.selection, lineOffset, ctx)
    return
  }

  switch (req.mode) {
    case 'statement': {
      const statements = await splitStatements(sql.value, 0)
      if (!statements) return
      if (statements.length === 0) {
        message.info(t('编辑器里没有可执行的 SQL 语句'))
        return
      }
      const st = statementAtCursor(statements, req.cursorLine)
      if (!st) return
      await runStatement(st.sql, ctx, st.startLine)
      return
    }
    case 'selection':
      message.info(t('没有选中可执行的 SQL'))
      return
    case 'all':
      await executeText(sql.value, 0, ctx)
      return
    case 'toEnd': {
      const text = sql.value.slice(req.cursor)
      const prefix = sql.value.slice(0, req.cursor)
      if (!text.trim()) {
        message.info(t('光标之后没有可执行的 SQL'))
        return
      }
      await executeText(text, countNewlines(prefix), ctx)
      return
    }
  }
}

async function runStatement(
  statement: string,
  ctx: { editorKey: string; profileId: string },
  line: number,
) {
  if (!statement.trim()) return
  if (!(await guardStatements([{ sql: statement, line }], ctx))) return
  const ph = scanPlaceholders(statement)
  if (ph.mixed) {
    message.error(t('同一句不能混用 $n 与 ? 占位符（服务端会拒绝）。'))
    return
  }
  if (ph.count > 0) {
    openParams(statement, ph.count, (params) => {
      void execute(statement, params, ctx)
    })
    return
  }
  await execute(statement, [], ctx)
}

async function execute(
  statement: string,
  params: ParamInput[],
  ctx: { editorKey: string; profileId: string },
) {
  const opts = queryOptions(params)
  await runSql(ctx.editorKey, ctx.profileId, statement, opts, {
    stream: streamEnabled.value,
  })
}

/** 选区状态（由编辑器回报）：决定“仅执行选区”菜单是否可用。 */
const selectionActive = ref(false)

const execOptions = computed(() => [
  {
    label: t('执行当前语句'),
    key: 'statement',
    // 有选区时 Ctrl+Enter 会优先执行选区，这里如实标注。
    disabled: false,
  },
  {
    label: t('执行选中内容'),
    key: 'selection',
    disabled: !selectionActive.value,
  },
  {
    label: t('执行全部（逐条）'),
    key: 'all',
    disabled: false,
  },
  {
    label: t('从光标执行到结尾'),
    key: 'toEnd',
    disabled: false,
  },
])

function runFromEditor(mode: ExecuteMode) {
  const ed = editorRef.value
  if (!ed) return
  if (mode === 'statement') ed.executeDefault()
  else if (mode === 'selection') ed.executeSelection()
  else if (mode === 'all') ed.executeAll()
  else ed.executeToEnd()
}

function onExecSelect(key: string) {
  runFromEditor(key as ExecuteMode)
}

function formatCurrentSql() {
  const r = editorRef.value?.formatDocument()
  if (r && !r.ok && r.error) message.error(r.error, { duration: 6000 })
}

function onFormatError(msg: string) {
  message.error(msg, { duration: 6000 })
}

function onNewTab() {
  newEditorTab()
}

// ---------------------------------------------------------------------------
// 标签管理：双击重命名、右键菜单、拖拽排序、中键关闭
// ---------------------------------------------------------------------------

const renamingKey = ref('')
const renameTitle = ref('')
const dragKey = ref('')
const tabMenu = reactive({ show: false, x: 0, y: 0, key: '' })

const tabMenuOptions = computed<DropdownOption[]>(() => {
  const idx = workspaceState.tabs.findIndex((t) => t.key === tabMenu.key)
  const right = idx >= 0 ? workspaceState.tabs.length - idx - 1 : 0
  return [
    { label: t('重命名（也可双击标题）'), key: 'rename' },
    { label: t('复制 SQL'), key: 'copy' },
    { type: 'divider', key: 'd1' },
    { label: t('关闭'), key: 'close' },
    { label: t('关闭其他标签'), key: 'close-others', disabled: workspaceState.tabs.length <= 1 },
    {
      label: right > 0 ? tt`关闭右侧标签（${right} 个）` : t('关闭右侧标签'),
      key: 'close-right',
      disabled: right <= 0,
    },
  ]
})

function openTabMenu(e: MouseEvent, key: string) {
  activateEditorTab(key)
  tabMenu.key = key
  tabMenu.x = e.clientX
  tabMenu.y = e.clientY
  tabMenu.show = true
}

function onTabMenuSelect(choice: string) {
  const tab = workspaceState.tabs.find((t) => t.key === tabMenu.key)
  tabMenu.show = false
  if (!tab) return
  if (choice === 'rename') {
    startRenaming(tab)
  } else if (choice === 'copy') {
    if (!tab.sql.trim()) {
      message.info(t('该标签没有 SQL 内容'))
      return
    }
    void copyText(tab.sql)
      .then(() => message.success(t('SQL 已复制')))
      .catch(() => message.error(t('复制失败（系统剪贴板不可用）')))
  } else if (choice === 'close') {
    closeEditorTab(tab.key)
  } else if (choice === 'close-others') {
    closeEditorTabs(
      workspaceState.tabs.filter((t) => t.key !== tab.key).map((t) => t.key),
    )
  } else if (choice === 'close-right') {
    const idx = workspaceState.tabs.findIndex((t) => t.key === tab.key)
    if (idx >= 0) {
      closeEditorTabs(workspaceState.tabs.slice(idx + 1).map((t) => t.key))
    }
  }
}

function startRenaming(tab: EditorTab) {
  renamingKey.value = tab.key
  renameTitle.value = tab.title
  void nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.etab-rename input')
    el?.focus()
    el?.select()
  })
}

function commitRename(tab: EditorTab) {
  if (renamingKey.value !== tab.key) return
  const next = renameTitle.value.trim()
  if (next && next !== tab.title) renameEditorTab(tab.key, next)
  renamingKey.value = ''
}

function cancelRename() {
  renamingKey.value = ''
}

function onTabDragStart(e: DragEvent, tab: EditorTab) {
  dragKey.value = tab.key
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', tab.key)
  }
}

function onTabDrop(targetKey: string) {
  if (dragKey.value && dragKey.value !== targetKey) {
    moveEditorTab(dragKey.value, targetKey)
  }
  dragKey.value = ''
}

function onTabAuxClick(e: MouseEvent, key: string) {
  // 中键关闭（与浏览器/编辑器标签习惯一致）。
  if (e.button !== 1) return
  e.preventDefault()
  closeEditorTab(key)
}

function closeResults() {
  const tab = activeEditor.value
  if (tab) closeResultsOf(tab.key)
}

async function addFavorite() {
  const text = sql.value.trim()
  if (!text) {
    message.warning(t('编辑器为空，没有可收藏的 SQL'))
    return
  }
  try {
    const fav = await ipc.favoriteAdd(null, text)
    message.success(tt`已收藏：${fav.name}`)
  } catch (e) {
    const info = (e as { info?: { message: string } }).info
    message.error(info?.message ?? (e instanceof Error ? e.message : String(e)), {
      duration: 6000,
    })
  }
}

async function editParamsForEditor() {
  if (placeholders.value.count === 0) {
    message.info(t('当前编辑器里没有 $n / ? 参数占位符'))
    return
  }
  if (placeholders.value.mixed) {
    message.error(t('同一句不能混用 $n 与 ? 占位符'))
    return
  }
  const ctx = context()
  if (!ctx) return
  const text = sql.value
  // 参数弹窗会执行整篇文本：危险/只读检查要覆盖其中的每一条语句。
  const statements = await splitStatements(text, 0)
  if (!statements) return
  const allowed = await guardStatements(
    statements.map((st) => ({ sql: st.sql, line: st.startLine })),
    ctx,
  )
  if (!allowed) return
  // 参数确认前可能切了标签：执行上下文与 SQL 在打开弹窗时就固定。
  openParams(text, placeholders.value.count, (params) => {
    void execute(text, params, ctx)
  })
}

function onWindowKeydown(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  const key = e.key.toLowerCase()
  if (key === 't' && !e.shiftKey) {
    e.preventDefault()
    newEditorTab()
  } else if (key === 'w' && !e.shiftKey) {
    const tab = activeEditor.value
    if (!tab) return
    e.preventDefault()
    closeEditorTab(tab.key)
  }
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  editorActions.current = {
    executeCurrent: () => runFromEditor('statement'),
    executeAll: () => runFromEditor('all'),
    executeToEnd: () => runFromEditor('toEnd'),
    format: () => formatCurrentSql(),
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  editorActions.current = null
})
</script>

<template>
  <div class="workbench-inner">
    <div class="editor-tabs">
      <div class="tabs-scroll">
        <div
          v-for="tab in workspaceState.tabs"
          :key="tab.key"
          class="etab"
          :class="{
            active: tab.key === workspaceState.activeKey,
            dragging: dragKey === tab.key,
          }"
          :style="{ '--tab-accent': tabColor(tab) ?? 'var(--accent)' }"
          :title="tabTooltip(tab)"
          :draggable="renamingKey !== tab.key"
          @click="activateEditorTab(tab.key)"
          @contextmenu.prevent="openTabMenu($event, tab.key)"
          @auxclick="onTabAuxClick($event, tab.key)"
          @dragstart="onTabDragStart($event, tab)"
          @dragover.prevent
          @drop.prevent="onTabDrop(tab.key)"
          @dragend="dragKey = ''"
        >
          <span
            class="etab-dot"
            :class="{ on: tabConnected(tab) }"
            :style="tabConnected(tab) && tabColor(tab) ? { background: tabColor(tab) } : undefined"
          />
          <NInput
            v-if="renamingKey === tab.key"
            v-model:value="renameTitle"
            size="tiny"
            class="etab-rename"
            @click.stop
            @keydown.enter.stop.prevent="commitRename(tab)"
            @keydown.esc.stop.prevent="cancelRename"
            @blur="commitRename(tab)"
          />
          <span
            v-else
            class="etab-title"
            :title="$t('双击重命名')"
            @dblclick.stop="startRenaming(tab)"
          >
            {{ tab.title }}
          </span>
          <span
            v-if="isTabDirty(tab)"
            class="etab-dirty"
            :title="$t('有未保存修改（Ctrl/⌘+S 保存）')"
          >●</span>
          <span class="etab-conn" :class="{ muted: !tabConnected(tab) }">
            {{ tabConnLabel(tab) }}
          </span>
          <button
            class="etab-close"
            :title="$t('关闭标签（Ctrl/Cmd+W；中键单击也可关闭）')"
            @click.stop="closeEditorTab(tab.key)"
          >
            ×
          </button>
        </div>
      </div>
      <button class="new-tab" :title="$t('新建标签（Ctrl/Cmd+T）')" @click="onNewTab">+</button>
      <NDropdown
        trigger="manual"
        placement="bottom-start"
        :show="tabMenu.show"
        :x="tabMenu.x"
        :y="tabMenu.y"
        :options="tabMenuOptions"
        @select="onTabMenuSelect"
        @clickoutside="tabMenu.show = false"
        @update:show="tabMenu.show = $event"
      />
    </div>

    <div class="toolbar">
      <NButton
        type="primary"
        size="small"
        class="exec-main"
        :disabled="!connected || queryState.batchRunning"
        :title="
          readOnly
            ? $t('只读连接：执行前拦截写语句（SELECT/SHOW/EXPLAIN 仍可用）')
            : $t('执行当前语句（Ctrl/Cmd+Enter）；有选区时只执行选区')
        "
        @click="runFromEditor('statement')"
      >
        <span class="play">▶</span> {{ $t("执行") }}
      </NButton>
      <NDropdown
        trigger="click"
        placement="bottom-start"
        :options="execOptions"
        @select="onExecSelect"
      >
        <NButton
          type="primary"
          secondary
          size="small"
          class="exec-more"
          :disabled="!connected || queryState.batchRunning"
          :title="$t('选择执行方式')"
        >
          ▾
        </NButton>
      </NDropdown>

      <NDropdown
        trigger="click"
        placement="bottom-start"
        :options="fileOptions"
        @select="onFileSelect"
      >
        <NButton size="small" quaternary :title="$t('打开 / 保存 / 最近文件')">{{ $t("文件") }}</NButton>
      </NDropdown>

      <span class="divider" />

      <NTooltip trigger="hover">
        <template #trigger>
          <label class="switch-label">
            <NSwitch v-model:value="streamEnabled" size="small" />
            <span>{{ $t("流式") }}</span>
          </label>
        </template>
        {{ $t("大结果走 rows 通道：Rust 侧落盘、网格按页读取，前端内存有界。") }}
      </NTooltip>

      <span
        class="db-target"
        :title="$t('查询目标库：只影响无前缀表名；显式 db.table 仍按限定名路由。\'跟随连接默认\' 不额外传 database。')"
      >
        <span class="db-target-label">{{ $t("库") }}</span>
        <NSelect
          v-model:value="databaseValue"
          size="tiny"
          class="db-target-select"
          :options="databaseOptions"
          :disabled="!connected"
        />
      </span>

      <NButton size="small" quaternary @click="editParamsForEditor">
        {{ $t("参数") }}
        <span v-if="placeholders.count > 0" class="param-count">{{ placeholders.count }}</span>
      </NButton>

      <NButton size="small" quaternary :title="$t('收藏当前编辑器 SQL')" @click="addFavorite">
        {{ $t("收藏") }}
      </NButton>

      <NButton
        size="small"
        quaternary
        :title="$t('格式化 SQL（Shift+Alt+F / Ctrl+Alt+L；有选区只格式化选区）')"
        @click="formatCurrentSql"
      >
        {{ $t("格式化") }}
      </NButton>

      <span class="divider" />

      <NButton
        size="small"
        quaternary
        :disabled="resultCount === 0 || queryState.batchRunning"
        @click="closeResults"
      >
        {{ $t("关闭全部结果") }}
      </NButton>

      <span class="spacer" />

      <span v-if="boundProfile" class="db-hint">
        <i
          v-if="activeEditor?.profileId"
          class="db-color"
          :style="{ background: colorForProfile(activeEditor.profileId) }"
        />
        <b>{{ boundProfile.name }}</b>
        <template v-if="appState.session">
          · {{ appState.session.user }} @ {{ appState.defaultDb }}
        </template>
        <span v-else-if="connected" class="chip">{{ $t("无会话身份") }}</span>
        <span v-else class="chip warn mini">{{ $t("未连接") }}</span>
        <span
          v-if="readOnly"
          class="chip warn mini"
          :title="$t('只读连接：Studio 会拦截 INSERT/UPDATE/DELETE/DDL/导入等写数据语句（服务端授权仍是最终边界）')"
        >
          {{ $t("只读") }}
        </span>
        <span v-if="streamEnabled" class="chip warn mini">{{ $t("流式已开") }}</span>
      </span>
      <span v-else class="db-hint muted">{{ $t("未绑定连接（可先写 SQL）") }}</span>
    </div>

    <div class="split-wrap">
      <NSplit
        v-model:size="layoutState.splitSize"
        direction="vertical"
        :min="0.18"
        :max="0.85"
        class="split"
      >
        <template #1>
          <div
            class="editor-pane"
            :class="{ 'table-drop-target': tableDragOver }"
          >
            <SqlEditor
              ref="editorRef"
              v-model="sql"
              :marker="marker"
              :schema="appState.tables"
              :tab-key="workspaceState.activeKey"
              :view="editorView"
              @execute="handleExecute"
              @selection-change="selectionActive = $event"
              @format-error="onFormatError"
              @view-change="onEditorViewChange"
            />
            <div v-if="tableDragOver" class="table-drop-hint">
              <strong>{{ $t("松手生成表查询") }}</strong>
              <span>
                {{ tableDragState.tableName }} {{ $t("· 新标签执行 SELECT * FROM 表 ·\n                自动分页 500 行/页") }}
              </span>
            </div>
          </div>
        </template>
        <template #2>
          <div class="result-pane">
            <ResultPanel />
          </div>
        </template>
      </NSplit>
    </div>

    <ParamsModal />
    <DangerConfirmModal />
    <GuardrailModal />
  </div>
</template>

<style scoped>
.workbench-inner {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.editor-tabs {
  flex: 0 0 38px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  background:
    linear-gradient(180deg, var(--surface-soft), transparent 72%),
    var(--surface-soft);
  border-bottom: 1px solid var(--border-subtle);
  overflow: hidden;
}

.tabs-scroll {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 3px;
  overflow-x: auto;
}

.etab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  flex: none;
  padding: 0 5px 0 9px;
  max-width: 260px;
  border: 1px solid transparent;
  border-radius: 9px;
  color: var(--text-soft);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition:
    background 0.18s ease,
    border-color 0.18s ease,
    color 0.18s ease,
    box-shadow 0.2s ease,
    transform 0.18s ease;
}

.etab:hover {
  background: var(--hover);
  border-color: var(--border-subtle);
  color: var(--text);
  transform: translateY(-1px);
}

.etab.active {
  color: var(--text);
  font-weight: 650;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--tab-accent, var(--accent)) 18%, var(--panel-strong)),
    var(--panel-strong) 84%
  );
  border-color: color-mix(
    in srgb,
    var(--tab-accent, var(--accent)) 34%,
    var(--border)
  );
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.16) inset,
    0 9px 20px -16px var(--tab-accent, var(--accent));
}

.etab.active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 2px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--tab-accent, var(--accent)),
    transparent
  );
  opacity: 0.95;
  box-shadow: 0 0 8px color-mix(
    in srgb,
    var(--tab-accent, var(--accent)) 55%,
    transparent
  );
}

.etab.active:hover {
  transform: none;
}

.etab.dragging {
  opacity: 0.45;
}

.etab-rename {
  width: 110px;
}

.etab-rename :deep(input) {
  font-size: 11.5px;
  height: 20px;
  padding: 0 4px;
}

.etab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 6px;
  background: var(--muted);
}

.etab-dot.on {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-soft);
}

.etab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}

.etab-conn {
  font-size: 9.5px;
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-radius: 7px;
  padding: 1px 5px;
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.etab-conn.muted {
  color: var(--muted);
  background: var(--border-subtle);
}

.etab-dirty {
  font-size: 8px;
  line-height: 1;
  color: var(--warn);
  flex: 0 0 auto;
}

.etab-close {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  border-radius: 3px;
}

.etab-close:hover {
  background: var(--hover);
  color: var(--text);
}

.new-tab {
  align-self: center;
  flex: 0 0 24px;
  height: 24px;
  border: 1px dashed var(--border);
  border-radius: 7px;
  background: transparent;
  color: var(--text-soft);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.new-tab:hover {
  border-color: var(--accent-border);
  color: var(--accent);
  background: var(--accent-soft);
}

.toolbar {
  flex: 0 0 42px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  background: transparent;
  border-bottom: 1px solid var(--border-subtle);
}

.play {
  font-size: 9px;
  margin-right: 3px;
  position: relative;
  top: -0.5px;
}

.exec-main {
  margin-right: -8px;
}

.exec-more {
  min-width: 26px;
  padding: 0 5px;
  font-size: 11px;
}

.divider {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 3px;
}

.switch-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-soft);
  cursor: pointer;
  user-select: none;
}

.db-target {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
}

.db-target-label {
  font-size: 10.5px;
  color: var(--muted);
}

.db-target-select {
  width: 176px;
}

.param-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  margin-left: 5px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 10px;
  font-weight: 700;
}

.spacer {
  flex: 1;
}

.db-hint {
  font-size: 11.5px;
  color: var(--text-soft);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.db-hint b {
  font-weight: 600;
  color: var(--text);
}

.db-color {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
}

.db-hint.muted {
  color: var(--muted);
}

.chip.mini {
  height: 18px;
  font-size: 10px;
  padding: 0 6px;
}

@media (max-width: 1320px) {
  .db-target-label {
    display: none;
  }

  .db-target-select {
    width: 140px;
  }
}

.split-wrap {
  flex: 1;
  min-height: 0;
  padding: 8px;
}

.split {
  height: 100%;
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  overflow: hidden;
  background: transparent;
}

/* 用绝对定位把面板钉在 NSplit 的 pane 上：pane 高度由 split 决定，
   内容绝不参与撑高（否则大网格会把整列撑到内容高度）。 */
:deep(.n-split-pane-1),
:deep(.n-split-pane-2) {
  position: relative;
  min-height: 0;
}

.editor-pane,
.result-pane {
  position: absolute;
  inset: 0;
  min-height: 0;
}

.table-drop-target {
  outline: 2px dashed var(--accent);
  outline-offset: -3px;
  border-radius: 10px;
}

.table-drop-hint {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 20;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 14px 22px;
  border-radius: 12px;
  background: var(--panel-strong);
  border: 1px solid var(--accent-border);
  box-shadow: var(--shadow-card);
  color: var(--text-soft);
  font-size: 11.5px;
  white-space: nowrap;
}

.table-drop-hint strong {
  color: var(--text);
  font-size: 13px;
}

.result-pane {
  background: transparent;
}
</style>
