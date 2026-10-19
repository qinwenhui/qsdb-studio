<script setup lang="ts">
import { save } from '@tauri-apps/plugin-dialog'
import { NButton, NCheckbox, NModal, useMessage } from 'naive-ui'
import { computed, ref } from 'vue'
import * as ipc from '../ipc'
import type { ResultTab } from '../stores/query'
import { toCsv } from '../utils/csv'
import { formatCount } from '../utils/format'

import { t, tt } from '../i18n'

const props = defineProps<{
  show: boolean
  tab: ResultTab | null
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
}>()

const message = useMessage()
const bom = ref(true)
const saving = ref(false)

const show = computed({
  get: () => props.show,
  set: (v: boolean) => emit('update:show', v),
})

const isStream = computed(() => Boolean(props.tab?.stream))
const pagination = computed(() => props.tab?.pagination ?? null)
const rows = computed(() => {
  const tab = props.tab
  if (!tab) return 0
  if (tab.stream) return tab.stream.totalRows
  return tab.result?.rowCount ?? 0
})

const canSave = computed(() => {
  const tab = props.tab
  if (!tab) return false
  if (tab.stream) return tab.stream.done && Boolean(tab.stream.streamId)
  return tab.result?.kind === 'rows'
})

function defaultName(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const page = pagination.value ? `-p${pagination.value.page}` : ''
  return `qsdb-result-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours(),
  )}${p(d.getMinutes())}${p(d.getSeconds())}${page}.csv`
}

async function onSave() {
  const tab = props.tab
  if (!tab) return
  const path = await save({
    title: t('导出 CSV'),
    defaultPath: defaultName(),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  })
  if (!path) return
  saving.value = true
  try {
    if (tab.stream) {
      const n = await ipc.sqlStreamExportCsv(tab.stream.streamId, path, bom.value)
      message.success(tt`已导出 ${formatCount(n)} 行（UTF-8${bom.value ? ' + BOM' : ''}）`)
    } else if (tab.result) {
      const csv = toCsv(tab.result.columns, tab.result.rows)
      await ipc.saveTextFile(path, csv, bom.value)
      message.success(tt`已导出 ${formatCount(tab.result.rowCount)} 行（UTF-8${bom.value ? ' + BOM' : ''}）`)
    }
    show.value = false
  } catch (e) {
    const info = (e as { info?: { message: string } }).info
    message.error(info?.message ?? (e instanceof Error ? e.message : String(e)), {
      duration: 6000,
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="$t(pagination ? '导出 CSV（当前页）' : '导出 CSV')"
    style="width: 440px"
  >
    <div class="body">
      <div class="row">
        <span class="label">{{ $t(pagination ? '本页行数' : '行数') }}</span>
        <span class="value mono">{{ formatCount(rows) }}</span>
      </div>
      <div class="row">
        <span class="label">{{ $t("通道") }}</span>
        <span class="value">{{ $t(isStream ? '流式（Rust spool 边读边写）' : 'bulk 整包') }}</span>
      </div>
      <NCheckbox v-model:checked="bom">
        {{ $t("UTF-8 BOM（Excel 打开中文不乱码）") }}
      </NCheckbox>
      <div class="hint">
        {{ $t("NULL 输出为空串；字符串中的逗号/引号/换行按 RFC 4180 转义。不改写任何值形态。") }}
      </div>
      <div v-if="pagination" class="warn">
        {{ $t("自动分页第") }} {{ pagination.page }} {{ $t("页（每页") }} {{ pagination.pageSize }} {{ $t("行）：\n        这里只导出") }}<b>{{ $t("当前页") }}</b>{{ $t("，不是整表；其他页请翻页后分别导出。") }}
      </div>
      <div v-if="!canSave" class="warn">
        {{ $t("结果尚不可导出（流式仍在接收，或这是无结果集的回执）。") }}
      </div>
    </div>

    <template #footer>
      <div class="footer">
        <NButton size="small" @click="show = false">{{ $t("取消") }}</NButton>
        <NButton size="small" type="primary" :disabled="!canSave" :loading="saving" @click="onSave">
          {{ $t("选择位置并保存") }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 11px;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12.5px;
}

.label {
  width: 44px;
  color: var(--muted);
  font-size: 11.5px;
}

.value {
  color: var(--text-soft);
}

.hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
}

.warn {
  padding: 7px 9px;
  border-radius: 6px;
  background: var(--warn-soft);
  border: 1px solid var(--warn-border);
  color: var(--warn);
  font-size: 11.5px;
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
