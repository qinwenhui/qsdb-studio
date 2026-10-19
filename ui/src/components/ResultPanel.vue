<script setup lang="ts">
import { NButton, NInput, NSelect, NTooltip, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import * as ipc from '../ipc'
import type { StreamPage } from '../ipc/types'
import { loginAgain } from '../stores/app'
import { colorForProfile } from '../stores/connectionColors'
import {
  activeResultOf,
  applyTabFilters,
  closeResultsOf,
  closeTab,
  countTotalRows,
  goToPage,
  openGuardrailForTab,
  queryState,
  resultsOf,
  retryTab,
  stopTab,
  type ResultTab,
} from '../stores/query'
import { uiState } from '../stores/ui'
import { workspaceState } from '../stores/workspace'
import { errorHint } from '../utils/errors'
import {
  FILTER_OP_LABEL,
  filterLabel,
  filterOperators,
  filterValueHint,
  isFilterableColumn,
  opNeedsValue,
  type ColumnFilter,
  type FilterOp,
} from '../utils/filters'
import { formatBigCount, formatCount, formatMs, shortText } from '../utils/format'
import { canCountTotal } from '../utils/pagination'
import ErrorNotice from './ErrorNotice.vue'
import ExportModal from './ExportModal.vue'
import ResultGrid from './ResultGrid.vue'

import { t, tt } from '../i18n'

const message = useMessage()
const exportShow = ref(false)
const exportTab = ref<ResultTab | null>(null)

/** 结果页按编辑器标签隔离：切标签只看到它自己的结果。 */
const tabs = computed(() => resultsOf(workspaceState.activeKey))
const active = computed(() => activeResultOf(workspaceState.activeKey))

function activateTab(key: string) {
  if (!workspaceState.activeKey) return
  queryState.activeKeys[workspaceState.activeKey] = key
}

function closeActiveResults() {
  closeResultsOf(workspaceState.activeKey)
}

function statusLabel(tab: ResultTab | null): string {
  if (!tab) return ''
  if (tab.status === 'streaming') return tab.stream?.stopping ? t('停止中') : t('接收中')
  if (tab.status === 'running') return tab.cancelRequested ? t('取消中') : t('执行中')
  if (tab.status === 'error') {
    const err = tab.error ?? tab.stream?.error
    return err?.code === 'QUERY_CANCELLED' ? t('已取消') : t('失败')
  }
  return t('完成')
}

/** bulk 被取消：没有部分数据，必须明确“不是完整结果”。 */
function bulkCancelled(tab: ResultTab | null): boolean {
  return Boolean(tab && !tab.stream && tab.status === 'error' && tab.error?.code === 'QUERY_CANCELLED')
}

/** 警告列表里是否含“自动重登”（兼容翻译前后的文案）。 */
function hasReloginWarning(warnings: string[]): boolean {
  const key = '会话已失效并自动重登（服务端签发了新会话）'
  return warnings.some((w) => w === key || w === t(key))
}

function rowCountOf(tab: ResultTab | null): number | null {
  if (!tab) return null
  if (tab.stream) return tab.stream.totalRows
  if (tab.result?.kind === 'rows') return tab.result.rowCount
  return null
}

function elapsedOf(tab: ResultTab | null): number | null {
  if (!tab) return null
  if (tab.stream) return tab.stream.elapsedMs
  return tab.result?.elapsedMs ?? null
}

/** 服务端执行耗时；旧内核没有统一耗时头 / 流式尚未开始时为 null。 */
function serverElapsedOf(tab: ResultTab | null): number | null {
  if (!tab) return null
  if (tab.stream) return tab.stream.serverElapsedMs
  return tab.result?.serverElapsedMs ?? null
}

/** 总往返 - 服务端执行 = 序列化/网络/客户端解码（流式含落盘）。 */
function transferElapsedOf(tab: ResultTab | null): number | null {
  const total = elapsedOf(tab)
  const server = serverElapsedOf(tab)
  if (total === null || server === null) return null
  return Math.max(0, total - server)
}

function timingTitle(tab: ResultTab | null): string {
  const total = elapsedOf(tab)
  const server = serverElapsedOf(tab)
  const transfer = transferElapsedOf(tab)
  if (server !== null && transfer !== null && total !== null) {
    return tt`服务端执行 ${formatMs(server)}；传输/序列化/客户端解码 ${formatMs(transfer)}；总往返 ${formatMs(total)}`
  }
  if (server !== null && total === null) {
    return tt`服务端执行 ${formatMs(server)}；结果仍在传输/落盘`
  }
  if (total !== null) {
    return tt`总往返 ${formatMs(total)}；服务端未提供独立执行耗时（旧内核或流式未完成）`
  }
  return ''
}

function canExport(tab: ResultTab | null): boolean {
  if (!tab) return false
  if (tab.stream) return tab.stream.done
  return tab.result?.kind === 'rows'
}

function fetchPageFor(tab: ResultTab) {
  return (offset: number, limit: number): Promise<StreamPage> => {
    const id = tab.stream?.streamId
    if (!id) return Promise.reject(new Error(t('流已释放')))
    return ipc.sqlStreamPage(id, offset, limit)
  }
}

function openExport(tab: ResultTab | null) {
  if (!tab) return
  exportTab.value = tab
  exportShow.value = true
}

// 命令面板「导出当前结果」：面板只管请求，导出仍走同一个 ExportModal。
watch(
  () => uiState.exportNonce,
  () => {
    if (active.value) openExport(active.value)
  },
)

async function copyQueryId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
    message.success(t('queryId 已复制'))
  } catch {
    message.error(t('复制失败（系统剪贴板不可用）'))
  }
}

async function onRetry(tab: ResultTab | null) {
  if (!tab) return
  await retryTab(tab.key)
}

async function onRelogin() {
  try {
    await loginAgain()
    message.success(t('已重新登录会话'))
  } catch (e) {
    const info = (e as { info?: Parameters<typeof errorHint>[0] }).info
    message.error(info ? errorHint(info) : e instanceof Error ? e.message : String(e), {
      duration: 6000,
    })
  }
}

async function onStop(tab: ResultTab | null) {
  if (!tab) return
  try {
    await stopTab(tab.key)
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
}

function streamIsCancelled(tab: ResultTab | null): boolean {
  return tab?.stream?.error?.code === 'QUERY_CANCELLED'
}

/** 翻页期间禁用分页按钮（避免连点产生并发页请求）。 */
const pagingBlocked = computed(
  () =>
    queryState.batchRunning ||
    active.value?.status === 'running' ||
    active.value?.status === 'streaming',
)

function onPage(delta: number) {
  const tab = active.value
  if (!tab?.pagination) return
  void goToPage(tab.key, tab.pagination.page + delta)
}

function totalCountTitle(tab: ResultTab): string {
  if (tab.totalCountState === 'loading') return t('正在执行 count(*) 统计总行数…')
  if (tab.totalCountState === 'error') {
    return tt`总行数统计失败：${tab.totalCountError ?? t('未知')}（点击重试）`
  }
  if (tab.totalCount !== null) {
    return t('这是本次查询（含字段筛选）的完整总行数；点击可重新统计')
  }
  return t('额外执行一条 count(*)（包含当前字段筛选），统计本次查询的完整总行数，而不是当前页')
}

async function onCountTotal(tab: ResultTab | null) {
  if (!tab) return
  const err = await countTotalRows(tab.key)
  if (err) message.error(err, { duration: 7000 })
}

// ---------------------------------------------------------------------------
// 服务端字段筛选（作用在全量查询结果上，不是当前页）
// ---------------------------------------------------------------------------

const filterColumn = ref('')
const filterOp = ref<FilterOp>('eq')
const filterValue = ref('')
const filterBusy = ref(false)

const filterColumns = computed(() => {
  const cols = active.value?.result?.columns ?? active.value?.lastColumns ?? []
  return cols.filter(isFilterableColumn)
})

const filterColumnOptions = computed(() =>
  filterColumns.value.map((c) => ({
    label: `${c.name} · ${c.typeName}`,
    value: c.name,
  })),
)

const selectedFilterColumn = computed(
  () => filterColumns.value.find((c) => c.name === filterColumn.value) ?? null,
)

const filterOpOptions = computed(() =>
  (selectedFilterColumn.value ? filterOperators(selectedFilterColumn.value.tag) : []).map(
    (op) => ({ label: t(FILTER_OP_LABEL[op]), value: op }),
  ),
)

const needsFilterValue = computed(() => opNeedsValue(filterOp.value))
const filterValuePlaceholder = computed(() =>
  selectedFilterColumn.value ? filterValueHint(selectedFilterColumn.value.tag) : t('值'),
)
const canAddFilter = computed(
  () =>
    Boolean(selectedFilterColumn.value) &&
    !pagingBlocked.value &&
    !filterBusy.value &&
    (!needsFilterValue.value || filterValue.value.trim() !== ''),
)

function onFilterColumnChange(name: string) {
  filterColumn.value = name
  const col = filterColumns.value.find((c) => c.name === name)
  if (!col) return
  const ops = filterOperators(col.tag)
  if (!ops.includes(filterOp.value)) filterOp.value = ops[0] ?? 'eq'
}

function onFilterOpChange(value: unknown) {
  const next = String(value) as FilterOp
  if (filterOpOptions.value.some((o) => o.value === next)) filterOp.value = next
}

// 结果列变化（首次出结果、换结果页）时把表单对齐到当前可用列；
// 不覆盖用户已选中的列。
watch(
  () => [active.value?.key, filterColumns.value.map((c) => c.name).join('|')] as const,
  () => {
    if (!filterColumns.value.some((c) => c.name === filterColumn.value)) {
      filterColumn.value = filterColumns.value[0]?.name ?? ''
    }
    const col = selectedFilterColumn.value
    const ops = col ? filterOperators(col.tag) : []
    if (!ops.includes(filterOp.value)) filterOp.value = ops[0] ?? 'eq'
  },
  { immediate: true },
)

async function addFilter() {
  const tab = active.value
  const col = selectedFilterColumn.value
  if (!tab || !col || !canAddFilter.value) return
  const filter: ColumnFilter = {
    column: col.name,
    tag: col.tag,
    op: filterOp.value,
    value: filterValue.value,
  }
  filterBusy.value = true
  try {
    const err = await applyTabFilters(tab.key, [...tab.filters, filter])
    if (err) message.error(err, { duration: 7000 })
    else filterValue.value = ''
  } finally {
    filterBusy.value = false
  }
}

async function removeColumnFilter(index: number) {
  const tab = active.value
  if (!tab) return
  filterBusy.value = true
  try {
    const err = await applyTabFilters(
      tab.key,
      tab.filters.filter((_, i) => i !== index),
    )
    if (err) message.error(err, { duration: 7000 })
  } finally {
    filterBusy.value = false
  }
}

async function clearColumnFilters() {
  const tab = active.value
  if (!tab) return
  filterBusy.value = true
  try {
    const err = await applyTabFilters(tab.key, [])
    if (err) message.error(err, { duration: 7000 })
  } finally {
    filterBusy.value = false
  }
}
</script>

<template>
  <div class="result-panel">
    <div class="tabbar">
      <div class="tabs">
        <div
          v-for="tab in tabs"
          :key="tab.key"
          class="tab"
          :class="{ active: tab.key === active?.key }"
          :style="{ '--tab-accent': colorForProfile(tab.profileId) }"
          :title="`${tab.title}\n${tab.profileName} · ${tab.identity}`"
          @click="activateTab(tab.key)"
        >
          <span class="status-dot" :class="tab.status" />
          <span class="tab-label">{{ shortText(tab.title, 34) }}</span>
          <span v-if="rowCountOf(tab) !== null" class="tab-rows">
            {{ formatCount(rowCountOf(tab)) }}
          </span>
          <button class="tab-close" :title="$t('关闭')" @click.stop="closeTab(tab.key)">×</button>
        </div>
      </div>
      <button
        v-if="tabs.length > 0"
        class="close-all"
        :title="$t('关闭当前标签的全部结果')"
        @click="closeActiveResults"
      >
        {{ $t("全部关闭") }}
      </button>
    </div>

    <div v-if="!active" class="empty-state">
      <strong>{{ $t("结果区") }}</strong>
      <div class="sub">
        {{ $t("结果按顶部编辑器标签隔离。") }}<span class="kbd">Ctrl/⌘ + Enter</span> {{ $t("执行光标所在语句\n        （有选区时只执行选区）；") }}<span class="kbd">Ctrl/⌘ + Shift + Enter</span> {{ $t("执行整篇\n        （逐条、失败即停）。网格内可过滤/排序/复制，双击行或 Ctrl+C 查看与复制。") }}
      </div>
    </div>

    <template v-else>
      <div class="statusbar">
        <span class="chip" :class="{ ok: active.status === 'ok', danger: active.status === 'error' }">
          {{ statusLabel(active) }}
        </span>

        <span class="chip mini conn" :title="`${active.profileName} · ${active.identity}`">
          <i class="chip-color" :style="{ background: colorForProfile(active.profileId) }" />
          {{ active.profileName }}
        </span>
        <span
          v-if="active.database"
          class="chip mini"
          :title="$t('执行时显式指定的目标库（database 选项）')"
        >
          {{ $t("库") }} {{ active.database }}
        </span>

        <span v-if="rowCountOf(active) !== null" class="stat">
          <b>{{ formatCount(rowCountOf(active)) }}</b> {{ $t("行") }}
        </span>
        <span
          v-if="elapsedOf(active) !== null || serverElapsedOf(active) !== null"
          class="stat timing"
          :title="timingTitle(active)"
        >
          <template v-if="serverElapsedOf(active) !== null">
            <span class="timing-label">{{ $t("查询") }}</span>
            {{ formatMs(serverElapsedOf(active)) }}
            <template v-if="transferElapsedOf(active) !== null">
              <span class="timing-sep">·</span>
              <span class="timing-label">{{ $t(active.stream ? '接收' : '传输') }}</span>
              {{ formatMs(transferElapsedOf(active)) }}
            </template>
            <template v-else-if="active.stream && !active.stream.done">
              <span class="timing-sep">·</span>
              <span class="timing-label">{{ $t("接收中") }}</span>
            </template>
          </template>
          <template v-else>
            <span class="timing-label">{{ $t(active.stream ? '接收' : '总耗时') }}</span>
            {{ formatMs(elapsedOf(active)) }}
          </template>
        </span>
        <span v-if="active.result?.command" class="stat mono">
          {{ active.result.command }}
          <template v-if="active.result.rowsAffected !== null && active.result.rowsAffected !== undefined">
            · {{ formatCount(active.result.rowsAffected) }} {{ $t("行") }}
          </template>
        </span>

        <span
          v-if="active.result?.queryId"
          class="stat qid"
          :title="$t('点击复制 queryId')"
          @click="copyQueryId(active.result?.queryId ?? '')"
        >
          qid {{ active.result?.queryId?.slice(0, 16) }}…
        </span>
        <span
          v-else-if="active.stream?.streamId"
          class="stat qid"
          :title="$t('点击复制 queryId')"
          @click="copyQueryId(active.stream?.streamId ?? '')"
        >
          qid {{ active.stream?.streamId?.slice(0, 16) }}…
        </span>

        <span v-if="active.channelNote" class="chip warn" :title="active.channelNote">
          {{ $t("通道已切换") }}
        </span>
        <span v-if="active.override" class="chip warn" :title="$t('本请求 maxRows=0')">
          {{ $t("护栏已豁免") }}
        </span>
        <span v-for="(w, i) in active.warnings" :key="i" class="chip warn" :title="w">
          {{ $t("警告") }}
        </span>

        <span class="spacer" />

        <NButton
          v-if="active.status === 'running' && !active.stream"
          size="tiny"
          type="error"
          secondary
          :loading="active.cancelRequested"
          :title="$t('取消：执行段向服务端取消；只读查询在传输段断开连接。写语句只取消执行段（避免把已提交的写入误标成取消）')"
          @click="onStop(active)"
        >
          {{ $t("取消") }}
        </NButton>
        <NButton
          v-if="active.stream && !active.stream.done"
          size="tiny"
          type="error"
          secondary
          :loading="active.stream.stopping"
          :title="$t('停止：执行段取消查询，传输段断开连接；已收到的行仍可浏览')"
          @click="onStop(active)"
        >
          {{ $t("停止") }}
        </NButton>
        <NButton
          size="tiny"
          secondary
          :disabled="active.status === 'running' || active.status === 'streaming'"
          @click="onRetry(active)"
        >
          {{ $t("重跑") }}
        </NButton>
        <NTooltip trigger="hover" :disabled="canExport(active)">
          <template #trigger>
            <span>
              <NButton size="tiny" :disabled="!canExport(active)" @click="openExport(active)">
                {{ $t("导出 CSV") }}
              </NButton>
            </span>
          </template>
          {{ $t("流式结果需要接收完成后才能导出（不做半截导出）。") }}
        </NTooltip>
      </div>

      <div v-if="active.override" class="banner warn-banner">
        {{ $t("本请求带") }} <span class="mono">maxRows=0</span>{{ $t("，已显式豁免部署方的结果护栏。请确认这是你要的行为。") }}
      </div>

      <div
        v-if="hasReloginWarning(active.warnings)"
        class="banner neutral-banner"
      >
        {{ $t("会话已失效，客户端已自动重登并重发了本次读请求（结果完整，无需手动操作）。") }}
      </div>

      <div v-if="bulkCancelled(active)" class="banner neutral-banner">
        {{ $t("查询已取消：bulk 通道不会返回部分数据，") }}<b>{{ $t("这不是完整结果") }}</b>{{ $t("。需要数据请重跑。") }}
      </div>

      <div v-if="active.stream?.error" class="banner" :class="streamIsCancelled(active) ? 'neutral-banner' : 'err-banner'">
        <span class="banner-text">
          <template v-if="streamIsCancelled(active)">
            {{ $t("查询已取消；已保留已收到的") }} {{ formatCount(active.stream?.totalRows ?? 0) }} {{ $t("行只读数据。") }}
          </template>
          <template v-else>
            {{ $t("流中断：已保留已收到的") }} {{ formatCount(active.stream?.totalRows ?? 0) }} {{ $t("行只读数据。") }}<b>{{ $t("这不是完整结果。") }}</b>
          </template>
        </span>
        <NButton size="tiny" secondary @click="onRetry(active)">{{ $t("重跑") }}</NButton>
      </div>

      <div v-if="active.stream?.error && !streamIsCancelled(active)" class="stream-error-area">
        <ErrorNotice
          dense
          :error="active.stream.error"
          @retry="onRetry(active)"
          @relogin="onRelogin"
          @guardrail="openGuardrailForTab(active?.key ?? '')"
        />
      </div>

      <div
        v-if="active.result?.kind === 'rows' && (active.result?.rows.length ?? 0) > 100_000"
        class="banner neutral-banner"
      >
        {{ $t("本次结果是完整数据（") }}{{ formatCount(active.result?.rowCount ?? 0) }} {{ $t("行，未截断），但超过 10 万行阈值；下次建议开启“流式”以保持内存有界。") }}
      </div>

      <div v-if="active.pagination && filterColumns.length > 0" class="server-filter">
        <div class="sf-form">
          <span class="sf-title">{{ $t("字段筛选") }}</span>
          <NSelect
            size="tiny"
            class="sf-col"
            :value="filterColumn"
            :options="filterColumnOptions"
            @update:value="onFilterColumnChange"
          />
          <NSelect
            size="tiny"
            class="sf-op"
            :value="filterOp"
            :options="filterOpOptions"
            @update:value="onFilterOpChange"
          />
          <NInput
            v-if="needsFilterValue"
            size="tiny"
            class="sf-value"
            :value="filterValue"
            :placeholder="filterValuePlaceholder"
            @update:value="(v) => (filterValue = v)"
            @keydown.enter="addFilter"
          />
          <NButton
            size="tiny"
            secondary
            :disabled="!canAddFilter"
            :loading="filterBusy"
            @click="addFilter"
          >
            {{ $t("添加") }}
          </NButton>
          <span class="spacer" />
          <span class="sf-hint" :title="$t('筛选条件发送到服务端，覆盖全量查询结果，不是当前页')">
            {{ $t("服务端 WHERE · 全量结果（不是本页）") }}
          </span>
        </div>
        <div v-if="active.filters.length > 0" class="sf-chips">
          <span v-for="(f, i) in active.filters" :key="i" class="sf-chip">
            {{ filterLabel(f) }}
            <button
              :title="$t('移除该条件并重新查询')"
              :disabled="filterBusy || pagingBlocked"
              @click="removeColumnFilter(i)"
            >
              ×
            </button>
          </span>
          <button
            class="sf-clear"
            :disabled="filterBusy || pagingBlocked"
            @click="clearColumnFilters"
          >
            {{ $t("清除全部筛选") }}
          </button>
        </div>
      </div>

      <div v-if="active.error && !active.stream && !bulkCancelled(active)" class="error-area">
        <ErrorNotice
          :error="active.error"
          @retry="onRetry(active)"
          @relogin="onRelogin"
          @guardrail="openGuardrailForTab(active?.key ?? '')"
        />
      </div>

      <div v-if="active.result?.kind === 'exec'" class="exec-receipt">
        <div class="exec-icon">✓</div>
        <div class="exec-title">{{ active.result.command ?? $t('执行完成') }}</div>
        <div class="exec-msg">{{ active.result.message }}</div>
        <div v-if="active.result.rowsAffected !== null && active.result.rowsAffected !== undefined" class="exec-rows">
          {{ $t("影响") }} {{ formatCount(active.result.rowsAffected) }} {{ $t("行") }}
        </div>
      </div>

      <div v-else-if="active.result?.kind === 'rows'" class="grid-area">
        <ResultGrid
          :key="active.key"
          mode="bulk"
          :columns="active.result.columns"
          :rows="active.result.rows"
        />
      </div>

      <div
        v-else-if="active.stream && active.stream.columns.length > 0"
        class="grid-area"
      >
        <ResultGrid
          :key="active.key"
          mode="stream"
          :columns="active.stream.columns"
          :stream-id="active.stream.streamId"
          :total-rows="active.stream.totalRows"
          :done="active.stream.done"
          :preview="active.stream.preview"
          :fetch-page="fetchPageFor(active)"
        />
      </div>

      <div v-else-if="active.status === 'running' || active.status === 'streaming'" class="empty-state">
        <strong>{{ $t(active.stream ? '正在接收流式结果…' : '正在执行…') }}</strong>
        <div class="sub">
          {{ active.stream ? tt`已接收 ${formatCount(active.stream?.totalRows ?? 0)} 行` : $t('结果到达后这里会显示网格。') }}
        </div>
      </div>

      <div v-if="active.pagination" class="pager">
        <span
          class="chip warn pager-badge"
          :title="$t('原 SQL 未带 LIMIT：Studio 默认每页 500 行，翻页会重新执行 LIMIT/OFFSET（不是前端切片）。没有 ORDER BY 时页序由服务端决定，翻页结果可能不稳定。')"
        >
          {{ $t("自动分页") }}
        </span>
        <button
          v-if="canCountTotal(active.pagination.baseSql)"
          type="button"
          class="pager-count"
          :class="{
            loading: active.totalCountState === 'loading',
            error: active.totalCountState === 'error',
            known: active.totalCount !== null,
          }"
          :disabled="pagingBlocked || active.totalCountState === 'loading'"
          :title="totalCountTitle(active)"
          @click="onCountTotal(active)"
        >
          <span
            v-if="active.totalCountState === 'loading'"
            class="count-spinner"
            aria-hidden="true"
          />
          <span aria-live="polite">
            <template v-if="active.totalCountState === 'loading'">{{ $t("统计中…") }}</template>
            <template v-else-if="active.totalCount !== null">
              {{ $t("共") }} {{ formatBigCount(active.totalCount) }} {{ $t("行") }}
            </template>
            <template v-else-if="active.totalCountState === 'error'">{{ $t("统计失败 · 重试") }}</template>
            <template v-else>{{ $t("结果总行数") }}</template>
          </span>
        </button>
        <span
          class="pager-hint"
          :title="$t('网格内快速过滤/排序只作用于当前页；上方“字段筛选”在服务端覆盖全量结果')"
        >
          {{ $t("原 SQL 未带 LIMIT · 每页") }} {{ active.pagination.pageSize }} {{ $t("行 ·\n          网格过滤/排序仅当前页") }}
        </span>
        <span class="spacer" />
        <NButton
          size="tiny"
          secondary
          :disabled="pagingBlocked || active.pagination.page <= 1"
          @click="onPage(-1)"
        >
          {{ $t("上一页") }}
        </NButton>
        <span class="pager-page mono">{{ $t("第") }} {{ active.pagination.page }} {{ $t("页") }}</span>
        <NButton
          size="tiny"
          secondary
          :disabled="pagingBlocked || !active.hasNextPage"
          :title="$t(active.hasNextPage ? '加载下一页' : '本页不足一页或已到最后一页')"
          @click="onPage(1)"
        >
          {{ $t("下一页") }}
        </NButton>
      </div>
    </template>

    <ExportModal v-model:show="exportShow" :tab="exportTab" />
  </div>
</template>

<style scoped>
.result-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tabbar {
  flex: 0 0 36px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  background:
    linear-gradient(180deg, var(--surface-soft), transparent 72%),
    var(--surface-soft);
  border-bottom: 1px solid var(--border);
  overflow: hidden;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 3px;
  overflow-x: auto;
  min-width: 0;
  flex: 1;
}

.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  flex: none;
  padding: 0 6px 0 9px;
  max-width: 260px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--text-soft);
  font-size: 11.5px;
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

.tab:hover {
  background: var(--hover);
  border-color: var(--border-subtle);
  color: var(--text);
  transform: translateY(-1px);
}

.tab.active {
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

.tab.active::after {
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

.tab.active:hover {
  transform: none;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 6px;
  background: var(--muted);
}

.status-dot.ok {
  background: var(--ok);
}

.status-dot.error {
  background: var(--danger);
}

.status-dot.running,
.status-dot.streaming {
  background: var(--accent);
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-rows {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--muted);
  background: var(--border-subtle);
  border-radius: 7px;
  padding: 1px 5px;
}

.tab-close {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  border-radius: 3px;
}

.tab-close:hover {
  background: var(--hover);
  color: var(--text);
}

.close-all {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 10.5px;
  cursor: pointer;
  white-space: nowrap;
}

.close-all:hover {
  color: var(--text);
}

.statusbar {
  flex: 0 0 34px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  background: transparent;
  overflow: hidden;
}

.stat {
  font-size: 11.5px;
  color: var(--text-soft);
  white-space: nowrap;
}

.stat.timing {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.timing-label {
  color: var(--muted);
  font-size: 10px;
}

.timing-sep {
  margin: 0 4px;
  color: var(--border-strong);
}

.chip.mini {
  height: 18px;
  font-size: 10px;
  padding: 0 6px;
}

.chip.conn {
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-color: var(--accent-border);
}

.chip-color {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 5px;
  vertical-align: 0.5px;
}

.stat b {
  font-family: var(--mono);
  font-weight: 650;
  color: var(--text);
}

.stat.qid {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--muted);
  cursor: pointer;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface-soft);
  border: 1px solid var(--border);
}

.stat.qid:hover {
  color: var(--accent);
}

.spacer {
  flex: 1;
}

.banner {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  font-size: 11.5px;
  line-height: 1.5;
  border-bottom: 1px solid;
}

.banner-text {
  flex: 1;
}

.warn-banner {
  background: var(--warn-soft);
  border-color: var(--warn-border);
  color: var(--warn);
}

.err-banner {
  background: var(--danger-soft);
  border-color: var(--danger-border);
  color: var(--danger-text);
}

.neutral-banner {
  background: var(--surface-soft);
  border-color: var(--border);
  color: var(--text-soft);
}

.error-area {
  overflow: auto;
}

.stream-error-area {
  padding: 8px 12px 0;
}

.exec-receipt {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-soft);
}

.exec-icon {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--ok-soft);
  color: var(--ok);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 700;
}

.exec-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}

.exec-msg {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--muted);
  max-width: 560px;
  text-align: center;
}

.exec-rows {
  font-size: 12px;
  color: var(--text-soft);
}

.grid-area {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  animation: grid-enter 0.32s cubic-bezier(0.22, 0.68, 0.24, 1) both;
}

@keyframes grid-enter {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .grid-area {
    animation: none;
  }
}

.server-filter {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-soft);
}

.sf-form {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.sf-title {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--muted);
  flex: 0 0 auto;
}

.sf-col {
  width: 180px;
  flex: 0 1 180px;
}

.sf-op {
  width: 100px;
  flex: 0 0 100px;
}

.sf-value {
  width: 170px;
  flex: 0 1 220px;
}

.sf-hint {
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sf-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}

.sf-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 3px 1px 7px;
  border-radius: 8px;
  border: 1px solid var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-family: var(--mono);
  font-size: 10px;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sf-chip button,
.sf-clear {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  padding: 0 3px;
}

.sf-chip button {
  font-size: 12px;
  line-height: 1;
}

.sf-chip button:hover,
.sf-clear:hover {
  color: var(--accent);
}

.sf-clear {
  font-size: 10px;
  text-decoration: underline;
}

.sf-chip button:disabled,
.sf-clear:disabled {
  color: var(--muted);
  cursor: default;
  opacity: 0.6;
}

.pager {
  flex: 0 0 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-top: 1px solid var(--border);
  background: var(--surface-soft);
  font-size: 11px;
  color: var(--text-soft);
  overflow: hidden;
}

.pager-badge {
  flex: 0 0 auto;
}

.pager-count {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  height: 20px;
  padding: 0 7px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}

.pager-count:hover:not(:disabled) {
  color: var(--accent-strong);
  border-color: var(--accent-border);
  border-style: solid;
  background: var(--accent-soft);
}

.pager-count.known {
  border-style: solid;
  border-color: var(--border);
  background: var(--surface-raised);
  color: var(--text-soft);
}

.pager-count.loading {
  border-style: solid;
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.pager-count.error {
  border-style: solid;
  border-color: var(--danger-border);
  background: var(--danger-soft);
  color: var(--danger-text);
}

.pager-count:disabled {
  cursor: default;
  opacity: 0.75;
}

.count-spinner {
  width: 9px;
  height: 9px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: count-spin 0.7s linear infinite;
}

@keyframes count-spin {
  to {
    transform: rotate(360deg);
  }
}

.pager-hint {
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pager-page {
  font-size: 11px;
  color: var(--text);
  min-width: 48px;
  text-align: center;
}

.kbd {
  font-family: var(--mono);
  font-size: 10.5px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 1px 4px;
  background: var(--surface-raised);
  color: var(--text-soft);
}
</style>
