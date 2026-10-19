<script setup lang="ts">
// 文件管理面（内核二十批）：像浏览文件目录一样浏览存储。
//
// 只做展示与动作编排：list/detail/trash/download 都走 qsdb-client 一等方法；
// 引用状态是**三态**——`null`（未知）绝不按“未引用”放行删除。
import { save } from '@tauri-apps/plugin-dialog'
import { NButton, NDrawer, NDrawerContent, useDialog, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import * as ipc from '../ipc'
import type { FileDetail, FileEntry, FileListing, StudioError } from '../ipc/types'
import { appState, baseQueryOptions, toStudioError } from '../stores/app'
import { runSql } from '../stores/query'
import { uiState } from '../stores/ui'
import { newEditorTab } from '../stores/workspace'
import { copyText } from '../utils/clipboard'
import { errorHint } from '../utils/errors'
import { formatBytes, formatCount, formatDateTime } from '../utils/format'

import { t, tt } from '../i18n'

const message = useMessage()
const dialog = useDialog()

const show = computed({
  get: () => uiState.filesOpen,
  set: (v: boolean) => {
    uiState.filesOpen = v
  },
})

const listing = ref<FileListing | null>(null)
const dir = ref('')
const loading = ref(false)
const error = ref<StudioError | null>(null)

const selectedPath = ref('')
const detail = ref<FileDetail | null>(null)
const detailLoading = ref(false)
const detailError = ref<StudioError | null>(null)

const downloading = ref(false)
const trashing = ref(false)

let listSeq = 0
let detailSeq = 0

const currentProfile = computed(
  () => appState.profiles.find((p) => p.id === appState.activeProfileId) ?? null,
)
const profileName = computed(() => currentProfile.value?.name ?? t('未绑定连接'))
const readOnly = computed(() => Boolean(currentProfile.value?.readOnly))
const isAdmin = computed(() => appState.session?.role === 'admin')

const parts = computed(() => (dir.value ? dir.value.split('/') : []))
const entries = computed(() => listing.value?.entries ?? [])
const mounts = computed(() => listing.value?.mounts ?? [])
const dirCount = computed(() => entries.value.filter((e) => e.isDir).length)
const fileCount = computed(() => entries.value.length - dirCount.value)
const segmentCount = computed(
  () => entries.value.filter((e) => Boolean(e.segment)).length,
)

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name
}

function prefixAt(index: number): string {
  return parts.value.slice(0, index + 1).join('/')
}

function entryPath(entry: FileEntry): string {
  return joinPath(dir.value, entry.name)
}

function mountActive(name: string): boolean {
  return dir.value === name || dir.value.startsWith(`${name}/`)
}

const kindLabels: Record<string, string> = {
  dir: '目录',
  segment: '段文件',
  manifest: 'manifest',
  index: '分区索引',
  tabledef: '表定义',
  other: '文件',
}

function kindLabel(kind: string): string {
  const label = kindLabels[kind]
  return label ? t(label) : kind
}

/** 列表条目的粗略类型（段以 client 的 segment 字段为准）。 */
function entryKind(entry: FileEntry): string {
  if (entry.isDir) return 'dir'
  if (entry.segment) return 'segment'
  if (entry.name === 'manifest.postcard' || entry.name.startsWith('manifest')) {
    return 'manifest'
  }
  if (entry.name.endsWith('.idx')) return 'index'
  if (entry.name === 'table.json') return 'tabledef'
  return 'other'
}

function kindClass(kind: string): string {
  return `k-${kind}`
}

function refLabel(entry: FileEntry | null | undefined): string {
  const r = entry?.segment?.referenced
  if (r === true) return t('被引用')
  if (r === false) return t('孤儿')
  return t('未知')
}

function refClass(entry: FileEntry | null | undefined): string {
  const r = entry?.segment?.referenced
  if (r === true) return 'ok'
  if (r === false) return 'warn'
  return ''
}

function detailRefLabel(ref: boolean | null | undefined): string {
  if (ref === true) return t('被 manifest 引用（不可删除）')
  if (ref === false) return t('孤儿段（未引用，可移入回收站）')
  return t('引用状态未知（manifest 缺失/损坏）')
}

function detailRefClass(ref: boolean | null | undefined): string {
  if (ref === true) return 'ok'
  if (ref === false) return 'warn'
  return ''
}

async function load(path: string) {
  const id = appState.activeProfileId
  if (!id || !appState.connections[id]) {
    listing.value = null
    error.value = {
      kind: 'usage',
      message: t('尚未连接 QSDB 实例：请先连接后再浏览文件。'),
      retriable: false,
    }
    return
  }
  const seq = ++listSeq
  loading.value = true
  error.value = null
  selectedPath.value = ''
  detail.value = null
  detailError.value = null
  try {
    const l = await ipc.filesList(id, path)
    // 多标签切换连接：迟到的响应不覆盖当前连接。
    if (seq !== listSeq || appState.activeProfileId !== id) return
    listing.value = l
    dir.value = l.dir
  } catch (e) {
    if (seq !== listSeq || appState.activeProfileId !== id) return
    listing.value = null
    error.value = toStudioError(e)
  } finally {
    if (seq === listSeq) loading.value = false
  }
}

function refresh() {
  void load(dir.value)
}

function navigate(path: string) {
  void load(path)
}

function goUp() {
  void load(parts.value.slice(0, -1).join('/'))
}

function onEntry(entry: FileEntry) {
  if (entry.isDir) {
    navigate(entryPath(entry))
    return
  }
  selectedPath.value = entryPath(entry)
  void loadDetail(entryPath(entry))
}

async function onEntryDblClick(entry: FileEntry) {
  if (entry.isDir) return
  const path = entryPath(entry)
  selectedPath.value = path
  if (detail.value?.path !== path) await loadDetail(path)
  if (detail.value?.path === path && detail.value.readSql) previewFile()
}

async function loadDetail(path: string) {
  const id = appState.activeProfileId
  if (!id) return
  const seq = ++detailSeq
  detailLoading.value = true
  detailError.value = null
  try {
    const d = await ipc.filesDetail(id, path)
    if (seq !== detailSeq || appState.activeProfileId !== id) return
    detail.value = d
  } catch (e) {
    if (seq !== detailSeq || appState.activeProfileId !== id) return
    detail.value = null
    detailError.value = toStudioError(e)
  } finally {
    if (seq === detailSeq) detailLoading.value = false
  }
}

function retryDetail() {
  if (selectedPath.value) void loadDetail(selectedPath.value)
}

const canTrash = computed(
  () =>
    detail.value?.kind === 'segment' &&
    detail.value.segment?.referenced === false &&
    !readOnly.value,
)

const trashNote = computed(() => {
  const d = detail.value
  if (!d) return ''
  if (readOnly.value) return t('当前连接标记为只读：不会向你提供删除动作。')
  if (d.kind !== 'segment') {
    return t(
      '只有 seg_*.parquet 段文件可以移入回收站；manifest / table.json 等元数据受保护（服务端 400）。',
    )
  }
  if (d.segment?.referenced === true) {
    return t(
      '被引用段不可删除（服务端 409 SEGMENT_REFERENCED）：删数据请走 DELETE WHERE <分区> 或 INSERT OVERWRITE。',
    )
  }
  if (d.segment?.referenced === null || d.segment?.referenced === undefined) {
    return t('manifest 缺失/损坏：引用状态未知。未知 ≠ 未引用，Studio 不提供删除。')
  }
  return t(
    '仅孤儿段可移入 _trash；静默期内可用 admin trash restore 恢复。文件删除永远是两步可撤销。',
  )
})

const tableDefJson = computed(() => {
  const def = detail.value?.tableDef
  if (def === null || def === undefined) return ''
  try {
    return JSON.stringify(def, null, 2)
  } catch {
    return String(def)
  }
})

function previewFile() {
  const d = detail.value
  const id = appState.activeProfileId
  if (!d?.readSql) {
    message.warning(
      t('服务端没有返回 readSql（远端库不支持本地文件预览）；可改用 SELECT 查询该表/分区。'),
    )
    return
  }
  if (!id) return
  const tab = newEditorTab(id, d.readSql)
  uiState.filesOpen = false
  void runSql(tab.key, id, d.readSql, baseQueryOptions(), {
    stream: false,
    title: tt`文件预览 · ${d.name}`,
  })
}

function openFileSql() {
  const d = detail.value
  const id = appState.activeProfileId
  if (!d?.readSql || !id) return
  newEditorTab(id, d.readSql)
  uiState.filesOpen = false
  message.success(t('已把文件预览 SQL 插入新标签（未执行）'))
}

async function copyReadSql() {
  const sql = detail.value?.readSql
  if (!sql) return
  if (await copyText(sql)) message.success(t('已复制预览 SQL'))
  else message.error(t('复制失败：剪贴板不可用'))
}

async function download() {
  const d = detail.value
  const id = appState.activeProfileId
  if (!d || d.isDir || !id) return
  const local = await save({
    title: t('保存服务端文件'),
    defaultPath: d.name,
  })
  if (!local) return
  downloading.value = true
  try {
    const n = await ipc.downloadFile(id, d.path, local)
    message.success(tt`已下载 ${formatBytes(n)} → ${local}`)
  } catch (e) {
    const err = toStudioError(e)
    message.error(`${err.code ?? err.kind}: ${err.message}\n${errorHint(err)}`, {
      duration: 8000,
    })
  } finally {
    downloading.value = false
  }
}

function askTrash() {
  const d = detail.value
  if (!d || !canTrash.value) return
  dialog.warning({
    title: t('将孤儿段移入回收站？'),
    content:
      tt`路径：${d.path}\n\n` +
      t('只会移动未被存活 manifest 引用的 seg_*.parquet。文件进入 _trash 后可在静默期内用 ') +
      t('`admin trash restore` 恢复；被引用段服务端会拒绝（409 SEGMENT_REFERENCED）。'),
    positiveText: t('移入回收站'),
    negativeText: t('取消'),
    onPositiveClick: () => {
      void doTrash(d)
    },
  })
}

async function doTrash(d: FileDetail) {
  const id = appState.activeProfileId
  if (!id) return
  trashing.value = true
  try {
    const ack = await ipc.filesTrash(id, d.path)
    message.success(tt`已移入回收站：${ack.path}`)
    await load(dir.value)
  } catch (e) {
    const err = toStudioError(e)
    detailError.value = err
    message.error(`${err.code ?? err.kind}: ${err.message}\n${errorHint(err)}`, {
      duration: 9000,
    })
    // 引用状态可能已变化：刷新列表，让三态回到服务端真值。
    if (err.code === 'SEGMENT_REFERENCED') await load(dir.value)
  } finally {
    trashing.value = false
  }
}

function reset() {
  listSeq += 1
  detailSeq += 1
  listing.value = null
  dir.value = ''
  loading.value = false
  error.value = null
  selectedPath.value = ''
  detail.value = null
  detailLoading.value = false
  detailError.value = null
}

watch(
  () => uiState.filesOpen,
  (open) => {
    if (!open) return
    reset()
    void load('')
  },
)

watch(
  () => appState.activeProfileId,
  () => {
    if (!uiState.filesOpen) return
    reset()
    void load('')
  },
)
</script>

<template>
  <NDrawer v-model:show="show" width="min(1080px, 94vw)" placement="right">
    <NDrawerContent :title="$t('文件管理 · 原始段文件')" closable>
      <div class="body">
        <div class="head">
          <div class="head-main">
            <div class="breadcrumbs" :aria-label="$t('目录路径')">
              <button
                type="button"
                class="crumb"
                :class="{ current: dir === '' }"
                @click="navigate('')"
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M3.4 6.3h6.1l1.8 2.1h9.3v9.9a1.8 1.8 0 0 1-1.8 1.8H5.2a1.8 1.8 0 0 1-1.8-1.8V6.3Z"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linejoin="round"
                  />
                  <path
                    d="M3.4 8.4h17.2"
                    stroke="currentColor"
                    stroke-width="1.5"
                  />
                </svg>
                {{ $t("存储根") }}
              </button>
              <template v-for="(p, i) in parts" :key="i">
                <span class="sep">/</span>
                <button
                  type="button"
                  class="crumb"
                  :class="{ current: i === parts.length - 1 }"
                  :title="prefixAt(i)"
                  @click="navigate(prefixAt(i))"
                >
                  {{ p }}
                </button>
              </template>
            </div>
            <div class="chips">
              <span class="chip">{{ dirCount }} {{ $t("目录") }}</span>
              <span class="chip">{{ fileCount }} {{ $t("文件") }}</span>
              <span v-if="segmentCount > 0" class="chip accent">
                {{ segmentCount }} {{ $t("段") }}
              </span>
              <span class="chip">{{ profileName }}</span>
              <span v-if="isAdmin" class="chip ok">admin</span>
              <span v-if="readOnly" class="chip warn">{{ $t("只读连接") }}</span>
            </div>
          </div>
          <div class="head-actions">
            <NButton
              size="small"
              secondary
              :disabled="dir === '' || loading"
              @click="goUp"
            >
              {{ $t("上一级") }}
            </NButton>
            <NButton size="small" :loading="loading" @click="refresh">{{ $t("刷新") }}</NButton>
          </div>
        </div>

        <div class="mounts">
          <span class="mount-label">{{ $t("挂载") }}</span>
          <button
            v-for="m in mounts"
            :key="m.name"
            type="button"
            class="mount"
            :class="{ active: mountActive(m.name) }"
            :title="m.isDefault ? $t('默认库（路径不剥 default）') : $t('挂载库')"
            @click="navigate(m.name)"
          >
            <span class="mount-name">{{ m.name }}</span>
            <span v-if="m.isDefault" class="mount-default">default</span>
          </button>
          <span v-if="mounts.length === 0 && !loading" class="mount-empty">
            {{ $t("当前身份没有可见挂载") }}
          </span>
          <span class="mount-hint">
            {{ $t("路径即语义：&lt;根&gt;/&lt;库&gt;/&lt;表&gt;/&lt;分区&gt;/seg_*.parquet") }}
          </span>
        </div>

        <div v-if="error" class="error-box">
          <div class="err-head">
            <span class="code-badge">{{ error.code ?? error.kind }}</span>
            <span v-if="error.status" class="status">HTTP {{ error.status }}</span>
            <span class="spacer" />
            <NButton size="tiny" secondary @click="refresh">{{ $t("重试") }}</NButton>
          </div>
          <div class="err-msg">{{ error.message }}</div>
          <div class="err-hint">{{ errorHint(error) }}</div>
        </div>

        <div v-else class="workspace">
          <section class="list-pane">
            <div class="frow fhead">
              <span class="c-name">{{ $t("名称") }}</span>
              <span class="c-kind">{{ $t("类型") }}</span>
              <span class="c-size">{{ $t("大小") }}</span>
              <span class="c-rows">{{ $t("行数") }}</span>
              <span class="c-ref">{{ $t("引用") }}</span>
            </div>
            <div class="fscroll">
              <div v-if="loading && !listing" class="empty-inline">
                {{ $t("正在读取目录…") }}
              </div>
              <div v-else-if="entries.length === 0" class="empty-inline">
                <strong>{{ $t("这个目录是空的") }}</strong>
                <span>
                  {{ $t("没有子目录或文件。段文件（seg_*.parquet）会显示行数、字节与\n                  manifest 引用状态。") }}
                </span>
              </div>
              <div
                v-for="e in entries"
                :key="e.name + (e.isDir ? '/d' : '/f')"
                class="frow entry"
                :class="{
                  selected: !e.isDir && entryPath(e) === selectedPath,
                  dir: e.isDir,
                }"
                role="button"
                tabindex="0"
                :title="entryPath(e)"
                @click="onEntry(e)"
                @dblclick="onEntryDblClick(e)"
                @keydown.enter.prevent="onEntry(e)"
                @keydown.space.prevent="onEntry(e)"
              >
                <span class="c-name">
                  <svg v-if="e.isDir" class="icon dir-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M3.4 6.3h6.1l1.8 2.1h9.3v9.9a1.8 1.8 0 0 1-1.8 1.8H5.2a1.8 1.8 0 0 1-1.8-1.8V6.3Z"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linejoin="round"
                    />
                  </svg>
                  <svg v-else class="icon file-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M6 3.3h7.4L19 8.9v11.8H6V3.3Z"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linejoin="round"
                    />
                    <path
                      d="M13.4 3.4v5.6H19"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linejoin="round"
                    />
                  </svg>
                  <span class="name-text">{{ e.name }}</span>
                  <span v-if="e.isDir" class="chevron">›</span>
                </span>
                <span class="c-kind">
                  <span class="kind-badge" :class="kindClass(entryKind(e))">
                    {{ kindLabel(entryKind(e)) }}
                  </span>
                </span>
                <span class="c-size mono">
                  {{ e.isDir ? '—' : formatBytes(e.size) }}
                </span>
                <span class="c-rows mono">
                  {{ e.segment?.rows === null || e.segment?.rows === undefined ? '—' : formatCount(e.segment.rows) }}
                </span>
                <span class="c-ref">
                  <span
                    v-if="e.segment"
                    class="ref-badge"
                    :class="refClass(e)"
                    :title="
                      e.segment.referenced === true
                        ? $t('被存活 manifest 引用（不可删除）')
                        : e.segment.referenced === false
                          ? $t('孤儿段（可移入回收站）')
                          : $t('manifest 缺失/损坏：引用未知（未知 ≠ 未引用）')
                    "
                  >
                    {{ refLabel(e) }}
                  </span>
                  <span v-else class="muted">—</span>
                </span>
              </div>
            </div>
            <div class="list-foot">
              <span>{{ $t("目录优先、名字序；只读取一层。") }}</span>
              <span v-if="listing" class="mono">{{ listing.dir || $t('（存储根）') }}</span>
            </div>
          </section>

          <aside class="detail-pane">
            <div v-if="detailLoading" class="detail-empty">
              <strong>{{ $t("正在读取详情…") }}</strong>
              <span class="mono">{{ selectedPath }}</span>
            </div>

            <div v-else-if="detailError" class="detail-empty">
              <div class="error-box">
                <div class="err-head">
                  <span class="code-badge">{{ detailError.code ?? detailError.kind }}</span>
                  <span class="spacer" />
                  <NButton size="tiny" secondary @click="retryDetail">{{ $t("重试") }}</NButton>
                </div>
                <div class="err-msg">{{ detailError.message }}</div>
                <div class="err-hint">{{ errorHint(detailError) }}</div>
              </div>
            </div>

            <div v-else-if="!detail" class="detail-empty">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M6 3.3h7.4L19 8.9v11.8H6V3.3Z"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linejoin="round"
                />
                <path d="M13.4 3.4v5.6H19" stroke="currentColor" stroke-width="1.3" />
              </svg>
              <strong>{{ $t("选择一个文件查看详情") }}</strong>
              <span>
                {{ $t("段文件会显示归属库/表/分区、manifest 列统计（min/max/NULL）、\n                单文件预览 SQL 与下载/回收站动作。双击文件可直接预览。") }}
              </span>
            </div>

            <template v-else>
              <div class="detail-head">
                <div class="detail-title" :title="detail.path">{{ detail.name }}</div>
                <div class="detail-path mono">{{ detail.path }}</div>
                <div class="chips">
                  <span class="kind-badge" :class="kindClass(detail.kind)">
                    {{ kindLabel(detail.kind) }}
                  </span>
                  <span class="chip">{{ formatBytes(detail.size) }}</span>
                  <span class="chip">{{ formatDateTime(detail.modifiedMs) }}</span>
                  <span class="chip" :class="readOnly ? 'warn' : ''">{{ profileName }}</span>
                </div>
              </div>

              <div class="own">
                <div class="own-item">
                  <span class="k">{{ $t("归属库") }}</span>
                  <span class="v mono">{{ detail.db }}</span>
                </div>
                <div class="own-item">
                  <span class="k">{{ $t("表") }}</span>
                  <span class="v mono">{{ detail.table ?? '—' }}</span>
                </div>
                <div class="own-item">
                  <span class="k">{{ $t("分区") }}</span>
                  <span class="v mono">{{ detail.partition ?? '—' }}</span>
                </div>
              </div>

              <div v-if="detail.isDir && detail.summary" class="section">
                <div class="sec-title">{{ $t("目录浅层汇总") }}</div>
                <div class="stat-grid">
                  <div class="stat">
                    <span class="k">{{ $t("子目录") }}</span>
                    <span class="v mono">{{ formatCount(detail.summary.dirs) }}</span>
                  </div>
                  <div class="stat">
                    <span class="k">{{ $t("文件") }}</span>
                    <span class="v mono">{{ formatCount(detail.summary.files) }}</span>
                  </div>
                  <div class="stat">
                    <span class="k">{{ $t("合计字节") }}</span>
                    <span class="v mono">{{ formatBytes(detail.summary.bytes) }}</span>
                  </div>
                </div>
              </div>

              <div v-if="detail.segment" class="section">
                <div class="sec-title">
                  {{ $t("段摘要") }}
                  <span class="ref-badge" :class="detailRefClass(detail.segment.referenced)">
                    {{ detailRefLabel(detail.segment.referenced) }}
                  </span>
                </div>
                <div class="stat-grid">
                  <div class="stat">
                    <span class="k">{{ $t("行数") }}</span>
                    <span class="v mono">{{ formatCount(detail.segment.rows) }}</span>
                  </div>
                  <div class="stat">
                    <span class="k">{{ $t("落盘字节") }}</span>
                    <span class="v mono">{{ formatBytes(detail.segment.bytes) }}</span>
                  </div>
                  <div class="stat">
                    <span class="k">generation</span>
                    <span class="v mono">{{ detail.segment.generation ?? '—' }}</span>
                  </div>
                  <div class="stat">
                    <span class="k">{{ $t("创建时间") }}</span>
                    <span class="v mono">
                      {{ detail.segment.createdAtMs === null ? '—' : formatDateTime(detail.segment.createdAtMs) }}
                    </span>
                  </div>
                </div>

                <div class="sub-title">{{ $t("列统计（manifest 内嵌，不读 parquet）") }}</div>
                <div v-if="detail.segment.columns.length > 0" class="cols">
                  <div class="col-row col-head">
                    <span>{{ $t("列") }}</span>
                    <span>min</span>
                    <span>max</span>
                    <span class="num">NULL</span>
                  </div>
                  <div
                    v-for="c in detail.segment.columns"
                    :key="c.name"
                    class="col-row"
                  >
                    <span class="mono col-name" :title="c.name">{{ c.name }}</span>
                    <span class="mono col-val" :title="c.min ?? 'NULL'">{{ c.min ?? 'NULL' }}</span>
                    <span class="mono col-val" :title="c.max ?? 'NULL'">{{ c.max ?? 'NULL' }}</span>
                    <span class="mono num">{{ formatCount(c.nullCount) }}</span>
                  </div>
                </div>
                <div v-else class="note">
                  {{ $t("该段没有列统计（孤儿段或旧 manifest）。未知不补造数据。") }}
                </div>
              </div>

              <div v-if="detail.manifest" class="section">
                <div class="sec-title">manifest</div>
                <div class="stat-grid">
                  <div class="stat">
                    <span class="k">generation</span>
                    <span class="v mono">{{ detail.manifest.generation }}</span>
                  </div>
                  <div class="stat">
                    <span class="k">{{ $t("分区行数") }}</span>
                    <span class="v mono">{{ formatCount(detail.manifest.rows) }}</span>
                  </div>
                  <div class="stat">
                    <span class="k">{{ $t("段数") }}</span>
                    <span class="v mono">{{ detail.manifest.segments }}</span>
                  </div>
                  <div class="stat">
                    <span class="k">{{ $t("格式版本") }}</span>
                    <span class="v mono">{{ detail.manifest.version }}</span>
                  </div>
                </div>
                <div v-if="detail.manifest.partitionValues.length > 0" class="pv">
                  <span
                    v-for="(pv, i) in detail.manifest.partitionValues"
                    :key="i"
                    class="chip"
                  >
                    {{ pv[0] }} = {{ pv[1] }}
                  </span>
                </div>
              </div>

              <div v-if="detail.tableDef" class="section">
                <div class="sec-title">{{ $t("table.json（原样）") }}</div>
                <pre class="json-box">{{ tableDefJson }}</pre>
              </div>

              <div v-if="detail.readSql" class="section">
                <div class="sec-title">{{ $t("单文件预览 SQL") }}</div>
                <pre class="sql-box">{{ detail.readSql }}</pre>
                <div class="detail-actions">
                  <NButton size="small" type="primary" @click="previewFile">
                    {{ $t("预览此文件") }}
                  </NButton>
                  <NButton size="small" secondary @click="openFileSql">
                    {{ $t("插入到编辑器") }}
                  </NButton>
                  <NButton size="small" quaternary @click="copyReadSql">
                    {{ $t("复制 SQL") }}
                  </NButton>
                </div>
              </div>
              <div v-else class="note">
                {{ $t("服务端未提供 readSql（远端库不支持本地文件预览）。权限由查询面\n                自己判定，Studio 不代查数据。") }}
              </div>

              <div class="section actions-section">
                <div class="detail-actions">
                  <NButton
                    size="small"
                    secondary
                    :loading="downloading"
                    :disabled="detail.isDir"
                    @click="download"
                  >
                    {{ $t("下载文件") }}
                  </NButton>
                  <NButton
                    v-if="detail.kind === 'segment'"
                    size="small"
                    type="error"
                    secondary
                    :loading="trashing"
                    :disabled="!canTrash"
                    @click="askTrash"
                  >
                    {{ $t("移入回收站") }}
                  </NButton>
                </div>
                <div v-if="trashNote" class="note">{{ trashNote }}</div>
              </div>
            </template>
          </aside>
        </div>

        <div class="foot-note">
          {{ $t("文件面只读浏览不下载也能看到段的行数/字节与归属；删除恒为 admin 且只收\n          未引用的") }} <span class="mono">seg_*.parquet</span>{{ $t("（被引用段 409\n          SEGMENT_REFERENCED）。非 admin 的根目录是虚拟视图：只显示自己有 grant 的挂载。") }}
        </div>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 11px;
  height: 100%;
  min-height: 0;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  justify-content: space-between;
}

.head-main {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}

.breadcrumbs {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  flex-wrap: wrap;
}

.crumb {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
  padding: 3px 7px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11.5px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    color 0.16s ease,
    background 0.16s ease,
    border-color 0.16s ease;
}

.crumb:hover {
  color: var(--text);
  background: var(--hover);
}

.crumb.current {
  color: var(--text);
  background: var(--surface-soft);
  border-color: var(--border);
}

.crumb svg {
  width: 14px;
  height: 14px;
  flex: none;
}

.sep {
  color: var(--muted);
  font-size: 11px;
  opacity: 0.6;
}

.chips {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.chip.accent {
  background: var(--accent-soft);
  border-color: var(--accent-border);
  color: var(--accent-strong);
}

.head-actions {
  display: flex;
  gap: 6px;
  flex: none;
}

.mounts {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-soft);
}

.mount-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.mount {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 23px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-raised);
  color: var(--text-soft);
  font-family: var(--mono);
  font-size: 11px;
  cursor: pointer;
  transition:
    border-color 0.16s ease,
    background 0.16s ease,
    color 0.16s ease,
    transform 0.16s ease;
}

.mount:hover {
  border-color: var(--accent-border);
  color: var(--text);
  transform: translateY(-1px);
}

.mount.active {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.mount-default {
  padding: 0 4px;
  border-radius: 5px;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 9px;
}

.mount-empty {
  color: var(--muted);
  font-size: 11px;
}

.mount-hint {
  margin-left: auto;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.workspace {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 11px;
}

.list-pane {
  flex: 1.15;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-soft);
  overflow: hidden;
}

.frow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 76px 86px 76px 64px;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  min-height: 33px;
  border-bottom: 1px solid var(--row-line);
  font-size: 12px;
}

.fhead {
  position: sticky;
  top: 0;
  z-index: 1;
  min-height: 30px;
  background: var(--surface-raised);
  border-bottom: 1px solid var(--border-strong);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}

.fscroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.entry {
  cursor: pointer;
  color: var(--text-soft);
  transition:
    background 0.14s ease,
    box-shadow 0.14s ease;
}

.entry:last-child {
  border-bottom: none;
}

.entry:hover {
  background: var(--hover);
  color: var(--text);
}

.entry:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}

.entry.selected {
  background: var(--accent-soft);
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--accent);
}

.entry.dir .name-text {
  color: var(--text);
}

.c-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon {
  width: 14px;
  height: 14px;
  flex: none;
}

.dir-icon {
  color: var(--accent);
}

.file-icon {
  color: var(--muted);
}

.chevron {
  flex: none;
  margin-left: auto;
  color: var(--muted);
  font-size: 15px;
}

.c-kind,
.c-ref {
  display: flex;
  align-items: center;
}

.c-size,
.c-rows {
  display: flex;
  justify-content: flex-end;
  color: var(--text-soft);
}

.kind-badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface-raised);
  color: var(--muted);
  font-size: 9.5px;
  font-weight: 650;
  white-space: nowrap;
}

.kind-badge.k-segment {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.kind-badge.k-manifest,
.kind-badge.k-tabledef {
  border-color: var(--warn-border);
  background: var(--warn-soft);
  color: var(--warn);
}

.ref-badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-raised);
  color: var(--muted);
  font-size: 9.5px;
  font-weight: 650;
  white-space: nowrap;
}

.ref-badge.ok {
  border-color: var(--ok-border);
  background: var(--ok-soft);
  color: var(--ok);
}

.ref-badge.warn {
  border-color: var(--warn-border);
  background: var(--warn-soft);
  color: var(--warn);
}

.empty-inline {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 26px 18px;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.6;
  text-align: center;
}

.empty-inline strong {
  color: var(--text-soft);
  font-size: 12.5px;
  font-weight: 600;
}

.list-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  background: var(--surface-raised);
  color: var(--muted);
  font-size: 10px;
}

.list-foot .mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-pane {
  flex: 0 0 42%;
  min-width: 300px;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-soft);
  padding: 12px;
}

.detail-empty {
  height: 100%;
  min-height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--muted);
  text-align: center;
  font-size: 11.5px;
  line-height: 1.6;
  padding: 16px;
}

.detail-empty svg {
  width: 34px;
  height: 34px;
  opacity: 0.45;
  margin-bottom: 3px;
}

.detail-empty strong {
  color: var(--text-soft);
  font-size: 12.5px;
}

.detail-empty .mono {
  word-break: break-all;
  font-size: 10px;
}

.detail-head {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}

.detail-title {
  font-size: 14.5px;
  font-weight: 720;
  letter-spacing: -0.01em;
  color: var(--text);
  word-break: break-all;
}

.detail-path {
  font-size: 10.5px;
  color: var(--muted);
  word-break: break-all;
}

.own {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}

.own-item,
.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.own-item .k,
.stat .k {
  font-size: 9.5px;
  color: var(--muted);
  letter-spacing: 0.03em;
}

.own-item .v,
.stat .v {
  font-size: 11.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 11px 0;
  border-bottom: 1px solid var(--border);
}

.sec-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-soft);
  text-transform: uppercase;
}

.sub-title {
  margin-top: 3px;
  font-size: 10.5px;
  font-weight: 650;
  color: var(--muted);
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 7px;
}

.stat {
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-raised);
}

.cols {
  max-height: 240px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-raised);
}

.col-row {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1fr) 58px;
  gap: 7px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--row-line);
  font-size: 10.5px;
  color: var(--text-soft);
}

.col-row:last-child {
  border-bottom: none;
}

.col-head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface-soft);
  border-bottom-color: var(--border-strong);
  color: var(--muted);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.col-name,
.col-val {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.num {
  text-align: right;
}

.pv {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.json-box,
.sql-box {
  margin: 0;
  padding: 8px 9px;
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--code-bg);
  color: var(--code-text);
  font-family: var(--mono);
  font-size: 10.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
}

.sql-box {
  max-height: 150px;
}

.detail-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.actions-section {
  border-bottom: none;
  padding-bottom: 0;
}

.note {
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--muted);
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

.status {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--danger);
}

.spacer {
  flex: 1;
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

.foot-note {
  flex: none;
  border-top: 1px solid var(--border);
  padding-top: 9px;
  color: var(--muted);
  font-size: 10.5px;
  line-height: 1.6;
}

@media (max-width: 980px) {
  .workspace {
    flex-direction: column;
    overflow: auto;
  }

  .list-pane {
    flex: 0 0 320px;
    min-height: 320px;
  }

  .detail-pane {
    flex: 1 0 auto;
    min-width: 0;
    overflow: visible;
  }

  .mount-hint {
    display: none;
  }
}
</style>
