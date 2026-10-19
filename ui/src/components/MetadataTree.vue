<script setup lang="ts">
import {
  NButton,
  NDropdown,
  NInput,
  useDialog,
  useMessage,
  type DropdownOption,
} from 'naive-ui'
import { computed, h, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import * as ipc from '../ipc'
import type { WirePartition, WireTable } from '../ipc/types'
import { appState, refreshMeta, toStudioError, useDatabase } from '../stores/app'
import { openImport } from '../stores/import'
import { openPartitions } from '../stores/partition'
import { colorForProfile } from '../stores/connectionColors'
import { resetTableDrag, tableDragState } from '../stores/tableDrag'
import { openTableCount, openTablePreview, openTableQuery } from '../stores/tablePreview'
import { uiState } from '../stores/ui'
import { bindActiveProfile } from '../stores/workspace'
import { copyText } from '../utils/clipboard'
import { errorHint } from '../utils/errors'
import { formatBytes, formatCount } from '../utils/format'

import { t, tt } from '../i18n'

interface TableNode {
  key: string
  table: WireTable
  shortName: string
}

interface DbNode {
  name: string
  readOnly: boolean
  tables: TableNode[]
}

const message = useMessage()
const dialog = useDialog()
// 库/表/列分开筛选：只填“表”时不会被列名命中淹没。
const dbFilter = ref('')
const tableFilter = ref('')
const columnFilter = ref('')
const expandedDbs = reactive(new Set<string>())
const expandedTables = reactive(new Set<string>())

const defaultDb = computed(() => appState.session?.defaultDb ?? appState.defaultDb ?? 'default')

/** 当前标签的连接是否标记为只读（导入会写数据，入口直接禁用）。 */
const connReadOnly = computed(
  () => appState.profiles.find((p) => p.id === appState.activeProfileId)?.readOnly ?? false,
)

/** 同时打开的连接：侧栏顶部常驻切换条（多连接管理的入口）。 */
const openConnections = computed(() =>
  appState.profiles
    .filter((p) => Boolean(appState.connections[p.id]))
    .map((p) => ({
      id: p.id,
      name: p.name,
      color: colorForProfile(p.id),
      session: appState.connections[p.id]?.session ?? null,
    })),
)

function switchConnection(id: string) {
  if (appState.activeProfileId !== id) bindActiveProfile(id)
}

function connTitle(c: {
  name: string
  session: { user: string; defaultDb: string } | null
}): string {
  return c.session
    ? tt`切换到「${c.name}」（当前标签） · ${c.session.user} @ ${c.session.defaultDb}`
    : tt`切换到「${c.name}」（当前标签）`
}

const grouped = computed<DbNode[]>(() => {
  const map = new Map<string, DbNode>()
  for (const d of appState.databases) {
    map.set(d.name, { name: d.name, readOnly: d.readOnly, tables: [] })
  }
  const fallback = defaultDb.value
  const known = new Set(appState.databases.map((d) => d.name))
  for (const t of appState.tables) {
    const dot = t.name.indexOf('.')
    // 只有前缀确实是已挂载库名时才当 `db.table` 拆（单挂载表名可能含点）。
    const prefixed = dot > 0 && known.has(t.name.slice(0, dot))
    const db = prefixed ? t.name.slice(0, dot) : fallback
    const shortName = prefixed ? t.name.slice(dot + 1) : t.name
    let node = map.get(db)
    if (!node) {
      node = { name: db, readOnly: false, tables: [] }
      map.set(db, node)
    }
    node.tables.push({ key: `${db}::${t.name}`, table: t, shortName })
  }
  return [...map.values()]
    .map((d) => ({ ...d, tables: d.tables.sort((a, b) => a.shortName.localeCompare(b.shortName)) }))
    .sort((a, b) => a.name.localeCompare(b.name))
})

const dbNeedle = computed(() => dbFilter.value.trim().toLowerCase())
const tableNeedle = computed(() => tableFilter.value.trim().toLowerCase())
const columnNeedle = computed(() => columnFilter.value.trim().toLowerCase())
const anyFilter = computed(
  () => Boolean(dbNeedle.value) || Boolean(tableNeedle.value) || Boolean(columnNeedle.value),
)

function tableMatches(t: TableNode): boolean {
  if (!tableNeedle.value) return true
  return (
    t.shortName.toLowerCase().includes(tableNeedle.value) ||
    t.table.name.toLowerCase().includes(tableNeedle.value)
  )
}

function tableHasColumnMatch(t: TableNode): boolean {
  if (!columnNeedle.value) return true
  return t.table.columns.some((c) => c.name.toLowerCase().includes(columnNeedle.value))
}

const visible = computed<DbNode[]>(() => {
  if (!anyFilter.value) return grouped.value
  const out: DbNode[] = []
  for (const db of grouped.value) {
    if (dbNeedle.value && !db.name.toLowerCase().includes(dbNeedle.value)) continue
    const tables = db.tables.filter((t) => tableMatches(t) && tableHasColumnMatch(t))
    // 只填库筛选时，即使库没有表也保留它（显示“无表”）；
    // 有表/列筛选时，只保留确实命中的库。
    if (tables.length > 0 || (!tableNeedle.value && !columnNeedle.value)) {
      out.push({ ...db, tables })
    }
  }
  return out
})

const visibleTableCount = computed(() =>
  visible.value.reduce((n, db) => n + db.tables.length, 0),
)
const totalTables = computed(() => appState.tables.length)

const countLabel = computed(() =>
  anyFilter.value
    ? tt`${visible.value.length} 库 · ${visibleTableCount.value} 表`
    : tt`${appState.databases.length} 库 · ${totalTables.value} 表`,
)

/** 列筛选只显示命中的列；未填列筛选时展示全部列。 */
function columnsFor(t: TableNode) {
  if (!columnNeedle.value) return t.table.columns
  return t.table.columns.filter((c) => c.name.toLowerCase().includes(columnNeedle.value))
}

// 筛选时：库自动展开；只有“列筛选”才会自动展开命中的表。
// 单纯筛选表时不自动展开表，避免一屏全是列。
watch(
  [dbNeedle, tableNeedle, columnNeedle, () => appState.tables.length],
  ([dbN, tableN, colN]) => {
    if (!dbN && !tableN && !colN) return
    for (const db of visible.value) {
      expandedDbs.add(db.name)
      if (!colN) continue
      for (const t of db.tables) {
        if (tableHasColumnMatch(t)) expandedTables.add(t.key)
      }
    }
  },
)

watch(
  () => appState.tables.length,
  () => {
    // 初次加载：展开默认库（其余保持收起，避免大实例一屏铺满）。
    const db = grouped.value.find((d) => d.name === defaultDb.value)
    if (db) expandedDbs.add(db.name)
  },
  { immediate: true },
)

// 多标签切换连接：元数据缓存各自独立，展开当前连接的默认库。
watch(
  () => appState.activeProfileId,
  () => {
    const db = grouped.value.find((d) => d.name === defaultDb.value)
    if (db) expandedDbs.add(db.name)
  },
)

function toggleDb(name: string) {
  if (expandedDbs.has(name)) expandedDbs.delete(name)
  else expandedDbs.add(name)
}

function toggleTable(key: string) {
  if (expandedTables.has(key)) expandedTables.delete(key)
  else expandedTables.add(key)
}

function hasPartitions(table: WireTable): boolean {
  return table.columns.some((c) => c.partition)
}

function onPartitions(table: WireTable) {
  void openPartitions(table)
}

function onImport(table: WireTable) {
  if (connReadOnly.value) {
    message.warning(
      t('当前连接标记为只读：CSV 导入会写入数据，已阻止。请在连接设置里取消只读。'),
    )
    return
  }
  openImport(table)
}

async function onRefresh() {
  try {
    await refreshMeta()
    message.success(t('元数据已刷新'))
  } catch (e) {
    const info = (e as { info?: Parameters<typeof errorHint>[0] }).info
    message.error(info ? errorHint(info) : e instanceof Error ? e.message : String(e))
  }
}

/**
 * 双击表：新建编辑器标签并执行（自动分页，默认 500 行/页）。
 * 连接未打开时只填 SQL。
 */
function previewTable(tableNode: TableNode) {
  const outcome = openTablePreview(tableNode.table)
  if (!outcome) return
  if (!outcome.executed) {
    message.warning(
      t('已打开查询 SQL；当前标签的连接尚未打开，连接后按 Ctrl/Cmd+Enter 执行。'),
      { duration: 6000 },
    )
  }
}

// ---------------------------------------------------------------------------
// 左键拖表到查询窗口（pointer 实现，避开 Tauri 对原生 HTML5 DnD 的接管）
// ---------------------------------------------------------------------------

interface PendingTableDrag {
  table: WireTable
  name: string
  startX: number
  startY: number
  moved: boolean
}

let pendingDrag: PendingTableDrag | null = null
let dragGhost: HTMLDivElement | null = null
let suppressRowClick = false
let suppressTimer: number | undefined

function onTablePointerDown(e: PointerEvent, t: TableNode) {
  if (e.button !== 0) return
  // 行内的“分区/导入”按钮不应触发整行拖拽。
  if ((e.target as HTMLElement | null)?.closest('button, input')) return
  pendingDrag = {
    table: t.table,
    name: t.table.name,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
  }
}

function moveGhost(x: number, y: number) {
  if (!dragGhost) return
  dragGhost.style.left = `${x + 12}px`
  dragGhost.style.top = `${y + 12}px`
}

function onWindowPointerMove(e: PointerEvent) {
  const drag = pendingDrag
  if (!drag) return
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return
    drag.moved = true
    // 拖拽结束后浏览器可能仍派发 click；抑制一次，避免误折叠/展开表。
    suppressRowClick = true
    window.clearTimeout(suppressTimer)
    suppressTimer = window.setTimeout(() => {
      suppressRowClick = false
    }, 300)
    tableDragState.active = true
    tableDragState.tableName = drag.name
    tableDragState.overEditor = false
    dragGhost = document.createElement('div')
    dragGhost.className = 'table-drag-ghost'
    dragGhost.textContent = `SELECT * FROM ${drag.name}`
    document.body.appendChild(dragGhost)
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
    window.getSelection()?.removeAllRanges()
  }
  moveGhost(e.clientX, e.clientY)
  const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
  tableDragState.overEditor = Boolean(target?.closest('.editor-pane'))
}

function cleanupTableDrag() {
  window.clearTimeout(suppressTimer)
  dragGhost?.remove()
  dragGhost = null
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  resetTableDrag()
  pendingDrag = null
}

function onWindowPointerUp() {
  const drag = pendingDrag
  if (!drag) return
  const shouldQuery = drag.moved && tableDragState.overEditor
  const table = drag.table
  const name = drag.name
  cleanupTableDrag()
  if (!shouldQuery) return
  const outcome = openTableQuery(name, table, t('查询'))
  if (outcome && !outcome.executed) {
    message.warning(
      t('已生成表查询 SQL；当前标签的连接尚未打开，连接后按 Ctrl/Cmd+Enter 执行。'),
      { duration: 6000 },
    )
  }
}

function onWindowPointerCancel() {
  cleanupTableDrag()
}

function onDragEscape(e: KeyboardEvent) {
  if (e.key === 'Escape' && pendingDrag) cleanupTableDrag()
}

function onTableRowClick(key: string) {
  if (suppressRowClick) {
    suppressRowClick = false
    return
  }
  toggleTable(key)
}

onMounted(() => {
  window.addEventListener('pointermove', onWindowPointerMove, true)
  window.addEventListener('pointerup', onWindowPointerUp, true)
  window.addEventListener('pointercancel', onWindowPointerCancel, true)
  window.addEventListener('keydown', onDragEscape, true)
  window.addEventListener('blur', cleanupTableDrag)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onWindowPointerMove, true)
  window.removeEventListener('pointerup', onWindowPointerUp, true)
  window.removeEventListener('pointercancel', onWindowPointerCancel, true)
  window.removeEventListener('keydown', onDragEscape, true)
  window.removeEventListener('blur', cleanupTableDrag)
  cleanupTableDrag()
})

async function copyName(text: string, label: string) {
  const ok = await copyText(text)
  if (ok) message.success(tt`${label}已复制`, { duration: 1500 })
  else message.error(t('复制失败（系统剪贴板不可用）'))
}

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------

interface MenuTarget {
  kind: 'db' | 'table'
  db: DbNode
  table?: TableNode
}

const menu = reactive({
  show: false,
  x: 0,
  y: 0,
  target: null as MenuTarget | null,
})

function openMenu(e: MouseEvent, target: MenuTarget) {
  e.preventDefault()
  e.stopPropagation()
  menu.target = target
  menu.x = e.clientX
  menu.y = e.clientY
  menu.show = true
}

const menuOptions = computed<DropdownOption[]>(() => {
  const target = menu.target
  if (!target) return []
  if (target.kind === 'db') {
    return [
      {
        label: t('设为会话默认库'),
        key: 'use-db',
        disabled: !appState.session,
      },
      { label: t('复制库名'), key: 'copy-db' },
      { type: 'divider', key: 'd1' },
      { label: t('刷新元数据'), key: 'refresh' },
    ]
  }
  const table = target.table
  if (!table) return []
  return [
    { label: t('查询表（自动分页，500 行/页）'), key: 'preview' },
    { label: t('查询表行数（count(*)）'), key: 'count' },
    { label: t('查看表大小（分区字节）'), key: 'size' },
    { label: t('复制表名'), key: 'copy-name' },
    { label: t('复制限定名'), key: 'copy-qualified' },
    { type: 'divider', key: 'd1' },
    {
      label: t('查看分区 / INSERT OVERWRITE 模板'),
      key: 'partitions',
      disabled: !hasPartitions(table.table),
    },
    {
      label: connReadOnly.value ? t('导入 CSV（只读连接已禁用）') : t('导入 CSV'),
      key: 'import',
      disabled: target.db.readOnly || connReadOnly.value,
    },
    { type: 'divider', key: 'd2' },
    { label: t('刷新元数据'), key: 'refresh' },
  ]
})

/** 单表大小：/partitions detail.bytes 求和（压缩后段文件体积）。 */
function tableSizeContent(parts: WirePartition[]) {
  const totalBytes = parts.reduce((sum, p) => sum + p.bytes, 0)
  const totalRows = parts.reduce((sum, p) => sum + p.rows, 0)
  const top = [...parts].sort((a, b) => b.bytes - a.bytes).slice(0, 10)
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    [
      h(
        'div',
        { style: { fontSize: '12px', color: 'var(--text-soft)', lineHeight: '1.7' } },
        [
          h(
            'b',
            { style: { fontSize: '18px', color: 'var(--text)' } },
            formatBytes(totalBytes),
          ),
          tt` · ${formatCount(totalRows)} 行 · ${parts.length} 个分区`,
        ],
      ),
      h(
        'div',
        {
          style: {
            border: '1px solid var(--border)',
            borderRadius: '8px',
            overflow: 'hidden',
          },
        },
        top.map((p, i) =>
          h(
            'div',
            {
              style: {
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto auto',
                gap: '12px',
                alignItems: 'center',
                padding: '6px 9px',
                fontSize: '11px',
                borderTop: i > 0 ? '1px solid var(--border-subtle)' : 'none',
              },
            },
            [
              h(
                'span',
                {
                  title: p.name,
                  style: {
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'var(--text-soft)',
                    fontFamily: 'var(--mono)',
                  },
                },
                p.name || t('（根）'),
              ),
              h(
                'span',
                {
                  title: tt`${formatCount(p.bytes)} 字节`,
                  style: { color: 'var(--text)', fontFamily: 'var(--mono)' },
                },
                formatBytes(p.bytes),
              ),
              h(
                'span',
                { style: { color: 'var(--muted)', fontFamily: 'var(--mono)' } },
                tt`${formatCount(p.rows)} 行`,
              ),
            ],
          ),
        ),
      ),
      h(
        'div',
        { style: { fontSize: '10.5px', color: 'var(--muted)', lineHeight: '1.6' } },
        tt`来源：GET /tables/{t}/partitions 的 detail.bytes（段文件压缩后的落盘体积，不含 manifest/索引/回收站）。${
          top.length < parts.length ? tt`仅列出最大的 ${top.length} 个分区。` : ''
        }`,
      ),
    ],
  )
}

async function showTableSize(table: WireTable) {
  const pid = appState.connection?.profileId
  if (!pid) {
    message.warning(t('请先连接 QSDB 实例，再查看表大小'))
    return
  }
  try {
    const parts = await ipc.metaPartitions(pid, table.name)
    if (parts.length === 0) {
      dialog.info({
        title: tt`表大小 · ${table.name}`,
        content: t(
          '服务端 /partitions 没有返回分区明细。无分区表的表级 bytes 目前不单独暴露，无法计算大小（不伪造 0 B）。',
        ),
        positiveText: t('知道了'),
      })
      return
    }
    const bytesKnown =
      parts.some((p) => p.bytes > 0) || parts.every((p) => p.rows === 0)
    if (!bytesKnown) {
      dialog.info({
        title: tt`表大小 · ${table.name}`,
        content: t(
          '服务端 /partitions 未返回分区 bytes（旧内核，早于十九批Ⅶ），无法计算表大小。不把未知显示成 0 B；升级服务端后再试。',
        ),
        positiveText: t('知道了'),
      })
      return
    }
    dialog.info({
      title: tt`表大小 · ${table.name}`,
      content: () => tableSizeContent(parts),
      positiveText: t('知道了'),
    })
  } catch (e) {
    const err = toStudioError(e)
    message.error(
      `${err.code ?? err.kind}: ${err.message}\n${errorHint(err)}`,
      { duration: 7000 },
    )
  }
}

async function onMenuSelect(key: string) {
  const target = menu.target
  menu.show = false
  if (!target) return
  switch (key) {
    case 'preview':
      if (target.table) previewTable(target.table)
      break
    case 'count':
      if (target.table) {
        const outcome = openTableCount(target.table.table)
        if (outcome && !outcome.executed) {
          message.warning(
            t('已生成 count(*) SQL；当前标签的连接尚未打开，连接后按 Ctrl/Cmd+Enter 执行。'),
            { duration: 6000 },
          )
        }
      }
      break
    case 'size':
      if (target.table) await showTableSize(target.table.table)
      break
    case 'copy-db':
      await copyName(target.db.name, t('库名'))
      break
    case 'copy-name':
      if (target.table) await copyName(target.table.shortName, t('表名'))
      break
    case 'copy-qualified':
      if (target.table) {
        await copyName(`${target.db.name}.${target.table.shortName}`, t('限定名'))
      }
      break
    case 'partitions':
      if (target.table) await openPartitions(target.table.table)
      break
    case 'import':
      if (target.table) openImport(target.table.table)
      break
    case 'use-db':
      await onUseDb(target.db.name)
      break
    case 'refresh':
      await onRefresh()
      break
  }
}

// ---------------------------------------------------------------------------
// 键盘导航（方向键 + 回车）
// ---------------------------------------------------------------------------

function onRowKeydown(
  e: KeyboardEvent,
  kind: 'db' | 'table',
  db: DbNode,
  table?: TableNode,
) {
  // 行内按钮的 Enter 不触发树节点动作。
  if ((e.target as HTMLElement).closest('button')) return
  const row = e.currentTarget as HTMLElement
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const root = row.closest('.meta-body')
    if (!root) return
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-nav]'))
    const i = nodes.indexOf(row)
    const next = nodes[i + (e.key === 'ArrowDown' ? 1 : -1)]
    next?.focus()
    return
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault()
    if (kind === 'db' && !expandedDbs.has(db.name)) toggleDb(db.name)
    else if (kind === 'table' && table && !expandedTables.has(table.key)) {
      toggleTable(table.key)
    }
    return
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    if (kind === 'db' && expandedDbs.has(db.name)) toggleDb(db.name)
    else if (kind === 'table' && table && expandedTables.has(table.key)) {
      toggleTable(table.key)
    }
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    if (kind === 'db') toggleDb(db.name)
    else if (table) previewTable(table)
  }
}

async function onUseDb(db: string) {
  if (!appState.session) {
    message.warning(
      t('设置默认库需要 Basic 登录会话；匿名/静态 Token 连接请用 db.table 限定名查询。'),
      { duration: 6000 },
    )
    return
  }
  try {
    await useDatabase(db)
    message.success(tt`会话默认库已切换为 ${db}`)
  } catch (e) {
    const info = (e as { info?: Parameters<typeof errorHint>[0] }).info
    message.error(info ? errorHint(info) : e instanceof Error ? e.message : String(e))
  }
}
</script>

<template>
  <div class="meta-panel">
    <div class="meta-head">
      <div class="title-row">
        <span class="title">{{ $t("元数据") }}</span>
        <span v-if="appState.connection" class="count">
          {{ countLabel }}
        </span>
        <span class="spacer" />
        <NButton
          size="tiny"
          quaternary
          :loading="appState.metaLoading"
          :disabled="!appState.connection"
          :title="$t('刷新库/表/列（一次 withSchema，不走 N+1）')"
          @click="onRefresh"
        >
          {{ $t("刷新") }}
        </NButton>
      </div>
      <div class="filter-row">
        <NInput
          v-model:value="dbFilter"
          size="tiny"
          clearable
          :placeholder="$t('库名')"
          :title="$t('按库名筛选')"
          :disabled="!appState.connection"
        />
        <NInput
          v-model:value="tableFilter"
          size="tiny"
          clearable
          :placeholder="$t('表名')"
          :title="$t('按表名筛选（不会顺带命中列名）')"
          :disabled="!appState.connection"
        />
        <NInput
          v-model:value="columnFilter"
          size="tiny"
          clearable
          :placeholder="$t('列名')"
          :title="$t('按列名筛选（只显示命中的列和所属表）')"
          :disabled="!appState.connection"
        />
      </div>
      <div v-if="openConnections.length > 0" class="conn-strip">
        <button
          v-for="c in openConnections"
          :key="c.id"
          class="conn-pill"
          :class="{ active: appState.activeProfileId === c.id }"
          :title="connTitle(c)"
          @click="switchConnection(c.id)"
        >
          <i class="conn-color" :style="{ background: c.color }" />
          <span class="conn-pill-name">{{ c.name }}</span>
        </button>
        <button class="conn-pill manage" :title="$t('打开连接管理')" @click="uiState.connectionOpen = true">
          {{ $t("管理") }}
        </button>
      </div>
    </div>

    <div class="meta-body">
      <div v-if="!appState.connection" class="empty-state">
        <strong>{{ $t("尚未连接") }}</strong>
        <div class="sub">{{ $t("连接 QSDB 实例后，这里会显示库 → 表 → 列（含分区列与只读标记）。") }}</div>
      </div>

      <div v-else-if="appState.metaLoading && grouped.length === 0" class="empty-state">
        <strong>{{ $t("正在读取元数据…") }}</strong>
        <div class="sub">{{ $t("一次 withSchema 拿全列集，不逐表发请求。") }}</div>
      </div>

      <div v-else-if="visible.length === 0" class="empty-state">
        <strong>{{ anyFilter ? $t('没有匹配的对象') : $t('没有可见的表') }}</strong>
        <div class="sub">
          {{
            anyFilter
              ? $t('调整库 / 表 / 列中对应的筛选词试试；三个筛选可组合使用。')
              : $t('当前账号可能没有库授权（grants），或实例里还没有表。')
          }}
        </div>
      </div>

      <div v-else class="tree">
        <div v-for="db in visible" :key="db.name" class="db-block">
          <div
            class="row db-row"
            tabindex="0"
            data-nav
            @click="toggleDb(db.name)"
            @keydown="onRowKeydown($event, 'db', db)"
            @contextmenu="openMenu($event, { kind: 'db', db })"
          >
            <span class="chev" :class="{ open: expandedDbs.has(db.name) }">▸</span>
            <svg class="ic db-ic" viewBox="0 0 16 16" aria-hidden="true">
              <ellipse cx="8" cy="4" rx="5" ry="2" />
              <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" fill="none" />
              <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" fill="none" />
            </svg>
            <span class="label db-name">{{ db.name }}</span>
            <svg
              v-if="db.readOnly"
              class="ic lock"
              viewBox="0 0 16 16"
              aria-hidden="true"
              :title="$t('只读挂载（写 → READ_ONLY）')"
            >
              <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
              <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" />
            </svg>
            <span v-if="db.name === defaultDb" class="chip ok mini">{{ $t("默认") }}</span>
            <span class="spacer" />
            <button
              class="row-action"
              :disabled="!appState.session"
              :title="
                appState.session
                  ? $t('设为会话默认库（PUT /sessions/current/database）')
                  : $t('需要 Basic 登录会话')
              "
              @click.stop="onUseDb(db.name)"
            >
              {{ $t("使用") }}
            </button>
          </div>

          <div v-if="expandedDbs.has(db.name)" class="tables">
            <div v-if="db.tables.length === 0" class="table-empty">{{ $t("（无表）") }}</div>
            <!-- eslint-disable-next-line vue/no-template-shadow -->
            <div v-for="t in db.tables" :key="t.key" class="table-block">
              <div
                class="row table-row"
                tabindex="0"
                data-nav
                :title="
                  $t('双击：查询表（自动分页）；左键拖到查询窗口：生成 SELECT 并执行；右键：更多操作')
                "
                @pointerdown="onTablePointerDown($event, t)"
                @click="onTableRowClick(t.key)"
                @dblclick.stop="previewTable(t)"
                @keydown="onRowKeydown($event, 'table', db, t)"
                @contextmenu="openMenu($event, { kind: 'table', db, table: t })"
              >
                <span class="chev" :class="{ open: expandedTables.has(t.key) }">▸</span>
                <svg class="ic table-ic" viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="2.5" y="3" width="11" height="10" rx="1.2" fill="none" />
                  <path d="M2.5 6.5h11M6.5 6.5V13" fill="none" />
                </svg>
                <span class="label table-name" :title="t.table.name">{{ t.shortName }}</span>
                <button
                  v-if="hasPartitions(t.table)"
                  class="row-action"
                  :title="$t('查看分区（generation / rows / segments）与 INSERT OVERWRITE 模板')"
                  @click.stop="onPartitions(t.table)"
                >
                  {{ $t("分区") }}
                </button>
                <button
                  class="row-action"
                  :disabled="db.readOnly || connReadOnly"
                  :title="
                    connReadOnly
                      ? $t('当前连接标记为只读，不能导入数据')
                      : db.readOnly
                        ? $t('只读库不能写入')
                        : $t('导入 CSV（bulk append）')
                  "
                  @click.stop="onImport(t.table)"
                >
                  {{ $t("导入") }}
                </button>
                <span class="mini-count">{{ t.table.columns.length }} {{ $t("列") }}</span>
              </div>

              <div v-if="expandedTables.has(t.key)" class="columns">
                <div v-for="c in columnsFor(t)" :key="c.name" class="row col-row">
                  <span class="col-dot" />
                  <span class="label col-name" :title="c.name">{{ c.name }}</span>
                  <span class="col-type mono" :title="c.typeName">{{ c.typeName }}</span>
                  <span v-if="c.partition" class="chip mini part" :title="$t('分区列')">{{ $t("分区") }}</span>
                  <span v-if="c.nullable" class="chip mini">NULL</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <NDropdown
      trigger="manual"
      :show="menu.show"
      :x="menu.x"
      :y="menu.y"
      :options="menuOptions"
      @select="onMenuSelect"
      @clickoutside="menu.show = false"
    />

    <div class="meta-foot">
      <span v-if="appState.session" class="foot-text">
        {{ $t("会话：") }}{{ appState.session.user }} {{ $t("· 默认库") }} {{ appState.session.defaultDb }}
      </span>
      <span v-else-if="appState.connection" class="foot-text">
        {{ $t("无会话身份（匿名 / 静态 Token）；只读库标锁") }}
      </span>
      <span v-else class="foot-text">QSDB Studio · M3</span>
    </div>
  </div>
</template>

<style scoped>
.meta-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.meta-head {
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title {
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--text-soft);
  text-transform: uppercase;
}

.count {
  font-size: 11px;
  color: var(--muted);
}

.filter-row {
  display: flex;
  gap: 4px;
  min-width: 0;
}

.filter-row :deep(.n-input) {
  flex: 1;
  min-width: 0;
}

.spacer {
  flex: 1;
}

.conn-strip {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  padding-bottom: 1px;
}

.conn-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  max-width: 150px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--surface-raised);
  color: var(--text-soft);
  font-size: 10.5px;
  cursor: pointer;
  white-space: nowrap;
}

.conn-pill:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.conn-pill.active {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 650;
}

.conn-pill.manage {
  color: var(--accent);
  border-style: dashed;
}

.conn-color {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
}

.conn-pill-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 6px 12px;
}

.tree {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.db-block {
  border-radius: 6px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 6px;
  border-radius: 5px;
  cursor: default;
  user-select: none;
}

.row:hover {
  background: var(--hover);
}

.row:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
  background: var(--accent-soft);
}

.db-row {
  font-weight: 600;
  color: var(--text);
}

/* 表行可拖到查询窗口：给出可抓取的指针反馈。 */
.table-row {
  cursor: grab;
}

.table-row:active {
  cursor: grabbing;
}

.chev {
  width: 10px;
  display: inline-block;
  text-align: center;
  color: var(--muted);
  font-size: 10px;
  transition: transform 0.12s ease;
  transform: rotate(0deg);
}

.chev.open {
  transform: rotate(90deg);
}

.ic {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
}

.db-ic {
  fill: var(--accent-border);
  stroke: var(--text-soft);
  stroke-width: 1.1;
}

.table-ic {
  fill: none;
  stroke: var(--text-soft);
  stroke-width: 1.1;
}

.lock {
  fill: var(--warn);
  stroke: var(--warn);
  stroke-width: 1;
}

.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-name {
  font-size: 13px;
}

.table-name {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-soft);
}

.mini-count {
  font-size: 10.5px;
  color: var(--muted);
  margin-left: auto;
}

.tables {
  margin-left: 14px;
  border-left: 1px dashed var(--border);
  padding-left: 6px;
}

.table-block {
  margin: 1px 0;
}

.columns {
  margin-left: 18px;
  border-left: 1px dashed var(--border);
  padding-left: 6px;
}

.col-row {
  height: 23px;
  gap: 7px;
  font-size: 12px;
}

.col-dot {
  width: 5px;
  height: 5px;
  border-radius: 1px;
  background: var(--muted);
  flex: 0 0 5px;
}

.col-name {
  max-width: 120px;
  font-family: var(--mono);
  color: var(--text-soft);
}

.col-type {
  margin-left: auto;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--muted);
}

.chip.mini {
  height: 17px;
  padding: 0 5px;
  font-size: 10px;
  border-radius: 8px;
}

.chip.part {
  background: var(--warn-soft);
  border-color: var(--warn-border);
  color: var(--warn);
}

.row-action {
  border: 1px solid var(--border);
  background: var(--surface-raised);
  color: var(--text-soft);
  font-size: 10.5px;
  height: 20px;
  padding: 0 7px;
  border-radius: 10px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s;
}

.row:hover .row-action {
  opacity: 1;
}

.row-action:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.table-empty {
  padding: 4px 8px;
  font-size: 11px;
  color: var(--muted);
}

.meta-foot {
  flex: 0 0 30px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  padding: 0 12px;
  background: var(--surface-soft);
}

.foot-text {
  font-size: 10.5px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
