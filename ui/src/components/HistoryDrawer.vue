<script setup lang="ts">
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NInput,
  NSelect,
  useDialog,
  useMessage,
} from 'naive-ui'
import { computed, nextTick, ref, watch } from 'vue'
import * as ipc from '../ipc'
import type { Favorite, HistoryEntry, ParamInput } from '../ipc/types'
import { appState, baseQueryOptions } from '../stores/app'
import { colorForProfile } from '../stores/connectionColors'
import { guardSqlForExecution } from '../stores/execGuard'
import { openParams } from '../stores/params'
import { runSql } from '../stores/query'
import { uiState } from '../stores/ui'
import { newEditorTab, setActiveSql } from '../stores/workspace'
import { copyText } from '../utils/clipboard'
import { errorHint } from '../utils/errors'
import { formatCount, formatDateTime, formatMs, shortText } from '../utils/format'
import { scanPlaceholders } from '../utils/params'
import HighlightText from './HighlightText.vue'

import { t, tt } from '../i18n'

type Mode = 'history' | 'favorites'
type StatusFilter = 'all' | 'ok' | 'error'

const message = useMessage()
const dialog = useDialog()
const mode = ref<Mode>('history')
const entries = ref<HistoryEntry[]>([])
const favorites = ref<Favorite[]>([])
const loading = ref(false)
const search = ref('')
const statusFilter = ref<StatusFilter>('all')
const connFilter = ref('*')
const favSort = ref<'recent' | 'name'>('recent')
const renamingId = ref('')
const renameText = ref('')
let debounce: number | undefined

const statusOptions: { label: string; value: StatusFilter }[] = [
  { label: '全部', value: 'all' },
  { label: '成功', value: 'ok' },
  { label: '失败', value: 'error' },
]

/** 连接筛选：现有档案 + 历史里出现过的已删除档案（不去重名）。 */
const connOptions = computed(() => {
  const map = new Map<string, string>()
  for (const p of appState.profiles) map.set(p.id, p.name)
  for (const e of entries.value) {
    if (!map.has(e.profileId)) map.set(e.profileId, e.connectionName)
  }
  return [
    { label: t('全部连接'), value: '*' },
    ...[...map.entries()].map(([id, name]) => ({ label: name, value: id })),
  ]
})

function matchesSearch(e: HistoryEntry): boolean {
  const n = search.value.trim().toLowerCase()
  if (!n) return true
  return (
    e.sql.toLowerCase().includes(n) || e.connectionName.toLowerCase().includes(n)
  )
}

const filteredHistory = computed(() =>
  entries.value.filter(
    (e) =>
      matchesSearch(e) &&
      (statusFilter.value === 'all' || e.status === statusFilter.value) &&
      (connFilter.value === '*' || e.profileId === connFilter.value),
  ),
)

interface HistoryGroup {
  label: string
  items: HistoryEntry[]
}

/** 今天 / 昨天 / 最近 7 天 / 更早（保持新的在前）。 */
const historyGroups = computed<HistoryGroup[]>(() => {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = today - 24 * 3600 * 1000
  const week = today - 6 * 24 * 3600 * 1000
  const groups: HistoryGroup[] = [
    { label: t('今天'), items: [] },
    { label: t('昨天'), items: [] },
    { label: t('最近 7 天'), items: [] },
    { label: t('更早'), items: [] },
  ]
  for (const e of filteredHistory.value) {
    if (e.tsMs >= today) groups[0].items.push(e)
    else if (e.tsMs >= yesterday) groups[1].items.push(e)
    else if (e.tsMs >= week) groups[2].items.push(e)
    else groups[3].items.push(e)
  }
  return groups.filter((g) => g.items.length > 0)
})

const filteredFavorites = computed(() => {
  const n = search.value.trim().toLowerCase()
  const list = favorites.value.filter(
    (f) => !n || f.name.toLowerCase().includes(n) || f.sql.toLowerCase().includes(n),
  )
  if (favSort.value === 'name') {
    return [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }
  return [...list].sort((a, b) => b.createdAtMs - a.createdAtMs)
})

const placeholder = computed(() =>
  mode.value === 'history' ? t('搜索 SQL / 连接名') : t('搜索收藏名称 / SQL'),
)

const isEmpty = computed(() =>
  mode.value === 'history'
    ? filteredHistory.value.length === 0
    : filteredFavorites.value.length === 0,
)

const emptyTitle = computed(() => {
  if (mode.value === 'history') {
    if (entries.value.length === 0) return t('还没有执行历史')
    return t('没有匹配的历史')
  }
  return favorites.value.length === 0 ? t('还没有收藏') : t('没有匹配的收藏')
})

const emptySub = computed(() =>
  mode.value === 'history'
    ? t('每次执行都会追加到本地 JSONL（时间 / 连接 / SQL / 耗时 / 行数 / 状态）。')
    : t('在编辑器工具栏点“收藏”，保存常用 SQL；收藏与历史分开存储。'),
)

async function load() {
  loading.value = true
  try {
    const [h, f] = await Promise.all([
      ipc.historyList(500, search.value.trim() || null),
      ipc.favoritesList(),
    ])
    entries.value = h
    favorites.value = f
  } catch (e) {
    const info = (e as { info?: Parameters<typeof errorHint>[0] }).info
    message.error(info ? errorHint(info) : e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
}

function setMode(m: Mode) {
  if (mode.value === m) return
  mode.value = m
  // 历史走服务端搜索、收藏走本地搜索：切换页签时清掉上一个模式的搜索词，
  // 避免“切到收藏却因为历史的搜索词显示空列表”。
  search.value = ''
  // 收藏/历史列表都在打开时一起载入；切页签不需要再请求。
}

watch(
  () => uiState.historyOpen,
  (open) => {
    if (open) void load()
  },
  // HMR/组件重建时抽屉可能已经是打开状态：立即补一次加载。
  { immediate: true },
)

watch(search, () => {
  if (mode.value === 'favorites') return
  window.clearTimeout(debounce)
  debounce = window.setTimeout(() => void load(), 250)
})

function useSql(sql: string) {
  setActiveSql(sql)
  uiState.historyOpen = false
  message.success(t('已回填到当前编辑器标签'))
}

function useEntry(entry: HistoryEntry) {
  useSql(entry.sql)
}

function useFavorite(fav: Favorite) {
  useSql(fav.sql)
}

async function copySql(sql: string) {
  try {
    await copyText(sql)
    message.success(t('SQL 已复制'))
  } catch {
    message.error(t('复制失败（系统剪贴板不可用）'))
  }
}

/**
 * 重跑：用历史/收藏里的 SQL 在新标签执行。
 * 目标连接必须仍存在且已打开；只读/危险语句复用统一护栏。
 */
async function rerunSql(sql: string, profileId: string | null, source: string) {
  if (!profileId) {
    message.warning(t('没有可用连接：已回填，请先选择并打开一个连接'))
    useSql(sql)
    return
  }
  const profile = appState.profiles.find((p) => p.id === profileId)
  if (!profile) {
    message.warning(t('该连接档案已删除：已回填，请选择当前可用的连接'))
    useSql(sql)
    return
  }
  if (!appState.connections[profileId]) {
    message.warning(
      tt`连接「${profile.name}」未打开：已回填，连接后可继续执行。`,
      { duration: 6000 },
    )
    useSql(sql)
    return
  }
  const ph = scanPlaceholders(sql)
  if (ph.mixed) {
    message.error(t('同一句不能混用 $n 与 ? 占位符'))
    return
  }

  const outcome = await guardSqlForExecution(profileId, [{ sql, line: 1 }])
  if (!outcome.ok) {
    if (!outcome.cancelled && outcome.reason) {
      message.error(outcome.reason, { duration: 9000 })
    }
    return
  }

  const tab = newEditorTab(profileId, sql)
  const database = tab.database
  const exec = (params: ParamInput[]) => {
    void runSql(
      tab.key,
      profileId,
      sql,
      { ...baseQueryOptions(), params, ...(database ? { database } : {}) },
      { stream: false },
    )
    uiState.historyOpen = false
    message.success(tt`已在「${profile.name}」重跑${source}`)
  }
  if (ph.count > 0) {
    openParams(sql, ph.count, exec)
  } else {
    exec([])
  }
}

function rerunEntry(entry: HistoryEntry) {
  void rerunSql(entry.sql, entry.profileId, t('历史'))
}

function rerunFavorite(fav: Favorite) {
  void rerunSql(fav.sql, appState.activeProfileId, t('收藏'))
}

function startRename(fav: Favorite) {
  renamingId.value = fav.id
  renameText.value = fav.name
  void nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.rename-input input')
    el?.focus()
    el?.select()
  })
}

function cancelRename() {
  renamingId.value = ''
  renameText.value = ''
}

async function commitRename(fav: Favorite) {
  if (renamingId.value !== fav.id) return
  const name = renameText.value.trim()
  if (!name || name === fav.name) {
    cancelRename()
    return
  }
  try {
    const updated = await ipc.favoriteRename(fav.id, name)
    const idx = favorites.value.findIndex((f) => f.id === fav.id)
    if (idx >= 0) favorites.value[idx] = updated
    message.success(t('已重命名收藏'))
  } catch (e) {
    const info = (e as { info?: Parameters<typeof errorHint>[0] }).info
    message.error(info ? errorHint(info) : e instanceof Error ? e.message : String(e))
  } finally {
    cancelRename()
  }
}

function confirmRemoveFavorite(fav: Favorite) {
  dialog.warning({
    title: t('删除收藏'),
    content: tt`确定删除「${fav.name}」？SQL 文本不会从历史里删除。`,
    positiveText: t('删除'),
    negativeText: t('取消'),
    onPositiveClick: async () => {
      try {
        await ipc.favoriteRemove(fav.id)
        favorites.value = favorites.value.filter((f) => f.id !== fav.id)
        message.success(t('已删除收藏'))
      } catch (e) {
        const info = (e as { info?: Parameters<typeof errorHint>[0] }).info
        message.error(
          info ? errorHint(info) : e instanceof Error ? e.message : String(e),
        )
      }
    },
  })
}

function missingProfile(entry: HistoryEntry): boolean {
  return !appState.profiles.some((p) => p.id === entry.profileId)
}
</script>

<template>
  <NDrawer v-model:show="uiState.historyOpen" :width="680" placement="right">
    <NDrawerContent :title="$t('SQL 历史 / 收藏')" closable>
      <div class="body">
        <div class="mode-tabs">
          <button
            class="mode-tab"
            :class="{ active: mode === 'history' }"
            @click="setMode('history')"
          >
            {{ $t("执行历史") }}
            <span v-if="entries.length > 0" class="count">{{ entries.length }}</span>
          </button>
          <button
            class="mode-tab"
            :class="{ active: mode === 'favorites' }"
            @click="setMode('favorites')"
          >
            {{ $t("收藏") }}
            <span v-if="favorites.length > 0" class="count">{{ favorites.length }}</span>
          </button>
        </div>

        <div class="toolbar">
          <NInput
            v-model:value="search"
            size="small"
            clearable
            :placeholder="placeholder"
            class="search"
          />
          <NButton size="small" :loading="loading" @click="load">{{ $t("刷新") }}</NButton>
        </div>

        <div v-if="mode === 'history'" class="filters">
          <div class="seg" role="group" :aria-label="$t('按状态筛选')">
            <button
              v-for="s in statusOptions"
              :key="s.value"
              class="seg-btn"
              :class="{ active: statusFilter === s.value }"
              @click="statusFilter = s.value"
            >
              {{ $t(s.label) }}
            </button>
          </div>
          <NSelect
            v-model:value="connFilter"
            size="small"
            :options="connOptions"
            class="conn-filter"
          />
          <span class="result-count">{{ filteredHistory.length }} {{ $t("条") }}</span>
        </div>
        <div v-else class="filters">
          <NSelect
            v-model:value="favSort"
            size="small"
            :options="[
              { label: $t('最近收藏'), value: 'recent' },
              { label: $t('按名称'), value: 'name' },
            ]"
            class="sort-filter"
          />
          <span class="result-count">{{ filteredFavorites.length }} {{ $t("条") }}</span>
        </div>

        <div v-if="isEmpty" class="empty-state">
          <strong>{{ emptyTitle }}</strong>
          <div class="sub">{{ emptySub }}</div>
        </div>

        <div v-else-if="mode === 'history'" class="list">
          <template v-for="group in historyGroups" :key="group.label">
            <div class="group-label">{{ group.label }}</div>
            <div
              v-for="(entry, i) in group.items"
              :key="`${entry.tsMs}-${i}`"
              class="entry"
              role="button"
              tabindex="0"
              :title="`${entry.connectionName}\n${entry.sql}`"
              @click="useEntry(entry)"
              @keydown.enter.prevent="useEntry(entry)"
            >
              <div class="entry-head">
                <span class="dot" :class="entry.status" />
                <span class="time">{{ formatDateTime(entry.tsMs) }}</span>
                <span
                  class="chip mini conn"
                  :class="{ missing: missingProfile(entry) }"
                  :title="missingProfile(entry) ? $t('连接档案已删除') : entry.connectionName"
                >
                  <i
                    class="conn-dot"
                    :style="{
                      background: missingProfile(entry)
                        ? 'var(--muted)'
                        : colorForProfile(entry.profileId),
                    }"
                  />
                  <HighlightText :text="entry.connectionName" :query="search" />
                </span>
                <span v-if="entry.status === 'ok'" class="stat">
                  {{ formatCount(entry.rowCount) }} {{ $t("行 ·") }} {{ formatMs(entry.elapsedMs) }}
                </span>
                <span v-else class="stat danger">{{ entry.errorCode ?? $t('失败') }}</span>
                <span class="spacer" />
                <span class="entry-actions" @click.stop @keydown.stop>
                  <NButton
                    size="tiny"
                    type="primary"
                    secondary
                    :disabled="missingProfile(entry)"
                    :title="
                      missingProfile(entry)
                        ? $t('连接档案已删除，不能重跑')
                        : $t('在新标签重跑')
                    "
                    @click="rerunEntry(entry)"
                  >
                    {{ $t("重跑") }}
                  </NButton>
                  <button class="link-btn" @click="useEntry(entry)">{{ $t("回填") }}</button>
                  <button class="link-btn" @click="copySql(entry.sql)">{{ $t("复制") }}</button>
                </span>
              </div>
              <div class="sql mono">
                <HighlightText :text="shortText(entry.sql, 240)" :query="search" />
              </div>
            </div>
          </template>
        </div>

        <div v-else class="list">
          <div
            v-for="fav in filteredFavorites"
            :key="fav.id"
            class="entry"
            role="button"
            tabindex="0"
            :title="`${fav.name}\n${fav.sql}`"
            @click="useFavorite(fav)"
            @keydown.enter.prevent="useFavorite(fav)"
          >
            <div class="entry-head">
              <span class="star">★</span>
              <NInput
                v-if="renamingId === fav.id"
                v-model:value="renameText"
                size="tiny"
                class="rename-input"
                @click.stop
                @keydown.enter.stop.prevent="commitRename(fav)"
                @keydown.esc.stop.prevent="cancelRename"
                @blur="commitRename(fav)"
              />
              <span
                v-else
                class="fav-name"
                :title="$t('双击重命名')"
                @dblclick.stop="startRename(fav)"
              >
                <HighlightText :text="fav.name" :query="search" />
              </span>
              <span class="time">{{ formatDateTime(fav.createdAtMs) }}</span>
              <span class="spacer" />
              <span class="entry-actions" @click.stop @keydown.stop>
                <NButton
                  size="tiny"
                  type="primary"
                  secondary
                  :title="$t('用当前标签的连接重跑')"
                  @click="rerunFavorite(fav)"
                >
                  {{ $t("重跑") }}
                </NButton>
                <button class="link-btn" @click="useFavorite(fav)">{{ $t("回填") }}</button>
                <button class="link-btn" @click="startRename(fav)">{{ $t("重命名") }}</button>
                <button class="link-btn" @click="copySql(fav.sql)">{{ $t("复制") }}</button>
                <button class="link-btn danger" @click="confirmRemoveFavorite(fav)">
                  {{ $t("删除") }}
                </button>
              </span>
            </div>
            <div class="sql mono">
              <HighlightText :text="shortText(fav.sql, 240)" :query="search" />
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

.mode-tab:hover {
  color: var(--text);
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

.toolbar {
  display: flex;
  gap: 8px;
}

.search {
  flex: 1;
}

.filters {
  display: flex;
  align-items: center;
  gap: 8px;
}

.seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 7px;
  overflow: hidden;
}

.seg-btn {
  border: none;
  background: var(--surface-raised);
  color: var(--text-soft);
  font-size: 11px;
  padding: 4px 9px;
  cursor: pointer;
}

.seg-btn + .seg-btn {
  border-left: 1px solid var(--border);
}

.seg-btn.active {
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 650;
}

.conn-filter {
  width: 170px;
}

.sort-filter {
  width: 130px;
}

.result-count {
  font-size: 10.5px;
  color: var(--muted);
}

.list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  overflow: auto;
  padding-right: 2px;
}

.group-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin: 4px 2px 0;
}

.entry {
  text-align: left;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-raised);
  padding: 8px 10px;
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.12s, background 0.12s;
  outline: none;
}

.entry:hover,
.entry:focus-visible {
  border-color: var(--accent-border);
  background: var(--surface-soft);
}

.entry:focus-visible {
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.entry-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 5px;
  min-height: 22px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
  flex: 0 0 7px;
}

.dot.ok {
  background: var(--ok);
}

.dot.error {
  background: var(--danger);
}

.star {
  color: var(--warn);
  font-size: 12px;
  line-height: 1;
}

.fav-name {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--text);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
}

.rename-input {
  width: 200px;
}

.time {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--mono);
}

.chip.mini {
  height: 17px;
  font-size: 10px;
  padding: 0 5px;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip.mini.missing {
  color: var(--muted);
}

.conn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 4px;
  vertical-align: 0.5px;
}

.stat {
  font-size: 11px;
  color: var(--text-soft);
}

.stat.danger {
  color: var(--danger);
  font-family: var(--mono);
}

.spacer {
  flex: 1;
}

.entry-actions {
  display: flex;
  align-items: center;
  gap: 3px;
}

.link-btn {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 10.5px;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}

.link-btn:hover {
  color: var(--accent);
  background: var(--accent-soft);
}

.link-btn.danger:hover {
  color: var(--danger);
  background: var(--danger-soft);
}

.sql {
  font-size: 11px;
  color: var(--text-soft);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 48px;
  overflow: hidden;
}

.sql :deep(mark),
.fav-name :deep(mark),
.chip :deep(mark) {
  background: var(--warn-soft);
  color: var(--text);
  border-radius: 2px;
  padding: 0 1px;
}

.mono {
  font-family: var(--mono);
}
</style>
