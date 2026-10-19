<script setup lang="ts">
import {
  NButton,
  NCheckbox,
  NDrawer,
  NDrawerContent,
  NSelect,
  useDialog,
  useMessage,
} from 'naive-ui'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import * as ipc from '../ipc'
import type { StoredQuery, StoredSession, StudioError } from '../ipc/types'
import { appState, toStudioError } from '../stores/app'
import { queryState } from '../stores/query'
import { uiState } from '../stores/ui'
import { errorHint } from '../utils/errors'
import { formatBytes, formatCount, formatDateTime, formatMs, shortText } from '../utils/format'
import {
  filterQueriesBySession,
  sortQueries,
  sortSessions,
  type QuerySort,
  type SessionSort,
} from '../utils/ops'

import { t, tt } from '../i18n'

const message = useMessage()
const dialog = useDialog()

const show = computed({
  get: () => uiState.opsOpen,
  set: (v: boolean) => {
    uiState.opsOpen = v
  },
})

const tab = ref<'queries' | 'sessions'>('queries')
const sessions = ref<StoredSession[]>([])
const queries = ref<StoredQuery[]>([])
const sessionsError = ref<StudioError | null>(null)
const queriesError = ref<StudioError | null>(null)
const loading = ref(false)
const autoRefresh = ref(true)
const lastUpdated = ref(0)

const querySort = ref<QuerySort>('elapsed')
const sessionSort = ref<SessionSort>('running')
/** 只显示某个会话的运行查询（从会话行“在跑”跳转过来时设置）。 */
const sessionFilter = ref<string | null>(null)
const highlightSessionId = ref<string | null>(null)

const querySortOptions = [
  { label: '耗时（长 → 短）', value: 'elapsed' },
  { label: '内存（大 → 小）', value: 'memory' },
  { label: '会话', value: 'session' },
]

/**
 * 服务端 `/queries` 只登记**执行中**的查询：执行完成、结果仍在序列化/
 * 传输/解码时会被提前移除。Studio 自己的结果页仍显示“执行中”，用户会
 * 以为面板坏了。这里把本机仍在跑/接收的查询合并进来；服务端已无对应 id
 * 的条目标为本机处理中（不能再向服务端取消）。
 */
interface OpsQueryRow extends StoredQuery {
  local?: boolean
  localOnly?: boolean
  tabKey?: string
  localNote?: string
}

function localQueryId(tab: (typeof queryState.tabs)[number]): string {
  return tab.requestedQueryId ?? tab.stream?.streamId ?? ''
}

const localQueryRows = computed<OpsQueryRow[]>(() => {
  const id = connectionId()
  if (!id) return []
  // 依赖 lastUpdated：面板每 2s 轮询时让“已耗时”跟着刷新。
  void lastUpdated.value
  const now = Date.now()
  return queryState.tabs
    .filter(
      (tab) =>
        tab.profileId === id &&
        (tab.status === 'running' || tab.status === 'streaming'),
    )
    .map((tab) => ({
      id: localQueryId(tab) || tab.key,
      sql: tab.sql,
      elapsedMs: Math.max(0, now - tab.startedAt),
      memoryBytes: 0,
      cancelled: tab.cancelRequested || Boolean(tab.stream?.stopping),
      sessionId: null,
      local: true,
      localOnly: true,
      tabKey: tab.key,
      localNote: tab.stream
        ? t('流式结果正在接收（可停止：执行段 cancel + 传输段断连接）')
        : t('服务端查询注册表里已不存在：可能已执行完，结果正在传回/解码（可取消本机传输）'),
    }))
})

const mergedQueries = computed<OpsQueryRow[]>(() => {
  const local = localQueryRows.value
  const byId = new Map(local.map((q) => [q.id, q]))
  const merged: OpsQueryRow[] = queries.value.map((q) => {
    const t = byId.get(q.id)
    return t
      ? { ...q, local: true, tabKey: t.tabKey, localNote: t.localNote }
      : q
  })
  const seen = new Set(merged.map((q) => q.id))
  for (const q of local) {
    if (seen.has(q.id)) continue
    merged.push(q)
    seen.add(q.id)
  }
  return merged
})

const localOnlyCount = computed(() => mergedQueries.value.filter((q) => q.localOnly).length)

const authKind = computed(() => appState.connection?.auth.kind ?? 'none')

/**
 * 会话可见性（内核十九批Ⅶ）：admin 看全量，非 admin 只看自己。
 * 踢出仍是 admin 专属；非 admin 的列表里不展示一个必然 403 的按钮。
 */
const canKick = computed(
  () => !appState.session || appState.session.role === 'admin',
)

const sessionSortOptions = [
  { label: '在跑查询数', value: 'running' },
  { label: '空闲时长', value: 'idle' },
  { label: '用户', value: 'user' },
]

const visibleQueries = computed(() =>
  sortQueries(
    filterQueriesBySession(mergedQueries.value, sessionFilter.value),
    querySort.value,
  ),
)

const visibleSessions = computed(() =>
  sortSessions(sessions.value, sessionSort.value),
)

let timer: number | undefined

function connectionId(): string | null {
  return appState.connection?.profileId ?? null
}

async function load() {
  const id = connectionId()
  if (!id) {
    const e: StudioError = { kind: 'usage', message: t('尚未连接 QSDB 实例'), retriable: false }
    sessionsError.value = e
    queriesError.value = e
    return
  }
  loading.value = true
  try {
    const [s, q] = await Promise.allSettled([ipc.sessionsList(id), ipc.queriesList(id)])
    // 切连接后迟到的响应不能覆盖新连接的面板。
    if (connectionId() !== id) return
    if (s.status === 'fulfilled') {
      sessions.value = s.value.sessions
      sessionsError.value = null
    } else {
      sessionsError.value = toStudioError(s.reason)
    }
    if (q.status === 'fulfilled') {
      queries.value = q.value.queries
      queriesError.value = null
    } else {
      queriesError.value = toStudioError(q.reason)
    }
    lastUpdated.value = Date.now()
  } finally {
    loading.value = false
  }
}

function stopPolling() {
  if (timer !== undefined) {
    window.clearInterval(timer)
    timer = undefined
  }
}

function startPolling() {
  stopPolling()
  timer = window.setInterval(() => {
    if (autoRefresh.value) void load()
  }, 2000)
}

watch(
  () => uiState.opsOpen,
  (open) => {
    if (open) {
      void load()
      startPolling()
    } else {
      stopPolling()
    }
  },
)

watch(
  () => appState.connection?.profileId,
  () => {
    // 清掉上一连接的快照，避免切换瞬间显示别人的查询/会话。
    queries.value = []
    sessions.value = []
    queriesError.value = null
    sessionsError.value = null
    sessionFilter.value = null
    if (uiState.opsOpen) void load()
  },
)

onBeforeUnmount(stopPolling)

function streamOf(q: OpsQueryRow) {
  const tab = q.tabKey
    ? queryState.tabs.find((t) => t.key === q.tabKey)
    : undefined
  const stream = tab?.stream
  return stream && !stream.done ? stream : null
}

function localTabOf(q: OpsQueryRow) {
  return q.tabKey
    ? queryState.tabs.find((t) => t.key === q.tabKey)
    : undefined
}

function canStop(q: OpsQueryRow): boolean {
  const tab = localTabOf(q)
  if (!tab) return false
  if (tab.stream) return !tab.stream.done
  // 本机 bulk 结果在传输段也能停：core 的 cancel 会 abort 本地 socket。
  return tab.status === 'running' && Boolean(tab.requestedQueryId)
}

function cancelQuery(q: OpsQueryRow) {
  const id = connectionId()
  if (!id) return
  void (async () => {
    try {
      const stream = streamOf(q)
      if (stream?.streamId) {
        // 本机流式结果：执行段 cancel + 传输段断连接。
        stream.stopping = true
        await ipc.sqlStreamStop(id, stream.streamId)
        message.success(tt`已停止本机流式传输 ${stream.streamId}`)
      } else {
        await ipc.sqlCancel(id, q.id)
        message.success(tt`已请求取消 ${q.id}`)
      }
      await load()
    } catch (e) {
      const stream = streamOf(q)
      if (stream) stream.stopping = false
      const info = toStudioError(e)
      message.error(`${info.code ?? info.kind}: ${info.message}`, { duration: 6000 })
    }
  })()
}

function kickSession(s: StoredSession) {
  const id = connectionId()
  if (!id) return
  dialog.warning({
    title: t('踢出会话'),
    content: tt`确定踢出会话 ${s.id}（${s.user}）？服务端会取消它全部在跑查询并吊销 token。`,
    positiveText: t('踢出'),
    negativeText: t('取消'),
    onPositiveClick: async () => {
      try {
        const r = await ipc.sessionsKick(id, s.id)
        message.success(tt`已踢出 ${r.kicked}，取消 ${formatCount(r.cancelledQueries)} 条查询`)
        await load()
      } catch (e) {
        const info = toStudioError(e)
        message.error(`${info.code ?? info.kind}: ${info.message}`, { duration: 6000 })
      }
    },
  })
}

function shortId(id: string | null): string {
  if (!id) return '—'
  return id.length > 14 ? `${id.slice(0, 12)}…` : id
}

function switchTab(next: 'queries' | 'sessions') {
  tab.value = next
  highlightSessionId.value = null
}

/** 运行查询 → 会话：切到会话页签并高亮/滚动到目标会话。 */
function jumpToSession(sessionId: string | null) {
  if (!sessionId) return
  tab.value = 'sessions'
  highlightSessionId.value = sessionId
  if (!sessions.value.some((s) => s.id === sessionId)) {
    message.warning(t('会话列表里没有这条会话（可能已结束，或当前角色无权查看）'), {
      duration: 5000,
    })
  }
  void nextTick(() => {
    const el = document.querySelector(
      `.session-row[data-sid="${CSS.escape(sessionId)}"]`,
    )
    el?.scrollIntoView({ block: 'center' })
  })
}

/** 会话 → 运行查询：切到查询页签并只显示该会话的查询。 */
function jumpToQueries(sessionId: string) {
  tab.value = 'queries'
  sessionFilter.value = sessionId
  highlightSessionId.value = sessionId
}
</script>

<template>
  <NDrawer v-model:show="show" :width="980" placement="right">
    <NDrawerContent :title="$t('会话 / 运行查询')" closable>
      <div class="body">
        <div class="topbar">
          <div class="mode-tabs">
            <button
              class="mode-tab"
              :class="{ active: tab === 'queries' }"
              @click="switchTab('queries')"
            >
              {{ $t("运行查询") }}
              <span v-if="mergedQueries.length > 0" class="count">{{ mergedQueries.length }}</span>
            </button>
            <button
              class="mode-tab"
              :class="{ active: tab === 'sessions' }"
              @click="switchTab('sessions')"
            >
              {{ $t("会话") }}
              <span v-if="sessions.length > 0" class="count">{{ sessions.length }}</span>
            </button>
          </div>
          <NSelect
            v-if="tab === 'queries'"
            v-model:value="querySort"
            size="tiny"
            class="sort-select"
            :options="querySortOptions.map((o) => ({ ...o, label: $t(o.label) }))"
          />
          <NSelect
            v-else
            v-model:value="sessionSort"
            size="tiny"
            class="sort-select"
            :options="sessionSortOptions.map((o) => ({ ...o, label: $t(o.label) }))"
          />
          <span class="spacer" />
          <NCheckbox v-model:checked="autoRefresh" size="small">{{ $t("每 2s 自动刷新") }}</NCheckbox>
          <span v-if="lastUpdated" class="hint">{{ formatDateTime(lastUpdated) }}</span>
          <NButton size="small" :loading="loading" @click="load">{{ $t("刷新") }}</NButton>
        </div>

        <div v-if="tab === 'queries'" class="pane">
          <div v-if="sessionFilter" class="filter-banner">
            <span>
              {{ $t("只看会话") }} <span class="mono">{{ shortId(sessionFilter) }}</span> {{ $t("的查询：") }}
              {{ visibleQueries.length }} / {{ mergedQueries.length }}
            </span>
            <span class="spacer" />
            <NButton size="tiny" quaternary @click="jumpToSession(sessionFilter)">{{ $t("查看会话") }}</NButton>
            <NButton size="tiny" quaternary @click="sessionFilter = null">{{ $t("显示全部") }}</NButton>
          </div>
          <div v-if="queriesError" class="error-box">
            <div class="err-head">
              <span class="code-badge">{{ queriesError.code ?? queriesError.kind }}</span>
              <span class="spacer" />
              <NButton size="tiny" secondary @click="load">{{ $t("重试") }}</NButton>
            </div>
            <div class="err-msg">{{ queriesError.message }}</div>
            <div class="err-hint">
              {{ errorHint(queriesError) }}
              <template v-if="localOnlyCount > 0">
                {{ $t("本机仍在处理的") }} {{ localOnlyCount }} {{ $t("条查询显示在下方。") }}
              </template>
            </div>
          </div>
          <div v-if="!queriesError && mergedQueries.length === 0" class="empty-state">
            <strong>{{ $t("当前没有运行中的查询") }}</strong>
            <div class="sub">{{ $t("这里每 2s 拉一次 GET /api/v1/queries；本机仍在接收大结果的查询也会显示（标注“本机处理中”）。") }}</div>
          </div>
          <div
            v-else-if="!queriesError && mergedQueries.length > 0 && visibleQueries.length === 0"
            class="empty-state"
          >
            <strong>{{ $t("该会话当前没有运行中的查询") }}</strong>
            <div class="sub">{{ $t("会话可能刚结束查询；点上方“显示全部”回到完整列表。") }}</div>
          </div>
          <div v-if="visibleQueries.length > 0" class="table">
            <div class="tr th q-grid">
              <span>queryId</span><span>SQL</span><span>{{ $t("耗时") }}</span><span>{{ $t("内存") }}</span>
              <span>{{ $t("会话") }}</span><span>{{ $t("状态") }}</span><span>{{ $t("操作") }}</span>
            </div>
            <div v-for="q in visibleQueries" :key="q.id" class="tr q-grid">
              <span class="mono qid" :title="q.id">{{ shortId(q.id) }}</span>
              <span class="sql mono" :title="q.sql">{{ shortText(q.sql, 96) }}</span>
              <span class="mono right">{{ formatMs(q.elapsedMs) }}</span>
              <span class="mono right">{{ q.localOnly ? '—' : formatBytes(q.memoryBytes) }}</span>
              <span>
                <button
                  v-if="q.sessionId"
                  class="link mono"
                  :title="tt`查看会话 ${q.sessionId}`"
                  @click="jumpToSession(q.sessionId)"
                >
                  {{ shortId(q.sessionId) }}
                </button>
                <span v-else class="mono">—</span>
              </span>
              <span>
                <span
                  class="chip"
                  :class="{ warn: q.cancelled, ok: !q.cancelled && !q.localOnly }"
                  :title="q.localOnly ? q.localNote : undefined"
                >
                  {{ q.cancelled ? $t('取消中') : q.localOnly ? $t('本机处理中') : $t('运行中') }}
                </span>
              </span>
              <span class="right">
                <NButton
                  v-if="!q.localOnly || canStop(q)"
                  size="tiny"
                  type="error"
                  secondary
                  @click="cancelQuery(q)"
                >
                  {{ streamOf(q) ? $t('停止') : $t('取消') }}
                </NButton>
                <span v-else class="local-action" :title="q.localNote">{{ $t("不可取消") }}</span>
              </span>
            </div>
          </div>
        </div>

        <div v-else class="pane">
          <div v-if="sessionsError" class="error-box">
            <div class="err-head">
              <span class="code-badge">{{ sessionsError.code ?? sessionsError.kind }}</span>
              <span class="spacer" />
              <NButton size="tiny" secondary @click="load">{{ $t("重试") }}</NButton>
            </div>
            <div class="err-msg">{{ sessionsError.message }}</div>
            <div class="err-hint">
              {{ errorHint(sessionsError) }}
              <template v-if="sessionsError.code === 'FORBIDDEN'">
                {{ $t("（会话列表：新内核 admin 可见全部、非 admin 只看自己的；旧内核\n                只允许 admin。匿名 / 静态 Token 连接没有会话；非 admin 不显示\n                踢出操作。）") }}
              </template>
            </div>
          </div>
          <div v-else-if="sessions.length === 0" class="empty-state">
            <strong>{{ $t("当前没有登录会话") }}</strong>
            <div v-if="authKind === 'basic'" class="sub">
              {{ $t("会话是进程内存态；服务端重启即清空。") }}
            </div>
            <div v-else class="sub">
              {{ $t("当前是匿名 / 静态 Token 连接，不会建立登录会话。运行中的查询仍显示在\n              “运行查询”页签；需要会话身份请使用 Basic 登录。") }}
            </div>
          </div>
          <div v-else class="table">
            <div class="tr th s-grid">
              <span>{{ $t("用户") }}</span><span>{{ $t("角色") }}</span><span>{{ $t("会话") }}</span><span>{{ $t("默认库") }}</span>
              <span>{{ $t("空闲") }}</span><span>{{ $t("在跑") }}</span><span>{{ $t("累计查询") }}</span><span>{{ $t("写入行") }}</span>
              <span>{{ $t("客户端") }}</span><span>{{ $t("操作") }}</span>
            </div>
            <div
              v-for="s in visibleSessions"
              :key="s.id"
              class="tr s-grid session-row"
              :class="{ highlight: highlightSessionId === s.id }"
              :data-sid="s.id"
            >
              <span class="mono">{{ s.user }}</span>
              <span>{{ s.role ?? '—' }}</span>
              <span class="mono" :title="s.id">{{ shortId(s.id) }}</span>
              <span class="mono">{{ s.defaultDb }}</span>
              <span class="mono right">{{ formatMs(s.idleMs) }}</span>
              <span class="right">
                <button
                  v-if="s.runningQueries.length > 0"
                  class="link mono"
                  :title="tt`只看这个会话的 ${s.runningQueries.length} 条运行查询`"
                  @click="jumpToQueries(s.id)"
                >
                  {{ s.runningQueries.length }}
                </button>
                <span v-else class="mono">0</span>
              </span>
              <span class="mono right">{{ formatCount(s.queriesTotal) }}</span>
              <span class="mono right">{{ formatCount(s.rowsWritten) }}</span>
              <span class="client" :title="s.client">{{ shortText(s.client, 42) }}</span>
              <span class="right">
                <NButton
                  v-if="canKick"
                  size="tiny"
                  type="error"
                  secondary
                  @click="kickSession(s)"
                >
                  {{ $t("踢出") }}
                </NButton>
                <span v-else class="local-action" :title="$t('踢出会话需要 admin；当前角色只能查看自己的会话')">
                  —
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mode-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
}

.mode-tab {
  border: none;
  background: transparent;
  padding: 7px 12px;
  font-size: 12.5px;
  color: var(--text-soft);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.mode-tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 650;
}

.count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 10px;
  font-weight: 700;
}

.spacer {
  flex: 1;
}

.sort-select {
  width: 150px;
}

.hint {
  font-size: 10.5px;
  color: var(--muted);
}

.filter-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 9px;
  border: 1px solid var(--accent-border, var(--border));
  background: var(--accent-soft);
  color: var(--accent-strong);
  border-radius: 7px;
  font-size: 11px;
}

.link {
  border: none;
  background: transparent;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  color: var(--accent-strong);
  cursor: pointer;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}

.link:hover {
  color: var(--accent);
  text-decoration-style: solid;
}

.tr.highlight {
  background: var(--accent-soft);
  box-shadow: inset 3px 0 0 var(--accent);
}

.pane {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.table {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.tr {
  display: grid;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--row-line);
  font-size: 11.5px;
}

.tr:last-child {
  border-bottom: none;
}

.tr:not(.th):hover {
  background: var(--surface-soft);
}

.th {
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.q-grid {
  grid-template-columns: 130px 1fr 84px 90px 110px 80px 70px;
}

.s-grid {
  grid-template-columns: 90px 64px 120px 78px 74px 52px 82px 78px 1fr 60px;
}

.mono {
  font-family: var(--mono);
}

.qid {
  color: var(--accent-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sql {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.client {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.right {
  text-align: right;
  display: block;
}

.local-action {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
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
</style>
