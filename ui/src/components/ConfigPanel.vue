<script setup lang="ts">
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NInputNumber,
  useDialog,
  useMessage,
} from 'naive-ui'
import { computed, reactive, ref, watch } from 'vue'
import * as ipc from '../ipc'
import type { ConfigPatch, ConfigSnapshot, ConfigUpdateAck, StudioError } from '../ipc/types'
import { appState, toStudioError } from '../stores/app'
import { uiState } from '../stores/ui'
import { errorHint } from '../utils/errors'
import { formatBytes, formatCount, formatDateTime, formatLimitBytes } from '../utils/format'

import { t, tt } from '../i18n'

const message = useMessage()
const dialog = useDialog()

const show = computed({
  get: () => uiState.configOpen,
  set: (v: boolean) => {
    uiState.configOpen = v
  },
})

const loading = ref(false)
const saving = ref(false)
const error = ref<StudioError | null>(null)
const mismatch = ref<string | null>(null)
const snapshot = ref<ConfigSnapshot | null>(null)
const lastAck = ref<ConfigUpdateAck | null>(null)
const loadedAt = ref(0)

/**
 * 三闸按设计是 **admin 专属**。内核 061030d 已给 /config 补上 admin 闸；
 * Studio UI 侧保留同样的限制（防御性，纵深一致）。匿名/静态 token（无会话）
 * 交给服务端判定。
 */
const canEdit = computed(() => {
  if (!appState.session) return true
  return appState.session.role === 'admin'
})

const form = reactive({
  timeoutMs: 0,
  memoryMb: 0,
  maxRows: 0,
  maxMb: 0,
})

function fill(rt: { queryTimeoutMs: number; queryMemoryLimitBytes: number; maxResultRows: number; maxResultBytes: number }) {
  form.timeoutMs = rt.queryTimeoutMs
  form.memoryMb = Math.round(rt.queryMemoryLimitBytes / (1024 * 1024))
  form.maxRows = rt.maxResultRows
  form.maxMb = Math.round(rt.maxResultBytes / (1024 * 1024))
}

interface ConfigChange {
  key: string
  label: string
  from: number
  to: number
  fmt: (v: number) => string
}

/** 表单 vs 服务端快照的差异（单位统一成 ms / MB / 行）。 */
const changes = computed<ConfigChange[]>(() => {
  if (!snapshot.value) return []
  const rt = snapshot.value.runtime
  const defs: ConfigChange[] = [
    {
      key: 'timeoutMs',
      label: t('查询超时（ms）'),
      from: rt.queryTimeoutMs,
      to: Math.max(0, Math.round(form.timeoutMs || 0)),
      fmt: (v) => (v === 0 ? t('不限（0）') : `${v} ms`),
    },
    {
      key: 'memoryMb',
      label: t('单查询内存'),
      from: Math.round(rt.queryMemoryLimitBytes / (1024 * 1024)),
      to: Math.max(0, Math.round(form.memoryMb || 0)),
      fmt: (v) => (v === 0 ? t('不限（0）') : `${v} MB`),
    },
    {
      key: 'maxRows',
      label: t('结果护栏 · 行数'),
      from: rt.maxResultRows,
      to: Math.max(0, Math.round(form.maxRows || 0)),
      fmt: (v) => (v === 0 ? t('关闭（0）') : tt`${v} 行`),
    },
    {
      key: 'maxMb',
      label: t('结果护栏 · 体量'),
      from: Math.round(rt.maxResultBytes / (1024 * 1024)),
      to: Math.max(0, Math.round(form.maxMb || 0)),
      fmt: (v) => (v === 0 ? t('关闭（0）') : `${v} MB`),
    },
  ]
  return defs.filter((d) => d.from !== d.to)
})

const dirty = computed(() => changes.value.length > 0)

function resetForm() {
  if (snapshot.value) fill(snapshot.value.runtime)
}

async function load() {
  const id = appState.connection?.profileId
  if (!id) {
    error.value = { kind: 'usage', message: t('尚未连接 QSDB 实例'), retriable: false }
    return
  }
  loading.value = true
  error.value = null
  mismatch.value = null
  try {
    const s = await ipc.configGet(id)
    // 多标签：响应回来时活动连接可能已经切走，旧快照不覆盖新连接。
    if (appState.activeProfileId !== id) return
    snapshot.value = s
    fill(s.runtime)
    loadedAt.value = Date.now()
  } catch (e) {
    if (appState.activeProfileId !== id) return
    error.value = toStudioError(e)
  } finally {
    loading.value = false
  }
}

function save() {
  if (!canEdit.value || !dirty.value || saving.value) return
  // 把保护阈值从“启用”改成 0 = 不限/关闭：必须二次确认，不静默放开。
  const risky = changes.value.filter((c) => c.from > 0 && c.to === 0)
  if (risky.length > 0) {
    dialog.warning({
      title: t('关闭限制 / 结果护栏？'),
      content:
        tt`以下字段将从启用改为 0（不限/关闭）：${risky
          .map((c) => `${c.label}（${c.fmt(c.from)}）`)
          .join('、')}。` +
        t('这会放开部署方设置的超时/内存/结果保护阈值，请确认这是你要的行为。'),
      positiveText: t('仍要保存'),
      negativeText: t('取消'),
      onPositiveClick: () => {
        void doSave()
      },
    })
    return
  }
  void doSave()
}

async function doSave() {
  const id = appState.connection?.profileId
  if (!id) return
  mismatch.value = null
  error.value = null
  const submitted = {
    queryTimeoutMs: Math.max(0, Math.round(form.timeoutMs || 0)),
    queryMemoryLimitBytes: Math.max(0, Math.round((form.memoryMb || 0) * 1024 * 1024)),
    maxResultRows: Math.max(0, Math.round(form.maxRows || 0)),
    maxResultBytes: Math.max(0, Math.round((form.maxMb || 0) * 1024 * 1024)),
  }
  const patch: ConfigPatch = { ...submitted }
  saving.value = true
  try {
    const ack = await ipc.configPut(id, patch)
    // 请求已发往旧连接：若其间切了标签，回显不属于当前面板。
    if (appState.activeProfileId !== id) return
    lastAck.value = ack
    const diffs: string[] = []
    if (!ack.applied) diffs.push(t('applied=false：服务端没有接受任何已知键'))
    if (ack.queryTimeoutMs !== submitted.queryTimeoutMs) {
      diffs.push(tt`queryTimeoutMs 提交 ${submitted.queryTimeoutMs} / 回显 ${ack.queryTimeoutMs}`)
    }
    if (ack.queryMemoryLimitBytes !== submitted.queryMemoryLimitBytes) {
      diffs.push(
        tt`queryMemoryLimitBytes 提交 ${submitted.queryMemoryLimitBytes} / 回显 ${ack.queryMemoryLimitBytes}`,
      )
    }
    if (ack.maxResultRows !== submitted.maxResultRows) {
      diffs.push(tt`maxResultRows 提交 ${submitted.maxResultRows} / 回显 ${ack.maxResultRows}`)
    }
    if (ack.maxResultBytes !== submitted.maxResultBytes) {
      diffs.push(tt`maxResultBytes 提交 ${submitted.maxResultBytes} / 回显 ${ack.maxResultBytes}`)
    }
    if (diffs.length > 0) {
      mismatch.value = diffs.join('；')
      return
    }
    message.success(t('已热更，且服务端回显与提交值一致'))
    await load()
  } catch (e) {
    error.value = toStudioError(e)
  } finally {
    saving.value = false
  }
}

watch(
  () => uiState.configOpen,
  (open) => {
    if (open) void load()
  },
)

// 多标签切连接：面板跟随当前标签的连接重新读取（否则会把旧值保存到新连接）。
watch(
  () => appState.activeProfileId,
  () => {
    if (uiState.configOpen) void load()
  },
)
</script>

<template>
  <NDrawer v-model:show="show" :width="600" placement="right">
    <NDrawerContent :title="$t('三闸热更 · 运行期配置')" closable>
      <div class="body">
        <div class="head-row">
          <div class="chips">
            <span v-if="snapshot?.server" class="chip">
              {{ snapshot.server.mounts.length }} {{ $t("个挂载") }}
            </span>
            <span v-if="snapshot?.memory" class="chip">
              {{ $t("内存预算") }} {{ formatLimitBytes(snapshot.memory.budgetBytes) }}
            </span>
            <span v-if="snapshot?.memory" class="chip">
              {{ $t("执行中") }} {{ formatBytes(snapshot.memory.execUsedBytes) }}
            </span>
            <span v-if="loadedAt" class="hint">{{ $t("读取于") }} {{ formatDateTime(loadedAt) }}</span>
            <span v-if="dirty" class="chip warn">{{ $t("未保存") }} {{ changes.length }} {{ $t("项") }}</span>
          </div>
          <NButton size="small" :loading="loading" @click="load">{{ $t("刷新") }}</NButton>
        </div>

        <div v-if="appState.session && !canEdit" class="banner warn-banner">
          {{ $t("当前会话角色是") }} <b>{{ appState.session.role ?? $t('（无默认库角色）') }}</b>{{ $t("；三闸热更按设计是\n          admin 专属。内核（061030d）已给 /config 补上 admin 闸；Studio 在 UI 侧同样不在非 admin 会话放行保存，只展示当前值。") }}
        </div>

        <div v-if="error" class="error-box">
          <div class="err-head">
            <span class="code-badge">{{ error.code ?? error.kind }}</span>
            <span v-if="error.status" class="status">HTTP {{ error.status }}</span>
            <span class="spacer" />
            <NButton size="tiny" secondary @click="load">{{ $t("重试") }}</NButton>
          </div>
          <div class="err-msg">{{ error.message }}</div>
          <div class="err-hint">{{ errorHint(error) }}</div>
        </div>

        <div v-if="loading && !snapshot" class="empty-state">
          <strong>{{ $t("正在读取运行期配置…") }}</strong>
          <div class="sub">GET /api/v1/config（admin）</div>
        </div>

        <template v-if="snapshot">
          <div class="grid">
            <div class="field">
              <div class="label">{{ $t("查询超时（ms）") }}</div>
              <NInputNumber v-model:value="form.timeoutMs" size="small" :min="0" :step="1000" />
              <div class="hint">{{ $t("0 = 不设超时；服务端按查询计时。") }}</div>
            </div>
            <div class="field">
              <div class="label">{{ $t("单查询内存（MB）") }}</div>
              <NInputNumber v-model:value="form.memoryMb" size="small" :min="0" :step="256" />
              <div class="hint">{{ $t("0 = 不限；超限报 QUERY_MEMORY_LIMIT（400）。") }}</div>
            </div>
            <div class="field">
              <div class="label">{{ $t("结果护栏·行数") }}</div>
              <NInputNumber v-model:value="form.maxRows" size="small" :min="0" :step="10000" />
              <div class="hint">{{ $t("0 = 关闭；超限报 RESULT_TOO_LARGE（400，绝不返回部分数据）。") }}</div>
            </div>
            <div class="field">
              <div class="label">{{ $t("结果护栏·体量（MB）") }}</div>
              <NInputNumber v-model:value="form.maxMb" size="small" :min="0" :step="16" />
              <div class="hint">{{ $t("0 = 关闭；按 Arrow 内存估算，JSON 实际体积可能更大。") }}</div>
            </div>
          </div>

          <div v-if="changes.length > 0" class="changes">
            <div class="ch-head">{{ $t("未保存的变更（") }}{{ changes.length }} {{ $t("项）") }}</div>
            <div v-for="c in changes" :key="c.key" class="ch-row">
              <span class="ch-label">{{ c.label }}</span>
              <span class="ch-from mono">{{ c.fmt(c.from) }}</span>
              <span class="ch-arrow">→</span>
              <span class="ch-to mono">{{ c.fmt(c.to) }}</span>
            </div>
          </div>

          <div v-if="snapshot.memory" class="live">
            <div class="live-item">
              <span class="k">{{ $t("全库预算") }}</span>
              <span class="v mono">{{ formatLimitBytes(snapshot.memory.budgetBytes) }}</span>
            </div>
            <div class="live-item">
              <span class="k">{{ $t("执行中") }}</span>
              <span class="v mono">{{ formatBytes(snapshot.memory.execUsedBytes) }}</span>
            </div>
            <div class="live-item">
              <span class="k">{{ $t("缓存") }}</span>
              <span class="v mono">{{ formatBytes(snapshot.memory.cacheUsedBytes) }}</span>
            </div>
            <div class="live-item">
              <span class="k">{{ $t("并发上限") }}</span>
              <span class="v mono">
                {{ snapshot.server?.maxConcurrentQueries === 0 ? $t('不限') : formatCount(snapshot.server?.maxConcurrentQueries) }}
              </span>
            </div>
          </div>

          <div v-if="mismatch" class="mismatch">
            <div class="mi-head">{{ $t("服务端回显与提交值不一致（按契约必须红）") }}</div>
            <div class="mi-body">{{ mismatch }}</div>
            <div v-if="lastAck" class="mi-ack mono">
              applied={{ lastAck.applied }} · timeout={{ lastAck.queryTimeoutMs }} ·
              mem={{ lastAck.queryMemoryLimitBytes }}B · rows={{ lastAck.maxResultRows }} ·
              bytes={{ lastAck.maxResultBytes }}B
            </div>
          </div>

          <div class="foot-note">
            {{ $t("PUT 只热更 runtime 节，立即生效；") }}<b>{{ $t("applied=false 或回显不一致会在上方红出来") }}</b>{{ $t("，\n            不假装成功。0 的语义：超时/内存/体量 = 不限，结果行数 = 关闭护栏。\n            服务端没有提供“默认配置”接口，这里只提供“恢复载入值”，不猜默认值。") }}
          </div>

          <div class="actions">
            <NButton
              size="small"
              secondary
              :disabled="!dirty || saving"
              @click="resetForm"
            >
              {{ $t("恢复载入值") }}
            </NButton>
            <NButton
              size="small"
              type="primary"
              :loading="saving"
              :disabled="!canEdit || !dirty"
              @click="save"
            >
              {{ $t("保存并校验回显") }}
            </NButton>
          </div>
        </template>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  min-height: 0;
  overflow: auto;
}

.head-row {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
}

.chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.hint {
  font-size: 10.5px;
  color: var(--muted);
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field .label {
  font-size: 12px;
  font-weight: 650;
  color: var(--text-soft);
}

.live {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  background: var(--panel-soft);
}

.live-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.live-item .k {
  font-size: 10.5px;
  color: var(--muted);
}

.live-item .v {
  font-size: 12px;
  color: var(--text);
}

.banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 7px;
  font-size: 11.5px;
  line-height: 1.55;
  border: 1px solid;
}

.warn-banner {
  background: var(--warn-soft);
  border-color: var(--warn-border);
  color: var(--warn);
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

.mismatch {
  border: 1px solid var(--danger-border);
  background: var(--danger-soft);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.mi-head {
  color: var(--danger);
  font-weight: 700;
  font-size: 12px;
}

.mi-body {
  color: var(--danger-text);
  font-size: 11.5px;
  line-height: 1.5;
  word-break: break-word;
}

.mi-ack {
  font-size: 10.5px;
  color: var(--danger);
  word-break: break-all;
}

.foot-note {
  font-size: 11px;
  line-height: 1.65;
  color: var(--muted);
  border-top: 1px solid var(--border);
  padding-top: 10px;
}

.changes {
  border: 1px solid var(--warn-border);
  background: var(--warn-soft);
  border-radius: 8px;
  padding: 9px 11px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.ch-head {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--warn);
}

.ch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-soft);
}

.ch-label {
  flex: 0 0 130px;
}

.ch-from {
  color: var(--muted);
}

.ch-arrow {
  color: var(--muted);
}

.ch-to {
  color: var(--text);
  font-weight: 650;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
