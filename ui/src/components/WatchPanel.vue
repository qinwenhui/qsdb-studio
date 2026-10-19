<script setup lang="ts">
import { Channel } from '@tauri-apps/api/core'
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NInput,
  NSelect,
  useMessage,
} from 'naive-ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t, tt } from '../i18n'
import * as ipc from '../ipc'
import type { StudioError, WatchEvent } from '../ipc/types'
import { appState, refreshMeta, toStudioError } from '../stores/app'
import { notify } from '../stores/notifications'
import { openTablePreview } from '../stores/tablePreview'
import { uiState } from '../stores/ui'
import { errorHint } from '../utils/errors'
import { formatDateTime } from '../utils/format'

const message = useMessage()

interface TimelineItem {
  ev: WatchEvent
  at: number
}

const show = computed({
  get: () => uiState.watchOpen,
  set: (v: boolean) => {
    uiState.watchOpen = v
  },
})

function onRefreshMeta() {
  void refreshMeta()
}

const items = ref<TimelineItem[]>([])
const running = ref(false)
const error = ref<StudioError | null>(null)
const resetMessage = ref<string | null>(null)
const statusMessage = ref<string | null>(null)
const paused = ref(false)
const buffered = ref<TimelineItem[]>([])
const dropped = ref(0)
const filterKind = ref('all')
const filterDb = ref('*')
const filterTable = ref('')
let runSeq = 0

const MAX_EVENTS = 500

function dbName(ev: WatchEvent): string {
  return ev.database || t('（默认库）')
}

const dbOptions = computed(() => {
  const dbs = new Set<string>()
  for (const it of items.value) dbs.add(dbName(it.ev))
  return [
    { label: t('全部库'), value: '*' },
    ...[...dbs].sort().map((d) => ({ label: t(d), value: d })),
  ]
})

const kindOptions = [
  { label: '全部 kind', value: 'all' },
  { label: 'Append', value: 'Append' },
  { label: 'Overwrite', value: 'Overwrite' },
  { label: 'Clear', value: 'Clear' },
  { label: '其他', value: 'other' },
]

function kindMatches(kind: string): boolean {
  if (filterKind.value === 'all') return true
  if (filterKind.value === 'other') {
    return !['Append', 'Overwrite', 'Clear'].includes(kind)
  }
  return kind === filterKind.value
}

const filterActive = computed(
  () =>
    filterKind.value !== 'all' || filterDb.value !== '*' || filterTable.value.trim() !== '',
)

const filteredItems = computed(() => {
  const needle = filterTable.value.trim().toLowerCase()
  return items.value.filter((it) => {
    if (!kindMatches(it.ev.kind)) return false
    if (filterDb.value !== '*' && dbName(it.ev) !== filterDb.value) return false
    if (needle) {
      const full = `${it.ev.database ?? ''}.${it.ev.table}`.toLowerCase()
      if (!it.ev.table.toLowerCase().includes(needle) && !full.includes(needle)) {
        return false
      }
    }
    return true
  })
})

function handle(ev: WatchEvent) {
  if (ev.kind === 'Reset') {
    resetMessage.value = ev.message ?? t('游标已重置：已全量对账，之后从当前游标续订')
    statusMessage.value = null
    notify({
      kind: 'warn',
      title: t('变化流游标已重置'),
      detail: resetMessage.value,
      target: { kind: 'panel', panel: 'watch' },
    })
    void refreshMeta()
    return
  }
  if (ev.kind === 'Status') {
    statusMessage.value = ev.message ?? t('watch 连接中断，正在重连…')
    return
  }
  if (ev.kind === 'Error') {
    error.value = {
      kind: 'io',
      message: ev.message ?? t('watch 循环中断'),
      retriable: false,
    }
    statusMessage.value = null
    running.value = false
    notify({
      kind: 'error',
      title: t('变化流中断'),
      detail: error.value.message,
      target: { kind: 'panel', panel: 'watch' },
    })
    return
  }
  statusMessage.value = null
  const item = { ev, at: Date.now() }
  if (paused.value) {
    // 暂停 = 停止**显示**，订阅照常进行；事件进有界缓冲，溢出显式计数。
    buffered.value.unshift(item)
    if (buffered.value.length > MAX_EVENTS) {
      buffered.value.pop()
      dropped.value += 1
    }
    return
  }
  items.value.unshift(item)
  if (items.value.length > MAX_EVENTS) items.value.pop()
}

/** 暂停/恢复显示：恢复时把缓冲按到达顺序补到最前面。 */
function togglePause() {
  if (!running.value) return
  if (!paused.value) {
    paused.value = true
    return
  }
  const pending = buffered.value
  buffered.value = []
  paused.value = false
  if (pending.length > 0) {
    const merged = [...pending, ...items.value]
    const overflow = Math.max(0, merged.length - MAX_EVENTS)
    if (overflow > 0) dropped.value += overflow
    items.value = merged.slice(0, MAX_EVENTS)
  }
}

/** 事件 → 表预览（元数据里找不到时显式提示，不猜表）。 */
function openTable(ev: WatchEvent) {
  const full = ev.database ? `${ev.database}.${ev.table}` : ev.table
  const table =
    appState.tables.find((t) => t.name === full) ??
    appState.tables.find((t) => t.name.split('.').pop() === ev.table)
  if (!table) {
    message.warning(
      tt`元数据里没有 ${full}（可能已删除或尚未刷新）。先刷新元数据再试。`,
      { duration: 6000 },
    )
    return
  }
  void openTablePreview(table)
  uiState.watchOpen = false
}

async function start() {
  if (running.value) return
  const id = appState.connection?.profileId
  if (!id) {
    error.value = { kind: 'usage', message: t('尚未连接 QSDB 实例'), retriable: false }
    return
  }
  error.value = null
  resetMessage.value = null
  statusMessage.value = null
  items.value = []
  paused.value = false
  buffered.value = []
  dropped.value = 0
  filterDb.value = '*'
  const my = ++runSeq
  const ch = new Channel<WatchEvent>()
  ch.onmessage = (ev) => {
    if (!running.value || my !== runSeq) return
    handle(ev)
  }
  running.value = true
  try {
    await ipc.watchStart(id, null, ch)
  } catch (e) {
    running.value = false
    error.value = toStudioError(e)
  }
}

async function stop() {
  if (!running.value) return
  running.value = false
  paused.value = false
  buffered.value = []
  runSeq += 1
  const id = appState.connection?.profileId
  if (id) {
    try {
      await ipc.watchStop(id)
    } catch {
      // 连接已断时停止失败不影响本地状态。
    }
  }
}

function clearEvents() {
  items.value = []
  buffered.value = []
  dropped.value = 0
  error.value = null
  resetMessage.value = null
}

watch(
  () => uiState.watchOpen,
  (open) => {
    if (open) {
      void start()
    } else {
      void stop()
    }
  },
)

watch(
  () => appState.connection?.profileId,
  async () => {
    if (!uiState.watchOpen) return
    await stop()
    void start()
  },
)

onBeforeUnmount(() => {
  void stop()
})

function kindClass(kind: string): string {
  if (kind === 'Append') return 'ok'
  if (kind === 'Overwrite') return 'warn'
  if (kind === 'Clear') return 'danger'
  return ''
}
</script>

<template>
  <NDrawer v-model:show="show" :width="620" placement="right">
    <NDrawerContent :title="$t('数据变化流 · watch')" closable>
      <div class="body">
        <div class="topbar">
          <span class="dot" :class="{ running, paused }" />
          <span class="state">
            {{ running ? (paused ? $t('已订阅 · 暂停显示') : $t('已订阅')) : $t('未订阅') }}
          </span>
          <span class="chip">
            {{
              filterActive
                ? `${filteredItems.length} / ${items.length}`
                : items.length
            }}
            {{ $t("事件") }}
          </span>
          <span v-if="paused" class="chip warn">{{ $t("缓冲") }} {{ buffered.length }}</span>
          <span v-if="dropped > 0" class="chip warn">{{ $t("已丢弃") }} {{ dropped }}</span>
          <span class="spacer" />
          <NButton size="small" :disabled="!running" @click="clearEvents">{{ $t("清空") }}</NButton>
          <NButton
            v-if="running"
            size="small"
            secondary
            :type="paused ? 'primary' : 'default'"
            @click="togglePause"
          >
            {{ paused ? tt`恢复显示${buffered.length > 0 ? `（${buffered.length}）` : ''}` : $t('暂停显示') }}
          </NButton>
          <NButton v-if="running" size="small" type="error" secondary @click="stop">{{ $t("停止") }}</NButton>
          <NButton v-else size="small" type="primary" @click="start">{{ $t("开始订阅") }}</NButton>
        </div>

        <div class="filters">
          <NSelect
            v-model:value="filterKind"
            size="small"
            :options="kindOptions.map((o) => ({ ...o, label: $t(o.label) }))"
            class="f-kind"
          />
          <NSelect
            v-model:value="filterDb"
            size="small"
            :options="dbOptions"
            class="f-db"
          />
          <NInput
            v-model:value="filterTable"
            size="small"
            clearable
            :placeholder="$t('过滤表名（支持 db.table 片段）')"
            class="f-table"
          />
        </div>

        <div v-if="paused" class="banner neutral-banner">
          <span class="banner-text">
            {{ $t("已暂停显示：新事件进入缓冲（") }}{{ buffered.length }} {{ $t("条）。订阅仍在继续，\n            恢复后按到达顺序补入。") }}
          </span>
        </div>
        <div v-if="dropped > 0" class="banner warn-banner">
          <span class="banner-text">
            {{ $t("事件缓冲有上限（") }}{{ MAX_EVENTS }} {{ $t("条）：已丢弃最早") }} {{ dropped }} {{ $t("条。\n            恢复后事件流不连续，请以分区 / generation 对账为准。") }}
          </span>
        </div>

        <div v-if="resetMessage" class="banner warn-banner">
          <span class="banner-text">{{ resetMessage }}</span>
          <NButton size="tiny" secondary @click="onRefreshMeta">{{ $t("刷新元数据") }}</NButton>
        </div>

        <div v-if="statusMessage" class="banner neutral-banner">
          <span class="banner-text">{{ statusMessage }}</span>
        </div>

        <div v-if="error" class="error-box">
          <div class="err-head">
            <span class="code-badge">{{ error.code ?? error.kind }}</span>
            <span class="spacer" />
            <NButton size="tiny" secondary @click="start">{{ $t("重启订阅") }}</NButton>
          </div>
          <div class="err-msg">{{ error.message }}</div>
          <div class="err-hint">{{ errorHint(error) }}</div>
        </div>

        <div v-if="items.length === 0 && !error" class="empty-state">
          <strong>{{ running ? $t('等待提交事件…') : $t('尚未开始订阅') }}</strong>
          <div class="sub">
            {{ $t("长轮询 GET /api/v1/watch；有事件立刻回、没有挂起。more=true 会立刻续拉；\n            游标失效会自动全量对账一次并给出横幅——绝不假装事件流连续。") }}
          </div>
        </div>

        <div v-else-if="filteredItems.length === 0" class="empty-state">
          <strong>{{ $t("没有匹配的事件") }}</strong>
          <div class="sub">{{ $t("当前筛选：kind / 库 / 表名。清空筛选即可看到全部") }} {{ items.length }} {{ $t("条。") }}</div>
        </div>

        <div v-else class="timeline">
          <div v-for="(item, i) in filteredItems" :key="`${item.at}-${i}`" class="event">
            <div class="time mono">{{ formatDateTime(item.at) }}</div>
            <div class="event-body">
              <div class="event-head">
                <span class="chip" :class="kindClass(item.ev.kind)">{{ item.ev.kind }}</span>
                <button
                  class="target mono"
                  :title="tt`打开表预览：${item.ev.database ? item.ev.database + '.' : ''}${item.ev.table}`"
                  @click="openTable(item.ev)"
                >
                  {{ item.ev.database ? `${item.ev.database}.` : '' }}{{ item.ev.table }}
                </button>
                <span class="gen mono">gen {{ item.ev.generation }}</span>
              </div>
              <div v-if="item.ev.partition.length > 0" class="partition mono">
                {{ $t("分区 [") }}{{ item.ev.partition.join(', ') }}]
              </div>
            </div>
          </div>
        </div>

        <div class="foot-note">
          {{ $t("事件是加速器，不是真相来源：内核钩子可能丢事件。分区 / generation 的\n          对账路径始终可用；游标重置时 Studio 会全量对账并明确提示。") }}
        </div>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
}

.dot.running {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-soft);
}

.dot.running.paused {
  background: var(--warn);
  box-shadow: 0 0 0 3px var(--warn-soft);
}

.filters {
  display: flex;
  align-items: center;
  gap: 8px;
}

.f-kind {
  width: 132px;
}

.f-db {
  width: 170px;
}

.f-table {
  flex: 1;
  min-width: 0;
}

.state {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-soft);
}

.spacer {
  flex: 1;
}

.banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 7px;
  font-size: 11.5px;
  line-height: 1.5;
  border: 1px solid;
}

.banner-text {
  flex: 1;
}

.warn-banner {
  background: var(--warn-soft);
  border-color: var(--warn-border);
  color: var(--warn);
}

.neutral-banner {
  background: var(--surface-soft);
  border-color: var(--border);
  color: var(--text-soft);
}

.error-box {
  border: 1px solid var(--danger-border);
  background: var(--danger-soft);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.err-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.err-msg {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--danger-text);
  white-space: pre-wrap;
  word-break: break-word;
}

.err-hint {
  font-size: 11px;
  color: var(--danger);
  line-height: 1.5;
}

.timeline {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.event {
  display: grid;
  grid-template-columns: 132px 1fr;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-raised);
}

.time {
  font-size: 10.5px;
  color: var(--muted);
  padding-top: 2px;
}

.event-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.event-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.target {
  border: none;
  background: transparent;
  padding: 0;
  font-family: inherit;
  text-align: left;
  font-size: 12px;
  font-weight: 650;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.target:hover {
  color: var(--accent);
  text-decoration: underline;
}

.gen {
  font-size: 10.5px;
  color: var(--muted);
  margin-left: auto;
}

.partition {
  font-size: 10.5px;
  color: var(--text-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.foot-note {
  flex: 0 0 auto;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
</style>
