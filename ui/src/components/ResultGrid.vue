<script setup lang="ts">
import { useVirtualizer } from '@tanstack/vue-virtual'
import { save } from '@tauri-apps/plugin-dialog'
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NDropdown,
  NInput,
  useMessage,
  type DropdownOption,
} from 'naive-ui'
import { computed, reactive, ref, watch, watchEffect } from 'vue'
import * as ipc from '../ipc'
import type { StreamPage, WireColumn, WireValue } from '../ipc/types'
import { uiPrefs } from '../stores/uiPrefs'
import { copyText } from '../utils/clipboard'
import { formatCount } from '../utils/format'
import {
  clampColumnWidth,
  columnTypeLabel,
  compareValues,
  rowMatches,
  rowToInsert,
  rowToJson,
  rowToTsv,
  rowsToInsert,
  rowsToJson,
  toCsvText,
  toTsv,
  valueText,
} from '../utils/result'
import CellValue from './CellValue.vue'

import { t, tt } from '../i18n'

const props = defineProps<{
  columns: WireColumn[]
  mode: 'bulk' | 'stream'
  rows?: WireValue[][]
  streamId?: string
  totalRows?: number
  done?: boolean
  preview?: { start: number; rows: WireValue[][] } | null
  fetchPage?: (offset: number, limit: number) => Promise<StreamPage>
}>()

const message = useMessage()

const PAGE_SIZE = 500
/** 页缓存上限（内存有界：32 页 = 1.6 万行；滚动回来再取）。 */
const MAX_CACHED_PAGES = 32
/** 同时在途的分页请求上限（防 IPC 风暴）。 */
const MAX_CONCURRENT_PAGES = 4
/** 单个渲染批次最多渲染的行数（防虚拟化器在异常视口下渲染全表）。 */
const MAX_RENDERED_ROWS = 400

const scrollEl = ref<HTMLDivElement | null>(null)
const scrollLeft = ref(0)
/** 行高/字号来自外观设置的“字体与密度”，网格实时响应。 */
const rowHeight = computed(() => uiPrefs.gridRowHeight)
/** 表头随字号轻微增高，避免大字号时列名/类型两行被裁切。 */
const headerHeight = computed(() =>
  Math.max(40, Math.round(uiPrefs.gridFontSize * 1.55 + 20)),
)

// ---------------------------------------------------------------------------
// 过滤 / 排序 / 隐藏列（仅在 bulk 结果上做完整客户端处理）
// ---------------------------------------------------------------------------

const filterText = ref('')
const sort = ref<{ col: number; dir: 1 | -1 } | null>(null)
const hiddenCols = reactive(new Set<number>())
/** 用户拖动后的列宽（按列下标）；没有条目时使用内容采样宽度。 */
const manualWidths = reactive(new Map<number, number>())

const visibleCols = computed(() =>
  props.columns
    .map((column, index) => ({ column, index }))
    .filter((v) => !hiddenCols.has(v.index)),
)

/** 当前视图里的源行下标（过滤 + 排序后）。 */
const bulkOrder = computed<number[]>(() => {
  if (props.mode !== 'bulk') return []
  const rows = props.rows ?? []
  let order = rows.map((_, i) => i)
  const q = filterText.value.trim()
  if (q) order = order.filter((i) => rowMatches(rows[i], q, props.columns.length))
  const s = sort.value
  if (s && props.columns[s.col]) {
    order = [...order].sort((a, b) =>
      compareValues(rows[a]?.[s.col] ?? null, rows[b]?.[s.col] ?? null, s.dir),
    )
  }
  return order
})

const count = computed(() =>
  props.mode === 'bulk' ? bulkOrder.value.length : (props.totalRows ?? 0),
)

const sourceRowAt = computed(() => {
  if (props.mode !== 'bulk') return undefined
  const order = bulkOrder.value
  const rows = props.rows ?? []
  return (displayIndex: number): WireValue[] | undefined => {
    const src = order[displayIndex]
    return src === undefined ? undefined : rows[src]
  }
})

watch(
  () => props.columns,
  () => {
    sort.value = null
    hiddenCols.clear()
    manualWidths.clear()
    clearSelection()
  },
)
watch(filterText, () => {
  clearSelection()
  scrollEl.value?.scrollTo({ top: 0 })
})
watch(sort, () => {
  clearSelection()
  scrollEl.value?.scrollTo({ top: 0 })
})

const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>(
  computed(() => ({
    count: count.value,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => rowHeight.value,
    overscan: 16,
  })),
)

// 行高变化后重新测量虚拟行（滚动位置由浏览器按像素保持）。
watch(rowHeight, () => virtualizer.value.measure())

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

const pages = reactive(new Map<number, WireValue[][]>())
const pageErrors = reactive(new Map<number, string>())
const loadingPages = new Set<number>()
const pageOrder: number[] = []

watch(
  () => props.streamId,
  () => {
    pages.clear()
    pageErrors.clear()
    loadingPages.clear()
    pageOrder.length = 0
  },
)

function streamRowAt(index: number): WireValue[] | undefined {
  const p = props.preview
  if (p && index >= p.start && index < p.start + p.rows.length) {
    return p.rows[index - p.start]
  }
  const page = Math.floor(index / PAGE_SIZE)
  return pages.get(page)?.[index % PAGE_SIZE]
}

/** 显示行（经过过滤/排序）→ 真实值。 */
function rowAt(displayIndex: number): WireValue[] | undefined {
  if (props.mode === 'bulk') return sourceRowAt.value?.(displayIndex)
  return streamRowAt(displayIndex)
}

function ensurePage(page: number) {
  if (props.mode !== 'stream' || !props.streamId || !props.fetchPage) return
  if (page < 0) return
  if (page * PAGE_SIZE >= count.value) return
  if (pages.has(page) || loadingPages.has(page)) return
  if (loadingPages.size >= MAX_CONCURRENT_PAGES) return
  const sid = props.streamId
  loadingPages.add(page)
  props
    .fetchPage(page * PAGE_SIZE, PAGE_SIZE)
    .then((res) => {
      if (props.streamId !== sid) return
      pages.set(page, res.rows)
      pageErrors.delete(page)
      pageOrder.push(page)
      while (pageOrder.length > MAX_CACHED_PAGES) {
        const old = pageOrder.shift()
        if (old !== undefined && old !== page) pages.delete(old)
      }
    })
    .catch((e: unknown) => {
      if (props.streamId !== sid) return
      pageErrors.set(page, e instanceof Error ? e.message : String(e))
    })
    .finally(() => {
      loadingPages.delete(page)
    })
}

watchEffect(() => {
  const items = virtualRows.value
  if (props.mode !== 'stream' || items.length === 0) return
  const first = items[0].index
  const last = items[items.length - 1].index
  const from = Math.floor(first / PAGE_SIZE)
  const to = Math.min(Math.floor(last / PAGE_SIZE), from + 4)
  for (let p = from; p <= to; p++) ensurePage(p)
  // 预取相邻页，滚动时不至于空白
  ensurePage(from - 1)
  ensurePage(to + 1)
})

const pageErrorList = computed(() => [...pageErrors.entries()])

function retryPages() {
  pageErrors.clear()
  loadingPages.clear()
  const items = virtualRows.value
  if (items.length === 0) return
  const from = Math.floor(items[0].index / PAGE_SIZE)
  const to = Math.floor(items[items.length - 1].index / PAGE_SIZE)
  for (let p = from; p <= to; p++) ensurePage(p)
}

function onScroll() {
  const el = scrollEl.value
  if (!el) return
  if (Math.abs(el.scrollLeft - scrollLeft.value) > 0.5) scrollLeft.value = el.scrollLeft
}

const sampleRows = computed(() => {
  const out: WireValue[][] = []
  const n = Math.min(count.value, 200)
  for (let i = 0; i < n; i++) {
    const r = rowAt(i)
    if (r) out.push(r)
  }
  return out
})

const widths = computed(() =>
  props.columns.map((c, ci) => {
    const manual = manualWidths.get(ci)
    if (manual !== undefined) return manual
    let max = Math.max(c.name.length + 2, 6)
    const sample = sampleRows.value
    const n = Math.min(sample.length, 200)
    for (let i = 0; i < n; i++) {
      const v = sample[i][ci]
      if (v !== null && v !== undefined && v !== '') max = Math.max(max, String(v).length)
    }
    const byName = c.name.length * 8 + 30
    const byData = Math.min(max, 48) * 7.4 + 26
    return Math.round(Math.max(90, Math.min(440, Math.max(byName, byData))))
  }),
)

/** 拖动表头右缘调整列宽；双击恢复自动宽度。 */
function startColumnResize(e: PointerEvent, colIndex: number) {
  if (e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  const startX = e.clientX
  const startWidth = widths.value[colIndex] ?? 120
  const move = (ev: PointerEvent) => {
    manualWidths.set(colIndex, clampColumnWidth(startWidth + ev.clientX - startX))
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function resetColumnWidth(colIndex: number) {
  manualWidths.delete(colIndex)
}

const rowNumWidth = computed(() =>
  Math.max(56, Math.min(96, String(Math.max(count.value, 1)).length * 8 + 22)),
)

const dataWidth = computed(() =>
  visibleCols.value.reduce((a, v) => a + widths.value[v.index], 0),
)
const totalWidth = computed(() => rowNumWidth.value + dataWidth.value)

const visibleRows = computed(() =>
  virtualRows.value
    .slice(0, MAX_RENDERED_ROWS)
    .map((v) => ({
      key: String(v.key),
      index: v.index,
      start: v.start,
      size: v.size,
      row: rowAt(v.index),
      sourceIndex: props.mode === 'bulk' ? bulkOrder.value[v.index] : v.index,
    })),
)

function cellClass(c: WireColumn): string {
  if (c.tag === 'bool') return 'center'
  if (['i8', 'i16', 'i32', 'i64', 'f32', 'f64', 'decimal128'].includes(c.tag)) return 'num'
  return ''
}

// ---------------------------------------------------------------------------
// 选区 / 键盘
// ---------------------------------------------------------------------------

interface CellRef {
  row: number
  col: number
}

const anchor = ref<CellRef | null>(null)
const focusCell = ref<CellRef | null>(null)

function setSelection(row: number, col: number, extend = false) {
  if (!extend || !anchor.value) anchor.value = { row, col }
  focusCell.value = { row, col }
}

function clearSelection() {
  anchor.value = null
  focusCell.value = null
}

const selectionRect = computed(() => {
  const a = anchor.value
  const f = focusCell.value
  if (!a || !f) return null
  return {
    row1: Math.min(a.row, f.row),
    row2: Math.max(a.row, f.row),
    col1: Math.min(a.col, f.col),
    col2: Math.max(a.col, f.col),
  }
})

function isSelected(row: number, col: number): boolean {
  const r = selectionRect.value
  return Boolean(r && row >= r.row1 && row <= r.row2 && col >= r.col1 && col <= r.col2)
}

function isFocus(row: number, col: number): boolean {
  return focusCell.value?.row === row && focusCell.value?.col === col
}

function onCellClick(row: number, col: number, e: MouseEvent) {
  setSelection(row, col, e.shiftKey)
  scrollEl.value?.focus({ preventScroll: true })
}

function onRowClick(row: number) {
  const last = props.columns.length - 1
  anchor.value = { row, col: 0 }
  focusCell.value = { row, col: Math.max(0, last) }
  scrollEl.value?.focus({ preventScroll: true })
}

function ensureRowVisible(row: number) {
  const el = scrollEl.value
  if (!el) return
  const h = rowHeight.value
  const top = row * h
  const viewTop = el.scrollTop
  // grid-scroll 本身位于表头下方，clientHeight 已不含表头。
  const viewHeight = el.clientHeight
  if (top < viewTop) el.scrollTop = top
  else if (top + h > viewTop + viewHeight) {
    el.scrollTop = top + h - viewHeight
  }
}

function moveFocus(dRow: number, dCol: number, extend: boolean) {
  if (count.value === 0 || visibleCols.value.length === 0) return
  if (!focusCell.value) {
    setSelection(0, visibleCols.value[0].index)
    return
  }
  const row = Math.max(0, Math.min(count.value - 1, focusCell.value.row + dRow))
  const pos = visibleCols.value.findIndex((v) => v.index === focusCell.value?.col)
  const nextPos = Math.max(
    0,
    Math.min(visibleCols.value.length - 1, (pos < 0 ? 0 : pos) + dCol),
  )
  setSelection(row, visibleCols.value[nextPos].index, extend)
  ensureRowVisible(row)
}

function onGridKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    if (focusCell.value) {
      e.preventDefault()
      void copySelection()
    }
    return
  }
  if (e.key === 'Escape') {
    clearSelection()
    return
  }
  if (e.key === 'Enter' && focusCell.value) {
    e.preventDefault()
    openDetail(focusCell.value.row)
    return
  }
  const moves: Record<string, [number, number]> = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
  }
  const m = moves[e.key]
  if (!m || e.altKey || e.ctrlKey || e.metaKey) return
  e.preventDefault()
  moveFocus(m[0], m[1], e.shiftKey)
}

// ---------------------------------------------------------------------------
// 复制 / 行详情
// ---------------------------------------------------------------------------

const detail = ref<{ index: number; sourceIndex: number; row: WireValue[] } | null>(null)
const detailShow = computed({
  get: () => detail.value !== null,
  set: (v: boolean) => {
    if (!v) detail.value = null
  },
})

function openDetail(displayIndex: number) {
  const row = rowAt(displayIndex)
  if (!row) {
    message.info(t('该行尚未从流式结果加载，滚动到该行后再试'))
    return
  }
  const sourceIndex =
    props.mode === 'bulk' ? (bulkOrder.value[displayIndex] ?? displayIndex) : displayIndex
  detail.value = { index: displayIndex, sourceIndex, row: [...row] }
}

async function copyAndToast(text: string, label: string): Promise<void> {
  const ok = await copyText(text)
  if (ok) message.success(tt`${label}已复制`, { duration: 1500 })
  else message.error(t('复制失败（系统剪贴板不可用）'))
}

async function copySelection() {
  const r = selectionRect.value
  if (!r) return
  const cols = visibleCols.value.filter((v) => v.index >= r.col1 && v.index <= r.col2)
  if (cols.length === 0) return
  const lines: string[] = []
  let missing = 0
  const subsetCols = cols.map((v) => v.column)
  for (let row = r.row1; row <= r.row2; row++) {
    const values = rowAt(row)
    if (!values) {
      missing++
      continue
    }
    lines.push(toTsv(subsetCols, [cols.map((v) => values[v.index] ?? null)], false))
  }
  if (missing > 0) {
    message.warning(tt`有 ${missing} 行尚未加载，已跳过；可滚动到对应区域后再复制`)
  }
  if (lines.length === 0) return
  const label =
    r.row1 === r.row2 && r.col1 === r.col2
      ? t('单元格')
      : tt`${lines.length} 行 × ${cols.length} 列`
  await copyAndToast(lines.join('\r\n'), label)
}

function rowValues(displayIndex: number): WireValue[] | null {
  const row = rowAt(displayIndex)
  if (!row) {
    message.info(t('该行尚未从流式结果加载'))
    return null
  }
  return row
}

function columnValues(col: number): { rows: WireValue[][]; missing: number } {
  let missing = 0
  const rows: WireValue[][] = []
  for (let i = 0; i < count.value; i++) {
    const r = rowAt(i)
    if (!r) {
      missing++
      continue
    }
    rows.push([r[col] ?? null])
  }
  return { rows, missing }
}

async function copyColumn(col: number, asCsv: boolean) {
  const { rows, missing } = columnValues(col)
  if (missing > 0) {
    message.warning(tt`仅复制已加载的 ${formatCount(rows.length)} 行（${missing} 行未加载）`)
  }
  const c = props.columns[col]
  if (!c) return
  const text = asCsv ? toCsvText([c], rows, true) : toTsv([c], rows, true)
  await copyAndToast(text, tt`列 ${c.name}（${formatCount(rows.length)} 行）`)
}

async function copyRow(displayIndex: number, kind: 'tsv' | 'json' | 'insert') {
  const row = rowValues(displayIndex)
  if (!row) return
  const text =
    kind === 'tsv'
      ? rowToTsv(row)
      : kind === 'json'
        ? rowToJson(props.columns, row)
        : rowToInsert(props.columns, row)
  await copyAndToast(text, t('整行'))
}

async function copyCell(rowIndex: number, col: number) {
  const row = rowValues(rowIndex)
  if (!row) return
  const v = row[col] ?? null
  if (v === null) message.info(t('该单元格是 NULL（已复制空串）'))
  await copyAndToast(valueText(v), t('单元格'))
}

function currentViewRows(): WireValue[][] {
  const out: WireValue[][] = []
  for (let i = 0; i < count.value; i++) {
    const r = rowAt(i)
    if (r) out.push(r)
  }
  return out
}

async function copyAll(kind: string) {
  if (props.mode !== 'bulk') return
  const rows = currentViewRows()
  const cols = visibleCols.value.map((v) => v.column)
  let text = ''
  if (kind === 'all-tsv') text = toTsv(cols, rows, true)
  else if (kind === 'all-csv') text = toCsvText(cols, rows, true)
  else if (kind === 'all-json') text = rowsToJson(cols, rows)
  else text = rowsToInsert(cols, rows)
  await copyAndToast(text, tt`当前视图（${formatCount(rows.length)} 行）`)
}

async function exportView() {
  if (props.mode !== 'bulk') return
  const rows = currentViewRows()
  const cols = visibleCols.value.map((v) => v.column)
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const name = `qsdb-result-view-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours(),
  )}${p(d.getMinutes())}${p(d.getSeconds())}.csv`
  const path = await save({
    title: t('导出当前视图 CSV'),
    defaultPath: name,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  })
  if (!path) return
  try {
    await ipc.saveTextFile(path, toCsvText(cols, rows, true), true)
    message.success(tt`已导出当前视图 ${formatCount(rows.length)} 行`)
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e), { duration: 6000 })
  }
}

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------

interface MenuTarget {
  kind: 'cell' | 'header' | 'row'
  row: number
  col: number
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
  if (target.kind === 'cell') setSelection(target.row, target.col)
  if (target.kind === 'row') onRowClick(target.row)
}

const menuOptions = computed<DropdownOption[]>(() => {
  const target = menu.target
  if (!target) return []
  const stream = props.mode === 'stream'
  const sortable = !stream && target.col >= 0
  if (target.kind === 'header') {
    return [
      { label: t('复制列名'), key: 'copy-col-name' },
      { label: t('复制整列（TSV，含表头）'), key: 'copy-col-tsv' },
      { label: t('复制整列（CSV，含表头）'), key: 'copy-col-csv' },
      { type: 'divider', key: 'd1' },
      { label: t('按此列升序'), key: 'sort-asc', disabled: !sortable },
      { label: t('按此列降序'), key: 'sort-desc', disabled: !sortable },
      { label: t('隐藏此列'), key: 'hide-col', disabled: visibleCols.value.length <= 1 },
      { label: t('显示全部列'), key: 'show-cols', disabled: hiddenCols.size === 0 },
    ]
  }
  const items: DropdownOption[] = [{ label: t('查看行详情'), key: 'detail' }]
  if (target.kind === 'cell') items.push({ label: t('复制单元格'), key: 'copy-cell' })
  items.push(
    { label: t('复制整行（TSV，Excel）'), key: 'copy-row-tsv' },
    { label: t('复制整行（JSON）'), key: 'copy-row-json' },
    { label: t('复制整行（INSERT）'), key: 'copy-row-insert' },
  )
  if (target.col >= 0) {
    items.push(
      { label: t('复制整列（TSV，含表头）'), key: 'copy-col-tsv' },
      { label: t('复制整列（CSV，含表头）'), key: 'copy-col-csv' },
    )
  }
  items.push({ type: 'divider', key: 'd1' })
  if (target.col >= 0) {
    items.push(
      { label: t('按此列升序'), key: 'sort-asc', disabled: !sortable },
      { label: t('按此列降序'), key: 'sort-desc', disabled: !sortable },
      { label: t('隐藏此列'), key: 'hide-col', disabled: visibleCols.value.length <= 1 },
      { label: t('显示全部列'), key: 'show-cols', disabled: hiddenCols.size === 0 },
    )
  }
  return items
})

function onMenuSelect(key: string) {
  const target = menu.target
  menu.show = false
  if (!target) return
  switch (key) {
    case 'detail':
      openDetail(target.row)
      break
    case 'copy-cell':
      void copyCell(target.row, target.col)
      break
    case 'copy-row-tsv':
      void copyRow(target.row, 'tsv')
      break
    case 'copy-row-json':
      void copyRow(target.row, 'json')
      break
    case 'copy-row-insert':
      void copyRow(target.row, 'insert')
      break
    case 'copy-col-tsv':
      void copyColumn(target.col, false)
      break
    case 'copy-col-csv':
      void copyColumn(target.col, true)
      break
    case 'copy-col-name':
      void copyAndToast(props.columns[target.col]?.name ?? '', t('列名'))
      break
    case 'sort-asc':
      sort.value = { col: target.col, dir: 1 }
      break
    case 'sort-desc':
      sort.value = { col: target.col, dir: -1 }
      break
    case 'hide-col':
      hiddenCols.add(target.col)
      clearSelection()
      break
    case 'show-cols':
      hiddenCols.clear()
      break
  }
}

function onHeaderClick(col: number) {
  if (props.mode !== 'bulk') return
  if (sort.value?.col !== col) sort.value = { col, dir: 1 }
  else if (sort.value.dir === 1) sort.value = { col, dir: -1 }
  else sort.value = null
}

const copyAllOptions: DropdownOption[] = [
  { label: t('当前视图全部（TSV，含表头）'), key: 'all-tsv' },
  { label: t('当前视图全部（CSV，含表头）'), key: 'all-csv' },
  { label: t('当前视图全部（JSON）'), key: 'all-json' },
  { label: t('当前视图全部（INSERT）'), key: 'all-insert' },
]

const filterActive = computed(() => props.mode === 'bulk' && filterText.value.trim() !== '')
const viewModified = computed(() => filterActive.value || sort.value !== null || hiddenCols.size > 0)
</script>

<template>
  <div class="grid">
    <div class="grid-toolbar">
      <NInput
        v-model:value="filterText"
        size="tiny"
        clearable
        :disabled="mode === 'stream'"
        class="filter-input"
        :placeholder="$t('本页快速过滤（所有列，包含匹配）')"
      />
      <span v-if="filterActive" class="tool-stat">
        {{ $t("匹配") }} <b>{{ formatCount(count) }}</b> / {{ formatCount(rows?.length ?? 0) }} {{ $t("行") }}
      </span>
      <span v-if="sort" class="tool-stat sort-chip">
        {{ $t("排序：") }}{{ columns[sort.col]?.name }} {{ sort.dir === 1 ? '↑' : '↓' }}
        <button :title="$t('清除排序')" @click="sort = null">×</button>
      </span>
      <span v-if="hiddenCols.size > 0" class="tool-stat">
        {{ $t("已隐藏") }} {{ hiddenCols.size }} {{ $t("列") }}
        <button class="link" @click="hiddenCols.clear()">{{ $t("恢复") }}</button>
      </span>
      <span v-if="mode === 'stream'" class="tool-hint">
        {{ $t("流式结果不做部分过滤；请用 WHERE / ORDER BY 重跑以保证完整") }}
      </span>
      <span class="spacer" />
      <NButton
        v-if="mode === 'bulk'"
        size="tiny"
        quaternary
        :disabled="viewModified && count === 0"
        :title="$t('导出当前过滤/排序/隐藏列后的视图')"
        @click="exportView"
      >
        {{ $t("导出当前视图") }}
      </NButton>
      <NDropdown
        trigger="click"
        placement="bottom-end"
        :options="copyAllOptions"
        :disabled="mode !== 'bulk'"
        @select="copyAll"
      >
        <NButton size="tiny" quaternary :disabled="mode !== 'bulk'">{{ $t("复制视图") }}</NButton>
      </NDropdown>
    </div>

    <div
      class="header-outer"
      :style="{ height: headerHeight + 'px', flexBasis: headerHeight + 'px' }"
    >
      <div class="hcorner" :style="{ width: rowNumWidth + 'px' }">#</div>
      <div class="header-viewport">
        <div
          class="header-track"
          :style="{ width: dataWidth + 'px', transform: `translateX(-${scrollLeft}px)` }"
        >
          <div
            v-for="v in visibleCols"
            :key="v.column.name + '-' + v.index"
            class="hcell"
            :style="{ width: widths[v.index] + 'px' }"
            :class="{ sorted: sort?.col === v.index }"
            :title="`${v.column.name} · ${columnTypeLabel(v.column)}${$t('（点击排序，右键更多）')}`"
            @click="onHeaderClick(v.index)"
            @contextmenu="openMenu($event, { kind: 'header', row: 0, col: v.index })"
          >
            <span class="hname">
              {{ v.column.name }}
              <span v-if="sort?.col === v.index" class="sort-arrow">
                {{ sort.dir === 1 ? '↑' : '↓' }}
              </span>
            </span>
            <span class="htype">{{ columnTypeLabel(v.column) }}</span>
            <span
              class="hresize"
              :title="$t('拖动调整列宽；双击恢复自动宽度')"
              @pointerdown="startColumnResize($event, v.index)"
              @click.stop
              @dblclick.stop.prevent="resetColumnWidth(v.index)"
            ></span>
          </div>
        </div>
      </div>
    </div>

    <div
      ref="scrollEl"
      class="grid-scroll"
      tabindex="0"
      @scroll="onScroll"
      @keydown="onGridKeydown"
    >
      <div class="grid-inner" :style="{ width: totalWidth + 'px' }">
        <div class="grid-body" :style="{ height: totalSize + 'px' }">
          <div
            v-for="v in visibleRows"
            :key="v.key"
            class="grid-row"
            :class="{ odd: v.index % 2 === 1 }"
            :style="{ transform: `translateY(${v.start}px)`, height: v.size + 'px' }"
          >
            <div
              class="row-num"
              :style="{ width: rowNumWidth + 'px' }"
              :title="mode === 'bulk' && v.sourceIndex !== v.index ? tt`原第 ${v.sourceIndex + 1} 行` : ''"
              @click="onRowClick(v.index)"
              @contextmenu="openMenu($event, { kind: 'row', row: v.index, col: -1 })"
            >
              {{ v.index + 1 }}
            </div>
            <div
              v-for="vc in visibleCols"
              :key="vc.index"
              class="cell"
              :class="[
                cellClass(vc.column),
                {
                  sel: isSelected(v.index, vc.index),
                  focus: isFocus(v.index, vc.index),
                },
              ]"
              :style="{ width: widths[vc.index] + 'px' }"
              @click="onCellClick(v.index, vc.index, $event)"
              @dblclick="openDetail(v.index)"
              @contextmenu="openMenu($event, { kind: 'cell', row: v.index, col: vc.index })"
            >
              <CellValue :column="vc.column" :value="v.row ? v.row[vc.index] : undefined" />
            </div>
            <div class="fill" />
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="count === 0"
      class="grid-empty"
      :style="{ top: headerHeight + 32 + 'px' }"
    >
      {{ filterActive ? $t('没有匹配的行') : `0 ${$t('行')}` }}
    </div>

    <div v-if="pageErrorList.length > 0" class="page-error">
      <span class="pe-text">
        {{ $t("分页读取失败（") }}{{ pageErrorList.length }} {{ $t("页）：") }}{{ pageErrorList[0]?.[1] }}
      </span>
      <button class="pe-retry" @click="retryPages">{{ $t("重试") }}</button>
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

    <NDrawer v-model:show="detailShow" :width="560" placement="right">
      <NDrawerContent v-if="detail" :title="$t('行详情')" closable>
        <div class="detail-sub mono">
          {{ $t("第") }} {{ detail.index + 1 }} {{ $t("行") }}
          <template v-if="detail.sourceIndex !== detail.index">
            {{ $t("· 原第") }} {{ detail.sourceIndex + 1 }} {{ $t("行") }}
          </template>
          · {{ columns.length }} {{ $t("列") }}
        </div>
        <div class="detail-list">
          <div v-for="(c, i) in columns" :key="i" class="detail-row">
            <div class="detail-head">
              <span class="detail-name">{{ c.name }}</span>
              <span class="detail-type mono">{{ columnTypeLabel(c) }}</span>
              <span v-if="detail.row[i] === null" class="detail-null">NULL</span>
              <span class="spacer" />
              <NButton size="tiny" quaternary @click="copyAndToast(valueText(detail.row[i]), $t('值'))">
                {{ $t("复制") }}
              </NButton>
            </div>
            <pre
              class="detail-value"
              :class="{ null: detail.row[i] === null }"
            >{{ detail.row[i] === null ? 'NULL' : valueText(detail.row[i]) }}</pre>
          </div>
        </div>
        <div class="detail-actions">
          <NButton size="small" @click="copyRow(detail.index, 'tsv')">{{ $t("复制整行 TSV") }}</NButton>
          <NButton size="small" @click="copyRow(detail.index, 'json')">{{ $t("复制整行 JSON") }}</NButton>
          <NButton size="small" @click="copyRow(detail.index, 'insert')">{{ $t("复制 INSERT") }}</NButton>
        </div>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped>
.grid {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  background: var(--grid-bg);
}

.grid-toolbar {
  flex: 0 0 32px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-soft);
  overflow: hidden;
}

.filter-input {
  width: 250px;
  flex: 0 0 auto;
}

.tool-stat {
  font-size: 10.5px;
  color: var(--muted);
  white-space: nowrap;
}

.tool-stat b {
  font-family: var(--mono);
  color: var(--text);
}

.tool-stat .link,
.sort-chip button {
  border: none;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font-size: 11px;
  padding: 0 2px;
}

.tool-hint {
  font-size: 10.5px;
  color: var(--warn);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.spacer {
  flex: 1;
}

.header-outer {
  flex: 0 0 40px;
  height: 40px;
  display: flex;
  background: var(--grid-header);
  border-bottom: 1px solid var(--border-strong);
  overflow: hidden;
  z-index: 3;
}

.hcorner {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--muted);
  border-right: 1px solid var(--border);
  background: var(--grid-header);
}

.header-viewport {
  flex: 1;
  overflow: hidden;
}

.header-track {
  display: flex;
  height: 100%;
  will-change: transform;
}

.hcell {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  padding: 0 9px;
  border-right: 1px solid var(--border-subtle);
  overflow: hidden;
  cursor: pointer;
  user-select: none;
}

.hresize {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 7px;
  cursor: col-resize;
  z-index: 2;
}

.hresize:hover,
.hresize:active {
  background: linear-gradient(
    to right,
    transparent 2px,
    var(--accent-border) 2px,
    var(--accent-border) 4px,
    transparent 4px
  );
}

.hcell:hover {
  background: var(--hover);
}

.hcell.sorted {
  background: var(--accent-soft);
}

.sort-arrow {
  color: var(--accent);
  font-weight: 700;
}

.hname {
  font-size: calc(var(--grid-font-size, 12.5px) - 1px);
  font-weight: 650;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.htype {
  font-family: var(--mono);
  font-size: calc(var(--grid-font-size, 12.5px) - 3px);
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.grid-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  outline: none;
}

.grid-inner {
  min-width: 100%;
  position: relative;
}

.grid-body {
  position: relative;
}

.grid-row {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--row-line);
  background: transparent;
  will-change: transform;
}

.grid-row.odd {
  background: var(--grid-stripe);
}

.grid-row:hover {
  background: var(--grid-hover);
}

.row-num {
  flex: 0 0 auto;
  position: sticky;
  left: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 9px;
  font-family: var(--mono);
  font-size: calc(var(--grid-font-size, 12.5px) - 2px);
  color: var(--muted);
  background: var(--panel-strong);
  border-right: 1px solid var(--border);
  user-select: none;
  cursor: default;
}

.cell {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  padding: 0 9px;
  overflow: hidden;
  font-size: var(--grid-font-size, 12.5px);
  color: var(--text);
  border-right: 1px solid var(--row-line);
}

.cell.num {
  justify-content: flex-end;
  text-align: right;
}

.cell.center {
  justify-content: center;
}

.cell.sel {
  background: var(--accent-soft);
}

.cell.focus {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}

.fill {
  flex: 1;
}

.grid-empty {
  position: absolute;
  inset: 72px 0 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 12px;
  pointer-events: none;
}

.page-error {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 7px;
  background: var(--danger-soft);
  border: 1px solid var(--danger-border);
  color: var(--danger);
  font-size: 11.5px;
  box-shadow: 0 4px 16px rgb(16 24 40 / 10%);
}

.pe-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pe-retry {
  border: 1px solid var(--danger-border);
  background: var(--surface-raised);
  color: var(--danger);
  border-radius: 5px;
  height: 22px;
  padding: 0 9px;
  font-size: 11px;
  cursor: pointer;
}

.detail-sub {
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 10px;
}

.detail-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.detail-row {
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--surface-soft);
  padding: 6px 8px;
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
}

.detail-name {
  font-size: 12px;
  font-weight: 650;
  color: var(--text);
}

.detail-type {
  font-size: 9.5px;
  color: var(--muted);
}

.detail-null {
  font-family: var(--mono);
  font-size: 9.5px;
  font-style: italic;
  color: var(--warn);
  border: 1px solid var(--warn-border);
  border-radius: 4px;
  padding: 0 4px;
}

.detail-value {
  margin: 4px 0 0;
  padding: 6px 8px;
  border-radius: 5px;
  background: var(--grid-bg);
  border: 1px solid var(--border-subtle);
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow: auto;
}

.detail-value.null {
  color: var(--muted);
  font-style: italic;
}

.detail-actions {
  display: flex;
  gap: 8px;
  padding: 12px 0 4px;
}
</style>
