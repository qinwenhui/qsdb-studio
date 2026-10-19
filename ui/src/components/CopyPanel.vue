<script setup lang="ts">
import { save } from '@tauri-apps/plugin-dialog'
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NInput,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSwitch,
  useMessage,
} from 'naive-ui'
import { computed, ref, watch } from 'vue'
import * as ipc from '../ipc'
import type { CopyFormat, CopyInput, CopyResult, StudioError } from '../ipc/types'
import { appState, baseQueryOptions, toStudioError } from '../stores/app'
import { runSql } from '../stores/query'
import { uiState } from '../stores/ui'
import { activeSql, editorForProfile } from '../stores/workspace'
import {
  copyDownloadPath,
  inferCopyDatabase,
  isAbsoluteServerPath,
  type CopyDbReason,
} from '../utils/copy'
import {
  addRecentTarget,
  loadRecentTargets,
  recentTargetValue,
  saveRecentTargets,
  type RecentCopyTarget,
} from '../utils/copyTargets'
import { errorHint } from '../utils/errors'
import { formatBytes, formatMs } from '../utils/format'

import { t, tt } from '../i18n'

const message = useMessage()

const show = computed({
  get: () => uiState.copyOpen,
  set: (v: boolean) => {
    uiState.copyOpen = v
  },
})

const query = ref('')
const target = ref('')
const format = ref<CopyFormat>('parquet')
const partitionBy = ref<string[]>([])
const header = ref(true)

const previewSql = ref('')
const previewError = ref<StudioError | null>(null)
const building = ref(false)
/** 打开向导时快照的连接：多标签下切走标签也不改变导出目标。 */
const boundProfileId = ref<string | null>(null)
/** 打开时快照的挂载库/会话默认库，用于推断 COPY 的执行库。 */
const boundDbs = ref<string[]>([])
const boundSessionDb = ref('default')
/** 本次执行时的执行库（推断值，仅用于下载路径提示）。 */
const lastExecDb = ref<string | null>(null)
/** 本次执行的目标是否为绝对路径（相对目标的 SQL 读回依赖服务端 CWD）。 */
const lastTargetAbsolute = ref(false)
const running = ref(false)
const result = ref<CopyResult | null>(null)
const error = ref<StudioError | null>(null)
const downloadPath = ref('')
const downloading = ref(false)

const recentTargets = ref<RecentCopyTarget[]>([])
const recentPick = ref<string | null>(null)

/** 失败时的现场快照：用户之后改输入不影响定位信息。 */
interface CopyFailure {
  target: string
  format: CopyFormat
  absolute: boolean
  database: string | null
  reason: CopyDbReason
  partitioned: boolean
  downloadPath: string
  sql: string
}

const failure = ref<CopyFailure | null>(null)

const inference = computed(() =>
  inferCopyDatabase(query.value, boundDbs.value, boundSessionDb.value),
)
const targetAbsolute = computed(() => isAbsoluteServerPath(target.value))

const recentOptions = computed(() =>
  recentTargets.value.map((r) => ({
    label: `${r.format === 'csv' ? 'CSV' : 'PARQUET'} · ${r.target}`,
    value: recentTargetValue(r),
  })),
)

function applyRecent(value: string | null) {
  if (!value) return
  const hit = recentTargets.value.find((r) => recentTargetValue(r) === value)
  recentPick.value = null
  if (!hit) return
  format.value = hit.format
  target.value = hit.target
}

function rememberTarget() {
  const t = target.value.trim()
  if (!t) return
  recentTargets.value = addRecentTarget(recentTargets.value, t, format.value, Date.now())
  saveRecentTargets(localStorage, recentTargets.value)
}

function clearRecent() {
  recentTargets.value = []
  recentPick.value = null
  saveRecentTargets(localStorage, [])
}

async function copyText(text: string, label: string) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    message.success(tt`${label}已复制`)
  } catch {
    message.error(t('复制失败（剪贴板不可用）'))
  }
}

let previewTimer: number | undefined

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`
}

function defaultTarget(fmt: CopyFormat): string {
  const base = `qsdb-export-${stamp()}`
  // Parquet 会创建目标目录；CSV 不会创建父目录（内核写临时文件前不 mkdir），
  // 因此 CSV 默认放在库根，避免默认值一上来就失败。
  return fmt === 'csv' ? `${base}.csv` : `exports/${base}`
}

const partitionOptions = computed(() => {
  const seen = new Set<string>()
  const out: { label: string; value: string }[] = []
  for (const t of appState.tables) {
    for (const c of t.columns) {
      const k = c.name.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ label: c.name, value: c.name })
    }
  }
  return out
})

function input(): CopyInput {
  return {
    query: query.value,
    target: target.value,
    format: format.value,
    partitionBy: format.value === 'parquet' ? partitionBy.value : [],
    header: header.value,
  }
}

async function buildPreview() {
  building.value = true
  try {
    previewSql.value = await ipc.copyBuildSql(input())
    previewError.value = null
  } catch (e) {
    previewSql.value = ''
    previewError.value = toStudioError(e)
  } finally {
    building.value = false
  }
}

function schedulePreview() {
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(() => void buildPreview(), 300)
}

watch(
  () => uiState.copyOpen,
  (open) => {
    if (!open) return
    boundProfileId.value = appState.activeProfileId
    boundDbs.value = appState.databases.map((d) => d.name)
    boundSessionDb.value = appState.session?.defaultDb ?? appState.defaultDb ?? 'default'
    lastExecDb.value = null
    query.value = activeSql.value.trim()
    format.value = 'parquet'
    partitionBy.value = []
    header.value = true
    result.value = null
    error.value = null
    previewError.value = null
    downloadPath.value = ''
    failure.value = null
    recentPick.value = null
    recentTargets.value = loadRecentTargets(localStorage)
    target.value = defaultTarget('parquet')
    void buildPreview()
  },
)

watch([query, target, format, partitionBy, header], schedulePreview, { deep: true })

watch(format, (f) => {
  if (f === 'csv') {
    partitionBy.value = []
  }
  if (!target.value.trim() || /^(?:exports\/)?qsdb-export-/.test(target.value)) {
    target.value = defaultTarget(f)
  } else if (f === 'csv' && !target.value.toLowerCase().endsWith('.csv')) {
    target.value += '.csv'
  } else if (f === 'parquet') {
    target.value = target.value.replace(/\.csv$/i, '')
  }
})

async function execute() {
  const id = boundProfileId.value ?? appState.activeProfileId
  if (!id) {
    message.warning(t('尚未连接 QSDB 实例'))
    return
  }
  running.value = true
  result.value = null
  error.value = null
  failure.value = null
  const db = inference.value.db
  const reason = inference.value.reason
  const absolute = targetAbsolute.value
  const targetNow = target.value.trim()
  const fmt = format.value
  const partitioned = fmt === 'parquet' && partitionBy.value.length > 0
  let executedSql = previewSql.value
  try {
    executedSql = await ipc.copyBuildSql(input())
  } catch {
    // 预览失败不阻止执行：copy_to 会在服务端前给出同样的 usage 错误。
  }
  try {
    const r = await ipc.copyTo(id, input())
    result.value = r
    lastExecDb.value = db
    lastTargetAbsolute.value = absolute
    previewSql.value = r.sql
    previewError.value = null
    if (r.message) message.success(r.message, { duration: 7000 })
    downloadPath.value = copyDownloadPath(targetNow, fmt, partitioned, db)
    rememberTarget()
  } catch (e) {
    error.value = toStudioError(e)
    failure.value = {
      target: targetNow,
      format: fmt,
      absolute,
      database: db,
      reason,
      partitioned,
      downloadPath: copyDownloadPath(targetNow, fmt, partitioned, db),
      sql: executedSql,
    }
  } finally {
    running.value = false
  }
}

async function verifyReadback() {
  const r = result.value
  if (!r) return
  const pid = boundProfileId.value ?? appState.activeProfileId
  if (!pid) {
    message.warning(t('当前向导没有绑定连接'))
    return
  }
  const tab = editorForProfile(pid)
  uiState.copyOpen = false
  // COPY 的相对目标落在**执行库根**；读回也必须在该库执行，
  // 否则 read_csv/read_parquet 会按当前会话默认库解析路径而 404。
  const opts = { ...baseQueryOptions() }
  if (lastExecDb.value) opts.database = lastExecDb.value
  await runSql(tab.key, pid, r.verifySql, opts, {
    stream: false,
    title: lastExecDb.value
      ? tt`COPY 读回验证 · ${lastExecDb.value}`
      : t('COPY 读回验证'),
  })
}

async function download() {
  const id = boundProfileId.value ?? appState.activeProfileId
  if (!id) return
  const server = downloadPath.value.trim()
  if (!server) {
    message.warning(
      t('请填写服务端文件路径（default 库用库根内相对路径；其他挂载以 <库名>/ 开头）'),
    )
    return
  }
  const base = server.split('/').pop() || 'export.bin'
  const local = await save({
    title: t('保存服务端文件'),
    defaultPath: base,
  })
  if (!local) return
  downloading.value = true
  try {
    const n = await ipc.downloadFile(id, server, local)
    message.success(tt`已下载 ${formatBytes(n)} → ${local}`)
  } catch (e) {
    const info = toStudioError(e)
    message.error(`${info.code ?? info.kind}: ${info.message}`, { duration: 7000 })
  } finally {
    downloading.value = false
  }
}

function copySql() {
  void copyText(previewSql.value, 'COPY SQL')
}
</script>

<template>
  <NDrawer v-model:show="show" :width="760" placement="right">
    <NDrawerContent :title="$t('COPY 导出')" closable>
      <div class="body">
        <div class="hint">
          {{ $t("COPY 是") }} <b>{{ $t("admin 专属") }}</b>{{ $t("。Parquet 的目标是目录（产出 part-*.parquet，\n          可 PARTITION_BY）；CSV 是单文件且不支持 PARTITION_BY。目标路径在服务端（按服务端路径规则）。") }}
        </div>

        <div class="field">
          <div class="label">{{ $t("源查询（单条 SELECT）") }}</div>
          <NInput
            v-model:value="query"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
            class="mono-input"
            placeholder="SELECT ... FROM ..."
          />
        </div>

        <div class="grid2">
          <div class="field">
            <div class="label">{{ $t("目标路径（服务端）") }}</div>
            <NInput v-model:value="target" class="mono-input" />
            <div v-if="recentOptions.length > 0" class="recent-row">
              <NSelect
                v-model:value="recentPick"
                size="tiny"
                class="recent-select"
                :options="recentOptions"
                :placeholder="$t('最近目标…')"
                @update:value="applyRecent"
              />
              <NButton size="tiny" quaternary @click="clearRecent">{{ $t("清空记录") }}</NButton>
            </div>
            <div class="hint">
              {{
                format === 'parquet'
                  ? $t('Parquet 目标必须是目录（去掉 .parquet；会自动创建）')
                  : $t('CSV 目标是一个文件（建议 .csv；父目录必须已存在）')
              }}
              {{ $t("相对路径按") }}<b>{{ $t("执行库根") }}</b>{{ $t("解析（TO 'exp' ⇒ 该库根/exp）；绝对路径照 PG 语义。") }}
            </div>
            <div class="hint" :class="{ warn: inference.reason === 'multiple' }">
              <template v-if="inference.reason === 'qualified'">
                {{ $t("预计执行库") }} <b>{{ inference.db }}</b>{{ $t("（来自查询里的库限定名）") }}
              </template>
              <template v-else-if="inference.reason === 'session'">
                {{ $t("预计执行库") }} <b>{{ inference.db }}</b>{{ $t("（未限定表按会话默认库）") }}
              </template>
              <template v-else>
                {{ $t("查询里出现了多个库前缀，无法确定执行库；下载路径需手动加") }}
                <code>&lt;库名&gt;/</code> {{ $t("前缀。") }}
              </template>
            </div>
          </div>
          <div class="field">
            <div class="label">{{ $t("格式") }}</div>
            <NRadioGroup v-model:value="format" size="small">
              <NRadioButton value="parquet">PARQUET</NRadioButton>
              <NRadioButton value="csv">CSV</NRadioButton>
            </NRadioGroup>
            <label v-if="format === 'csv'" class="switch-row">
              <NSwitch v-model:value="header" size="small" />
              <span>{{ $t("写表头") }}</span>
            </label>
          </div>
        </div>

        <div class="field">
          <div class="label">PARTITION_BY（Parquet）</div>
          <NSelect
            v-model:value="partitionBy"
            multiple
            filterable
            clearable
            size="small"
            :options="partitionOptions"
            :disabled="format !== 'parquet'"
            :placeholder="$t('选择分区列（必须是查询输出里的列）')"
          />
          <div v-if="format === 'csv'" class="hint">{{ $t("CSV 不支持 PARTITION_BY（read_csv 没有 hive 目录语义）。") }}</div>
        </div>

        <div class="preview">
          <div class="preview-head">
            <span>{{ $t("生成的 COPY SQL") }}</span>
            <span class="spacer" />
            <NButton size="tiny" quaternary :loading="building" @click="buildPreview">{{ $t("刷新预览") }}</NButton>
            <NButton size="tiny" quaternary :disabled="!previewSql" @click="copySql">{{ $t("复制") }}</NButton>
          </div>
          <div v-if="previewError" class="err-msg">{{ previewError.message }}</div>
          <pre v-else class="sql mono">{{ previewSql || '—' }}</pre>
        </div>

        <div class="actions">
          <NButton size="small" type="primary" :loading="running" :disabled="!query.trim()" @click="execute">
            {{ $t("执行 COPY 导出") }}
          </NButton>
        </div>

        <div v-if="error" class="error-box">
          <div class="err-head">
            <span class="code-badge">{{ error.code ?? error.kind }}</span>
            <span v-if="error.status" class="status">HTTP {{ error.status }}</span>
            <span class="spacer" />
            <NButton v-if="failure" size="tiny" secondary @click="copyText(failure.sql, 'COPY SQL')">
              {{ $t("复制 SQL") }}
            </NButton>
          </div>
          <div class="err-msg">{{ error.message }}</div>
          <div class="err-hint">{{ errorHint(error) }}</div>
        </div>

        <div v-if="failure" class="failure-box">
          <div class="fail-title">{{ $t("失败定位（本次提交时的现场）") }}</div>
          <div class="fail-row">
            <span class="k">{{ $t("执行库") }}</span>
            <span v-if="failure.database" class="mono">{{ failure.database }}</span>
            <span v-else class="warn-text">{{ $t("无法确定（查询里出现多个库前缀）") }}</span>
            <span class="hint">
              {{
                failure.reason === 'qualified'
                  ? $t('来自查询里的库限定名')
                  : failure.reason === 'session'
                    ? $t('未限定表按会话默认库')
                    : $t('请改用单一库的查询，或手动填写下载路径')
              }}
            </span>
          </div>
          <div class="fail-row">
            <span class="k">{{ $t("目标") }}</span>
            <span class="mono path">{{ failure.target }}</span>
            <NButton size="tiny" quaternary @click="copyText(failure.target, $t('目标路径'))">{{ $t("复制") }}</NButton>
          </div>
          <div class="fail-row">
            <span class="k">{{ $t("路径语义") }}</span>
            <span v-if="failure.absolute">
              {{ $t("服务端绝对路径，按文件系统解析；不在") }} <code>/files</code> {{ $t("根内，不能用本面板下载。") }}
            </span>
            <span v-else>
              {{ $t("相对目标按") }}<b>{{ failure.database ?? $t('（未知）') }}</b> {{ $t("的库根解析；不是进程 CWD。") }}
            </span>
          </div>
          <div v-if="failure.downloadPath" class="fail-row">
            <span class="k">{{ $t("下载路径") }}</span>
            <span class="mono path">{{ failure.downloadPath }}</span>
            <NButton size="tiny" quaternary @click="copyText(failure.downloadPath, $t('下载路径'))">{{ $t("复制") }}</NButton>
          </div>
          <div class="fail-hints">
            <div v-if="failure.format === 'csv'">
              {{ $t("CSV 不自动创建父目录：确认") }} <span class="mono">{{ failure.target.replace(/[\\/][^\\/]*$/, '') || $t('（库根）') }}</span>
              {{ $t("在库根下已存在，或把目标改到库根内的文件名（如") }} <span class="mono">export.csv</span>）。
            </div>
            <div v-if="!failure.absolute">
              {{ $t("读回验证用相对路径时按服务端 CWD 解析，可能 404；可靠验证以") }}
              <code>/files</code> {{ $t("下载为准，或改用绝对目标。") }}
            </div>
            <div v-if="failure.partitioned">
              {{ $t("分区导出无法推断具体 part 文件：到") }}
              <span class="mono">{{ failure.target }}{{ $t("/&lt;分区&gt;/part-*.parquet") }}</span>
              {{ $t("下取具体文件后再下载。") }}
            </div>
          </div>
        </div>

        <div v-if="result" class="result">
          <div class="ok-box">
            <div class="ok-title">{{ $t("导出完成 ·") }} {{ formatMs(result.elapsedMs) }}</div>
            <div class="ok-line">{{ result.message }}</div>
            <div v-if="result.queryId" class="ok-line mono">queryId {{ result.queryId }}</div>
          </div>

          <div class="field">
            <div class="label">{{ $t("读回验证") }}</div>
            <div class="row">
              <NButton size="small" secondary @click="verifyReadback">{{ $t("在服务端读回 200 行") }}</NButton>
              <span class="hint mono">{{ result.verifySql }}</span>
            </div>
            <div v-if="!lastTargetAbsolute" class="hint warn">
              {{ $t("相对目标落在") }}<b>{{ $t("执行库根") }}</b>{{ $t("，而") }} <code>read_csv</code>/<code>read_parquet</code>
              {{ $t("的相对路径按服务端") }} <b>CWD</b> {{ $t("解析；两者不一致时读回会 404。\n              请以") }} <code>/files</code> {{ $t("下载的文件为准，或改用绝对目标。") }}
            </div>
          </div>

          <div class="field">
            <div class="label">{{ $t("下载服务端文件（admin）") }}</div>
            <div class="row">
              <NInput
                v-model:value="downloadPath"
                size="small"
                class="mono-input"
                :placeholder="$t('default 库填相对路径；其他挂载以 <库名>/ 开头')"
              />
              <NButton size="small" :loading="downloading" :disabled="!downloadPath" @click="download">
                {{ $t("选择本地位置并下载") }}
              </NButton>
            </div>
            <div class="hint">
              <template v-if="targetAbsolute">
                {{ $t("绝对目标不在") }} <code>/files</code> {{ $t("根内，不能用本面板下载（请到服务端本机取文件）。") }}
              </template>
              <template v-else>
                {{ $t("default 库用库根内相对路径本身；其他挂载要加") }} <code>&lt;库名&gt;/</code>
                {{ $t("前缀（如") }} <code>settle/exports/x</code>）。
                <span v-if="lastExecDb && lastExecDb !== 'default'">
                  {{ $t("已按执行库") }} <b>{{ lastExecDb }}</b> {{ $t("加前缀。") }}
                </span>
              </template>
              {{ $t("分区导出请填具体文件路径（如 exports/x/dt=2026-01-01/part-00000.parquet）；\n              服务端拒绝") }} <code>..</code> {{ $t("/ 绝对路径 / 内部目录。") }}
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
  gap: 13px;
  height: 100%;
  min-height: 0;
  overflow: auto;
}

.hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
}

.hint.warn {
  color: var(--warn);
}

.hint b {
  color: var(--text-soft);
  font-weight: 650;
}

.hint.warn b {
  color: var(--warn);
}

.hint code {
  font-family: var(--mono);
  font-size: 10.5px;
  padding: 0 3px;
  border-radius: 3px;
  background: var(--surface-soft);
  border: 1px solid var(--border-subtle);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}

.grid2 {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 12px;
}

.mono-input :deep(input),
.mono-input :deep(textarea) {
  font-family: var(--mono);
  font-size: 12px;
}

.switch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-soft);
  margin-top: 4px;
}

.recent-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.recent-select {
  flex: 1;
  min-width: 0;
}

.preview {
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-soft);
  overflow: hidden;
}

.preview-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}

.spacer {
  flex: 1;
}

.sql {
  margin: 0;
  padding: 9px 10px;
  max-height: 170px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-soft);
  white-space: pre-wrap;
  word-break: break-word;
}

.actions {
  display: flex;
  justify-content: flex-end;
}

.error-box {
  border: 1px solid var(--danger-border);
  background: var(--danger-soft);
  border-radius: 9px;
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

.failure-box {
  border: 1px solid var(--warn-border);
  background: var(--warn-soft);
  border-radius: 9px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fail-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--warn);
}

.fail-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-soft);
  line-height: 1.5;
}

.fail-row .k {
  flex: 0 0 64px;
  color: var(--muted);
  font-weight: 650;
}

.fail-row .path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.warn-text {
  color: var(--warn);
}

.fail-hints {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--warn);
  border-top: 1px solid var(--warn-border);
  padding-top: 6px;
  margin-top: 2px;
}

.fail-hints code {
  font-family: var(--mono);
  padding: 0 3px;
  border-radius: 3px;
  background: var(--surface-soft);
  border: 1px solid var(--border-subtle);
}

.result {
  display: flex;
  flex-direction: column;
  gap: 13px;
  border-top: 1px solid var(--border);
  padding-top: 13px;
}

.ok-box {
  border: 1px solid var(--ok-border);
  background: var(--ok-soft);
  border-radius: 9px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--ok);
}

.ok-title {
  font-weight: 700;
  font-size: 12.5px;
}

.ok-line {
  font-size: 11.5px;
  line-height: 1.5;
  word-break: break-word;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row .hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
