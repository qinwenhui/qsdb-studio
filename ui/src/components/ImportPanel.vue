<script setup lang="ts">
import { open } from '@tauri-apps/plugin-dialog'
import { Channel } from '@tauri-apps/api/core'
import { NButton, NDrawer, NDrawerContent, NSelect, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import * as ipc from '../ipc'
import type {
  CsvMapping,
  CsvPreview,
  CsvPreviewError,
  ImportProgress,
  ImportSummary,
  StudioError,
} from '../ipc/types'
import { appState, refreshMeta, toStudioError } from '../stores/app'
import { closeImport, importState } from '../stores/import'
import { notify } from '../stores/notifications'
import { errorHint } from '../utils/errors'
import { formatBytes, formatCount, formatMs } from '../utils/format'

import { t, tt } from '../i18n'

const message = useMessage()
const show = computed({
  get: () => importState.visible,
  set: (v: boolean) => {
    importState.visible = v
  },
})
const table = computed(() => importState.table)
const drawerTitle = computed(() =>
  table.value ? tt`导入 CSV · ${table.value.name}` : t('导入 CSV'),
)

const filePath = ref('')
const fileName = ref('')
const running = ref(false)
const progress = ref<ImportProgress | null>(null)
const summary = ref<ImportSummary | null>(null)
const error = ref<StudioError | null>(null)

/** 预览：前 100 行 + 映射 + 类型推断 + 样例校验。 */
const preview = ref<CsvPreview | null>(null)
const previewing = ref(false)
const previewError = ref<StudioError | null>(null)
/** 目标表列 → CSV 表头（null = 不映射）；首次预览前为空数组含义 = 自动映射。 */
const assignment = ref<Record<string, string | null>>({})
const mappingDirty = ref(false)
let mappingTimer: number | undefined
let previewSeq = 0

watch(
  () => importState.visible,
  (open) => {
    if (!open) return
    window.clearTimeout(mappingTimer)
    previewSeq += 1
    filePath.value = ''
    fileName.value = ''
    progress.value = null
    summary.value = null
    error.value = null
    running.value = false
    preview.value = null
    previewing.value = false
    previewError.value = null
    assignment.value = {}
    mappingDirty.value = false
  },
)

const pct = computed(() => {
  const p = progress.value
  if (!p || p.totalBytes <= 0) return 0
  return Math.min(100, Math.round((p.bytes / p.totalBytes) * 100))
})

const bytesText = computed(() => {
  const p = progress.value
  if (!p) return ''
  return `${formatBytes(p.bytes)} / ${formatBytes(p.totalBytes)}`
})

const hasUnsupported = computed(() =>
  (table.value?.columns ?? []).filter((c) => /INTERVAL/i.test(c.typeName)),
)

const headerOptions = computed(() =>
  (preview.value?.headers ?? []).map((h) => ({ label: h, value: h })),
)

/** 样例校验错误总数（各列计数之和；列表最多展示 50 条）。 */
const sampleErrorCount = computed(
  () => preview.value?.columns.reduce((n, c) => n + c.errorCount, 0) ?? 0,
)

const canImport = computed(
  () =>
    Boolean(filePath.value) &&
    Boolean(preview.value?.mappingComplete) &&
    sampleErrorCount.value === 0 &&
    hasUnsupported.value.length === 0 &&
    !running.value &&
    !mappingDirty.value &&
    !previewing.value,
)

function buildMapping(): CsvMapping[] {
  const t = table.value
  if (!t) return []
  // 首次预览发送空数组 = 按表头名自动映射。
  if (Object.keys(assignment.value).length === 0) return []
  return t.columns.map((c) => ({
    column: c.name,
    header: assignment.value[c.name] ?? null,
  }))
}

async function loadPreview() {
  const id = importState.profileId ?? appState.activeProfileId
  const t = table.value
  if (!id || !t || !filePath.value) return
  const seq = ++previewSeq
  previewing.value = true
  previewError.value = null
  try {
    const p = await ipc.csvPreview(id, t.name, filePath.value, buildMapping())
    if (seq !== previewSeq) return
    preview.value = p
    assignment.value = Object.fromEntries(
      p.columns.map((c) => [c.name, c.header] as [string, string | null]),
    )
    mappingDirty.value = false
  } catch (e) {
    if (seq !== previewSeq) return
    preview.value = null
    previewError.value = toStudioError(e)
    mappingDirty.value = false
  } finally {
    if (seq === previewSeq) previewing.value = false
  }
}

function schedulePreview() {
  window.clearTimeout(mappingTimer)
  mappingTimer = window.setTimeout(() => void loadPreview(), 250)
}

function setMapping(column: string, header: string | null) {
  assignment.value = { ...assignment.value, [column]: header ?? null }
  mappingDirty.value = true
  summary.value = null
  schedulePreview()
}

async function pickFile() {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  })
  if (typeof selected !== 'string') return
  window.clearTimeout(mappingTimer)
  previewSeq += 1
  filePath.value = selected
  fileName.value = selected.split(/[\\/]/).pop() ?? selected
  summary.value = null
  error.value = null
  progress.value = null
  preview.value = null
  previewError.value = null
  assignment.value = {}
  mappingDirty.value = true
  await loadPreview()
}

async function copyRecord(recordIndex: number) {
  if (!filePath.value) return
  try {
    const text = await ipc.csvReadRow(filePath.value, recordIndex)
    await navigator.clipboard.writeText(text)
    message.success(t('出错行已原样复制（CSV 转义保留）'))
  } catch (e) {
    const info = toStudioError(e)
    message.error(`${info.code ?? info.kind}: ${info.message}`, { duration: 8000 })
  }
}

function copyPreviewError(err: CsvPreviewError) {
  void copyRecord(err.recordIndex)
}

async function startImport() {
  const id = importState.profileId ?? appState.activeProfileId
  const target = table.value
  if (!id) {
    message.warning(t('尚未连接 QSDB 实例'))
    return
  }
  if (!target || !filePath.value || !canImport.value) return
  running.value = true
  summary.value = null
  error.value = null
  progress.value = { rows: 0, bytes: 0, totalBytes: 0 }
  const channel = new Channel<ImportProgress>()
  channel.onmessage = (p) => {
    progress.value = p
  }
  try {
    const s = await ipc.importCsv(id, target.name, filePath.value, buildMapping(), channel)
    summary.value = s
    message.success(tt`已导入 ${formatCount(s.rows)} 行（${s.batches} 批）`)
    notify({
      kind: 'success',
      title: t('CSV 导入完成'),
      detail: tt`${target.name} · ${formatCount(s.rows)} 行 · ${s.batches} 批 · ${fileName.value}`,
    })
    await refreshMeta(id)
  } catch (e) {
    error.value = toStudioError(e)
    message.error(`${error.value.code ?? error.value.kind}: ${error.value.message}`, {
      duration: 9000,
    })
    const d = error.value.details
    notify({
      kind: 'error',
      title: t('CSV 导入失败'),
      code: error.value.code ?? error.value.kind,
      detail: [
        `${target.name} · ${fileName.value}`,
        d ? tt`CSV 第 ${d.line} 行（记录 ${d.recordIndex}）· 列 ${d.column}` : '',
        error.value.message,
      ]
        .filter(Boolean)
        .join('\n'),
    })
  } finally {
    running.value = false
  }
}

function onMappingSelect(column: string, value: string | null) {
  setMapping(column, value)
}

function copyImportErrorRow() {
  const d = error.value?.details
  if (d) void copyRecord(d.recordIndex)
}
</script>

<template>
  <NDrawer v-model:show="show" :width="860" placement="right" @after-leave="closeImport">
    <NDrawerContent :title="drawerTitle" closable>
      <div class="body">
        <div class="hint">
          {{ $t("列类型以服务端") }} <span class="mono">/schema</span> {{ $t("为真相源；空串 = NULL，\n          错值会指到 CSV 行号与列名，绝不静默换类型。选择文件后会先读取") }}
          <b>{{ $t("前 100 行") }}</b>{{ $t("做类型推断与逐值校验，并允许调整列映射；写入走\n          bulk append（每 10,000 行一批）。") }}
          <b>{{ $t("导入是 append：同一文件重复导入会重复追加。") }}</b>
        </div>

        <div v-if="hasUnsupported.length > 0" class="warn-box">
          {{ $t("表含 INTERVAL 列：") }}
          <span class="mono">{{ hasUnsupported.map((c) => c.name).join(', ') }}</span>
          {{ $t("—— 当前 client 的 bulk 写侧没有 INTERVAL 变体，导入会在开始前显式拒绝。") }}
        </div>

        <div class="file-row">
          <NButton size="small" :disabled="running" @click="pickFile">{{ $t("选择 CSV 文件…") }}</NButton>
          <span v-if="fileName" class="file-name mono" :title="filePath">{{ fileName }}</span>
          <span v-else class="muted">{{ $t("需要一个带表头的 CSV；表头按列名（大小写不敏感）自动映射，可手动调整") }}</span>
        </div>

        <div v-if="previewing && !preview" class="empty-state">
          <strong>{{ $t("正在读取前 100 行…") }}</strong>
          <div class="sub">{{ $t("只读预览，不写任何数据。") }}</div>
        </div>

        <div v-if="previewError" class="error-box">
          <div class="err-head">
            <span class="code-badge">{{ previewError.code ?? previewError.kind }}</span>
            <span v-if="previewError.status" class="status">HTTP {{ previewError.status }}</span>
            <span class="spacer" />
            <NButton size="tiny" secondary @click="loadPreview">{{ $t("重新预览") }}</NButton>
          </div>
          <div class="err-msg">{{ previewError.message }}</div>
          <div class="err-hint">{{ errorHint(previewError) }}</div>
        </div>

        <template v-if="preview">
          <div class="prev-head">
            <span class="chip">{{ $t("预览") }} {{ preview.rowsPreviewed }} {{ $t("行") }}</span>
            <span class="chip">{{ formatBytes(preview.totalBytes) }}</span>
            <span v-if="preview.mappingComplete" class="chip ok">{{ $t("映射完整") }}</span>
            <span v-else class="chip warn">{{ $t("映射不完整") }}</span>
            <span v-if="sampleErrorCount > 0" class="chip danger">
              {{ sampleErrorCount }} {{ $t("个样例值不合法") }}
            </span>
            <span v-else class="chip ok">{{ $t("样例值通过") }}</span>
            <span v-if="previewing" class="hint">{{ $t("正在重新校验…") }}</span>
            <span class="spacer" />
            <NButton size="tiny" quaternary :loading="previewing" :disabled="running" @click="loadPreview">
              {{ $t("重新预览") }}
            </NButton>
          </div>

          <div v-if="preview.extras.length > 0" class="info-box">
            {{ $t("CSV 多出的列（不参与导入）：") }}
            <span class="mono">{{ preview.extras.join(', ') }}</span>
          </div>

          <div v-if="!preview.mappingComplete" class="warn-box">
            {{ $t("还有") }} {{ preview.missing.length }} {{ $t("个目标列没有唯一的 CSV 表头：") }}
            <span class="mono">{{ preview.missing.join(', ') }}</span>
            {{ $t("—— 在下方为每一列选择表头后才能导入。") }}
          </div>

          <div class="mapping">
            <div class="map-row map-head">
              <span>{{ $t("目标列") }}</span>
              <span>{{ $t("CSV 表头") }}</span>
              <span>{{ $t("推断类型") }}</span>
              <span>{{ $t("样例校验") }}</span>
            </div>
            <div v-for="c in preview.columns" :key="c.name" class="map-row">
              <span class="map-target">
                <span class="mono name">{{ c.name }}</span>
                <span class="mono type">{{ c.typeName }}</span>
                <span v-if="c.partition" class="chip mini part">{{ $t("分区") }}</span>
                <span v-if="c.nullable" class="chip mini">NULL</span>
              </span>
              <NSelect
                size="small"
                :value="assignment[c.name] ?? null"
                :options="headerOptions"
                clearable
                :placeholder="$t('不映射')"
                :disabled="running"
                @update:value="(v) => onMappingSelect(c.name, v)"
              />
              <span class="chip inferred">{{ c.inferred }}</span>
              <span v-if="c.errorCount > 0" class="chip danger">{{ c.errorCount }} {{ $t("个值不合法") }}</span>
              <span v-else class="chip ok">{{ $t("通过") }}</span>
              <div v-if="c.mappingError" class="map-err">{{ c.mappingError }}</div>
            </div>
          </div>

          <div class="grid-box">
            <div class="grid-head">
              <span>{{ $t("前") }} {{ preview.rowsPreviewed }} {{ $t("行") }}</span>
              <span class="hint">
                {{ $t("单元格超过 160 字符仅预览截断显示（带 …），导入使用完整值；空串按约定显示为 NULL。") }}
              </span>
            </div>
            <div class="grid-scroll">
              <div
                class="pgrid"
                :style="{
                  gridTemplateColumns: `52px repeat(${preview.columns.length}, minmax(120px, 1fr))`,
                }"
              >
                <div class="cell hcell">{{ $t("行") }}</div>
                <div v-for="c in preview.columns" :key="c.name" class="cell hcell" :title="c.header ?? ''">
                  <span class="mono">{{ c.name }}</span>
                  <span v-if="c.headerIndex === null" class="unmapped">{{ $t("未映射") }}</span>
                </div>
                <template v-for="row in preview.rows" :key="row.line">
                  <div class="cell line mono">{{ row.line }}</div>
                  <div
                    v-for="(c, ci) in preview.columns"
                    :key="`${row.line}-${c.name}`"
                    class="cell mono"
                  >
                    <span v-if="c.headerIndex === null" class="unmapped">—</span>
                    <span v-else-if="row.values[ci] === null" class="null">NULL</span>
                    <span v-else>{{ row.values[ci] }}</span>
                  </div>
                </template>
              </div>
            </div>
          </div>

          <div v-if="preview.sampleErrors.length > 0" class="errors-box">
            <div class="err-head">
              <span class="err-title">{{ $t("样例中有") }} {{ sampleErrorCount }} {{ $t("个值无法按目标类型解析") }}</span>
              <span class="spacer" />
              <span class="hint">{{ $t("最多列出前") }} {{ preview.sampleErrors.length }} {{ $t("条") }}</span>
            </div>
            <div
              v-for="(e, i) in preview.sampleErrors"
              :key="`${e.recordIndex}-${e.column}-${i}`"
              class="sample-err"
            >
              <span class="mono eline">{{ $t("第") }} {{ e.line }} {{ $t("行") }}</span>
              <span class="mono ecol">{{ e.column }}</span>
              <span class="mono evalue" :title="e.value">{{ e.value }}</span>
              <span class="emsg">{{ e.message }}</span>
              <NButton size="tiny" quaternary @click="copyPreviewError(e)">{{ $t("复制该行") }}</NButton>
            </div>
            <div class="hint">
              {{ $t("修正 CSV 后重新选择文件或点“重新预览”。样例不通过时导入会被禁用——\n              导入遇到第一个错值也会整体失败（此前已成功的批次不会回滚）。") }}
            </div>
          </div>
        </template>

        <div v-if="progress" class="progress-box">
          <div class="bar">
            <div class="bar-fill" :style="{ width: pct + '%' }" />
          </div>
          <div class="progress-meta">
            <span>{{ $t("已写入") }} {{ formatCount(progress.rows) }} {{ $t("行") }}</span>
            <span class="mono">{{ bytesText }}</span>
            <span v-if="running" class="chip mini">{{ $t("导入中") }}</span>
          </div>
        </div>

        <div v-if="summary" class="ok-box">
          <div class="ok-title">{{ $t("导入完成") }}</div>
          <div class="ok-line">
            {{ formatCount(summary.rows) }} {{ $t("行 ·") }} {{ summary.batches }} {{ $t("批 ·") }}
            {{ formatMs(summary.elapsedMs) }}
          </div>
          <div v-for="(w, i) in summary.warnings" :key="i" class="warn-line">· {{ w }}</div>
        </div>

        <div v-if="error" class="error-box">
          <div class="err-head">
            <span class="code-badge">{{ error.code ?? error.kind }}</span>
            <span v-if="error.status" class="status">HTTP {{ error.status }}</span>
            <span class="spacer" />
            <NButton
              v-if="error.details"
              size="tiny"
              secondary
              @click="copyImportErrorRow"
            >
              {{ $t("复制第") }} {{ error.details.line }} {{ $t("行") }}
            </NButton>
          </div>
          <div class="err-msg">{{ error.message }}</div>
          <div v-if="error.details" class="err-detail mono">
            {{ $t("定位：第") }} {{ error.details.line }} {{ $t("行（记录") }} {{ error.details.recordIndex + 1 }}{{ $t("） ·\n            列") }} {{ error.details.column }}
          </div>
          <div class="err-hint">{{ errorHint(error) }}</div>
        </div>

        <div class="actions">
          <span v-if="preview && !canImport && !running" class="hint left">
            {{
              hasUnsupported.length > 0
                ? $t('表含不支持的列类型，导入已禁用')
                : !preview.mappingComplete
                  ? $t('补齐列映射后才能导入')
                  : sampleErrorCount > 0
                    ? $t('样例值校验未通过，修正 CSV 后再导入')
                    : $t('正在校验映射…')
            }}
          </span>
          <NButton size="small" @click="closeImport">{{ $t("关闭") }}</NButton>
          <NButton
            size="small"
            type="primary"
            :disabled="!canImport"
            :loading="running"
            @click="startImport"
          >
            {{ $t("开始导入") }}
          </NButton>
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

.hint b {
  color: var(--text-soft);
}

.left {
  flex: 1;
  text-align: right;
}

.warn-box {
  border: 1px solid var(--warn-border);
  background: var(--warn-soft);
  color: var(--warn);
  border-radius: 8px;
  padding: 9px 10px;
  font-size: 11.5px;
  line-height: 1.55;
}

.info-box {
  border: 1px solid var(--border);
  background: var(--surface-soft);
  color: var(--text-soft);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.55;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.file-name {
  font-size: 11.5px;
  color: var(--text-soft);
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.muted {
  color: var(--muted);
  font-size: 11.5px;
}

.prev-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.spacer {
  flex: 1;
}

.mapping {
  border: 1px solid var(--border);
  border-radius: 9px;
  overflow: hidden;
}

.map-row {
  display: grid;
  grid-template-columns: minmax(170px, 1.2fr) minmax(190px, 1.4fr) 90px 118px;
  gap: 8px;
  align-items: center;
  padding: 6px 10px;
  border-bottom: 1px solid var(--row-line);
  font-size: 11.5px;
}

.map-row:last-child {
  border-bottom: none;
}

.map-head {
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.map-target {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.name {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.type {
  color: var(--muted);
  font-size: 10.5px;
}

.chip.mini {
  height: 17px;
  font-size: 10px;
  padding: 0 5px;
}

.chip.part {
  background: var(--warn-soft);
  border-color: var(--warn-border);
  color: var(--warn);
}

.chip.inferred {
  justify-self: start;
}

.chip.danger {
  justify-self: start;
  background: var(--danger-soft);
  border-color: var(--danger-border);
  color: var(--danger);
}

.map-err {
  grid-column: 1 / -1;
  color: var(--warn);
  font-size: 10.5px;
  line-height: 1.4;
  padding-bottom: 2px;
}

.grid-box {
  border: 1px solid var(--border);
  border-radius: 9px;
  overflow: hidden;
}

.grid-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
}

.grid-head .hint {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  flex: 1;
  text-align: right;
}

.grid-scroll {
  max-height: 240px;
  overflow: auto;
}

.pgrid {
  display: grid;
  min-width: max-content;
}

.cell {
  padding: 4px 8px;
  border-bottom: 1px solid var(--row-line);
  border-right: 1px solid var(--row-line);
  font-size: 11px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-all;
  max-width: 260px;
}

.hcell {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 10.5px;
  display: flex;
  align-items: center;
  gap: 5px;
}

.line {
  color: var(--muted);
  background: var(--panel-soft);
}

.null {
  color: var(--muted);
  font-style: italic;
}

.unmapped {
  color: var(--warn);
  font-size: 10px;
}

.errors-box {
  border: 1px solid var(--danger-border);
  background: var(--danger-soft);
  border-radius: 9px;
  padding: 9px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.err-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.err-title {
  color: var(--danger);
  font-weight: 700;
  font-size: 12px;
}

.sample-err {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--danger-text);
  border-bottom: 1px solid var(--danger-border);
  padding-bottom: 4px;
}

.sample-err:last-of-type {
  border-bottom: none;
}

.eline {
  flex: 0 0 68px;
}

.ecol {
  flex: 0 0 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evalue {
  flex: 0 1 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.emsg {
  flex: 1;
  min-width: 0;
  color: var(--danger);
}

.progress-box {
  display: flex;
  flex-direction: column;
  gap: 7px;
  border: 1px solid var(--border);
  background: var(--surface-soft);
  border-radius: 9px;
  padding: 10px;
}

.bar {
  height: 8px;
  border-radius: 5px;
  background: var(--border-subtle);
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 5px;
  background: linear-gradient(90deg, var(--accent), var(--accent-hover));
  transition: width 0.2s ease;
}

.progress-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11.5px;
  color: var(--text-soft);
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
  font-size: 12px;
}

.warn-line {
  font-size: 11px;
  color: var(--warn);
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

.err-detail {
  font-size: 10.5px;
  color: var(--danger);
}

.err-hint {
  font-size: 11px;
  color: var(--danger);
  line-height: 1.5;
}

.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
</style>
