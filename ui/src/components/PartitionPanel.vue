<script setup lang="ts">
import { NButton, NDrawer, NDrawerContent, useMessage } from 'naive-ui'
import { computed } from 'vue'
import type { WirePartition } from '../ipc/types'
import { baseQueryOptions } from '../stores/app'
import {
  loadPartitions,
  partitionState,
} from '../stores/partition'
import { runSql } from '../stores/query'
import { editorForProfile, setActiveSql } from '../stores/workspace'
import { errorHint } from '../utils/errors'
import { formatBytes, formatCount } from '../utils/format'
import { overwriteTemplate, previewSql } from '../utils/partitions'

import { t, tt } from '../i18n'

const message = useMessage()

const show = computed({
  get: () => partitionState.visible,
  set: (v: boolean) => {
    partitionState.visible = v
  },
})

const table = computed(() => partitionState.table)
const partitionColumnCount = computed(
  () => table.value?.columns.filter((c) => c.partition).length ?? 0,
)
const totalBytes = computed(() =>
  partitionState.partitions.reduce((sum, p) => sum + p.bytes, 0),
)
const totalRows = computed(() =>
  partitionState.partitions.reduce((sum, p) => sum + p.rows, 0),
)
/**
 * 旧内核的 /partitions detail 没有 bytes（client 会填 0）。有行数但全为 0
 * 时不能把“未知”显示成 0 B。
 */
const bytesKnown = computed(
  () =>
    partitionState.partitions.some((p) => p.bytes > 0) ||
    partitionState.partitions.every((p) => p.rows === 0),
)

const drawerTitle = computed(() =>
  table.value ? tt`分区 · ${table.value.name}` : t('分区'),
)

function bytesTitle(bytes: number): string {
  return bytesKnown.value
    ? tt`${formatCount(bytes)} 字节`
    : t('服务端未返回 bytes（旧内核）')
}

async function onPreview(part: WirePartition) {
  const target = table.value
  if (!target) return
  const r = previewSql(target, part.name)
  if (r.error) {
    message.error(r.error, { duration: 6000 })
    return
  }
  const pid = partitionState.profileId
  if (!pid) {
    message.warning(t('分区面板没有绑定连接：请重新从元数据树打开'))
    return
  }
  const tab = editorForProfile(pid)
  partitionState.visible = false
  await runSql(tab.key, pid, r.sql, baseQueryOptions(), {
    stream: false,
    title: tt`分区预览 · ${part.name}`,
  })
}

function onTemplate(part: WirePartition) {
  const target = table.value
  if (!target) return
  const r = overwriteTemplate(target, part.name, part.generation)
  if (r.error) {
    message.error(r.error, { duration: 6000 })
    return
  }
  setActiveSql(r.sql)
  partitionState.visible = false
  message.success(t('已生成 INSERT OVERWRITE 模板（分区值 + generation 已预填）'))
}

async function onRefresh() {
  await loadPartitions()
}
</script>

<template>
  <NDrawer v-model:show="show" :width="680" placement="right">
    <NDrawerContent
      :title="drawerTitle"
      closable
    >
      <div class="body">
        <div class="head-row">
          <div class="head-meta">
            <span class="chip">{{ partitionState.partitions.length }} {{ $t("个分区") }}</span>
            <span
              class="chip"
              :title="
                bytesKnown
                  ? $t('压缩后段文件落盘体积')
                  : $t('服务端未返回 bytes（旧内核），不把未知显示成 0 B')
              "
            >
              {{ $t("总大小") }} {{ bytesKnown ? formatBytes(totalBytes) : '—' }}
            </span>
            <span class="chip">{{ $t("总行数") }} {{ formatCount(totalRows) }}</span>
            <span class="chip">{{ $t("分区列") }} {{ partitionColumnCount }}</span>
            <span class="hint">{{ $t("generation 是每次提交 +1 的计数器") }}</span>
          </div>
          <NButton size="small" :loading="partitionState.loading" @click="onRefresh">
            {{ $t("刷新") }}
          </NButton>
        </div>

        <div v-if="partitionState.error" class="error-box">
          <div class="err-head">
            <span class="code-badge">{{ partitionState.error.code ?? partitionState.error.kind }}</span>
            <span class="spacer" />
            <NButton size="tiny" secondary @click="onRefresh">{{ $t("重试") }}</NButton>
          </div>
          <div class="err-msg">{{ partitionState.error.message }}</div>
          <div class="err-hint">{{ errorHint(partitionState.error) }}</div>
        </div>

        <div v-else-if="partitionState.loading" class="empty-state">
          <strong>{{ $t("正在读取分区…") }}</strong>
          <div class="sub">
            GET /tables/{t}/partitions（generation / rows / segments / bytes）。
          </div>
        </div>

        <div v-else-if="partitionState.partitions.length === 0" class="empty-state">
          <strong>{{ $t("没有分区") }}</strong>
          <div class="sub">
            {{ $t("该表可能还未写入数据，或不是分区表。分区表写入后这里会按目录名列出每个分区。") }}
          </div>
        </div>

        <div v-else class="plist">
          <div class="prow pheader">
            <span class="c-name">{{ $t("分区") }}</span>
            <span class="c-gen">generation</span>
            <span class="c-rows">{{ $t("行数") }}</span>
            <span class="c-bytes">{{ $t("大小") }}</span>
            <span class="c-seg">{{ $t("段") }}</span>
            <span class="c-act">{{ $t("操作") }}</span>
          </div>
          <div v-for="p in partitionState.partitions" :key="p.name" class="prow">
            <span class="c-name mono" :title="p.name">{{ p.name }}</span>
            <span class="c-gen"><span class="chip gen">{{ p.generation }}</span></span>
            <span class="c-rows mono">{{ formatCount(p.rows) }}</span>
            <span
              class="c-bytes mono"
              :title="bytesTitle(p.bytes)"
            >
              {{ bytesKnown ? formatBytes(p.bytes) : '—' }}
            </span>
            <span class="c-seg mono">{{ p.segments }}</span>
            <span class="c-act">
              <NButton size="tiny" secondary @click="onPreview(p)">{{ $t("预览") }}</NButton>
              <NButton size="tiny" quaternary :title="$t('生成 INSERT OVERWRITE 模板')" @click="onTemplate(p)">
                {{ $t("模板") }}
              </NButton>
            </span>
          </div>
        </div>

        <div class="foot-note">
          {{ $t("“大小”是段文件压缩后的落盘体积，单表总大小 = 各分区求和（服务端\n          /partitions detail.bytes）。预览 SQL 的谓词只落在分区列上（WHERE\n          分区列 = 值），服务端可做分区裁剪；末尾 LIMIT 500 只是预览上限。\n          INSERT OVERWRITE 是分区级原子替换，SQL 语法没有 CAS generation——\n          需要乐观并发请走批量写接口的 expected_generation。") }}
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

.head-row {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
}

.head-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.hint {
  font-size: 10.5px;
  color: var(--muted);
}

.plist {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: auto;
  min-height: 0;
  flex: 1;
}

.prow {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) 86px 84px 92px 44px 128px;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--row-line);
  font-size: 12px;
}

.prow:last-child {
  border-bottom: none;
}

.prow:not(.pheader):hover {
  background: var(--surface-soft);
}

.pheader {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface-soft);
  border-bottom: 1px solid var(--border-strong);
  font-size: 10.5px;
  font-weight: 700;
  color: var(--muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.c-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.c-gen,
.c-rows,
.c-bytes,
.c-seg {
  display: flex;
  align-items: center;
}

.c-rows,
.c-bytes,
.c-seg {
  justify-content: flex-end;
  color: var(--text-soft);
}

.c-act {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
}

.chip.gen {
  font-family: var(--mono);
  font-size: 10.5px;
  background: var(--accent-soft);
  border-color: var(--accent-border);
  color: var(--accent-strong);
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
  flex: 0 0 auto;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
</style>
