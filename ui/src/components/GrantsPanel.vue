<script setup lang="ts">
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NModal,
  NSelect,
  useMessage,
} from 'naive-ui'
import { computed, ref, watch } from 'vue'
import * as ipc from '../ipc'
import type { StudioError } from '../ipc/types'
import { appState, toStudioError } from '../stores/app'
import { uiState } from '../stores/ui'
import { errorHint } from '../utils/errors'
import {
  GRANT_OPTIONS,
  buildGrantRow,
  grantLabel,
  isRowDirty,
  rowDiff,
  rowToGrants,
  type GrantRow,
} from '../utils/grants'

import { t, tt } from '../i18n'

const message = useMessage()

const show = computed({
  get: () => uiState.grantOpen,
  set: (v: boolean) => {
    uiState.grantOpen = v
  },
})

const rows = ref<GrantRow[]>([])
const loading = ref(false)
const savingUser = ref('')
const savingAll = ref(false)
const diffOpen = ref(false)
const error = ref<StudioError | null>(null)

const databases = computed(() => appState.databases.map((d) => d.name))
const columns = computed(() => [...databases.value, '*'])
const gridStyle = computed(() => ({
  gridTemplateColumns: `170px repeat(${columns.value.length}, minmax(108px, 1fr)) 132px`,
}))

const dirtyRows = computed(() => rows.value.filter(isRowDirty))
const diffRows = computed(() =>
  dirtyRows.value.map((row) => ({ row, changes: rowDiff(row) })),
)

function errorText(e: unknown): string {
  const info = toStudioError(e)
  return `${info.code ?? info.kind}: ${info.message}`
}

async function load() {
  const id = appState.connection?.profileId
  if (!id) {
    error.value = { kind: 'usage', message: t('尚未连接 QSDB 实例'), retriable: false }
    return
  }
  loading.value = true
  error.value = null
  try {
    // 类型真相源：SHOW USERS 的第三列 grants 摘要是服务端生成的规范形态。
    const res = await ipc.sqlExecute(id, 'SHOW USERS', { params: [] })
    if (res.kind !== 'rows') {
      const msg = res.message ?? t('SHOW USERS 没有返回结果集')
      error.value = { kind: 'decode', message: msg, retriable: false }
      return
    }
    const ui = res.columns.findIndex((c) => c.name === 'user')
    const ri = res.columns.findIndex((c) => c.name === 'role')
    const gi = res.columns.findIndex((c) => c.name === 'grants')
    if (ui < 0 || ri < 0 || gi < 0) {
      error.value = {
        kind: 'decode',
        message: tt`SHOW USERS 列不符合契约（user/role/grants）: ${res.columns.map((c) => c.name).join(', ')}`,
        retriable: false,
      }
      return
    }
    const built: GrantRow[] = []
    for (const row of res.rows) {
      const user = String(row[ui] ?? '')
      const role = String(row[ri] ?? '')
      const summary = String(row[gi] ?? '')
      const r = buildGrantRow(user, role, summary, databases.value)
      if (r.error) {
        error.value = {
          kind: 'decode',
          message: tt`用户 ${user} 的 grants 摘要无法解析: ${r.error}`,
          retriable: false,
        }
        return
      }
      if (r.row) built.push(r.row)
    }
    rows.value = built
  } catch (e) {
    error.value = toStudioError(e)
  } finally {
    loading.value = false
  }
}

async function save(row: GrantRow) {
  const id = appState.connection?.profileId
  if (!id) return
  savingUser.value = row.user
  try {
    await ipc.grantsPut(id, row.user, rowToGrants(row))
    // 不整表重载：其他行可能还有未保存修改，重载会静默丢弃它们。
    row.initial = { ...row.cells }
    message.success(tt`已保存 ${row.user} 的 grants（整表替换，服务端每请求现查）`)
  } catch (e) {
    message.error(errorText(e), { duration: 7000 })
  } finally {
    savingUser.value = ''
  }
}

/** 保存全部脏行；失败的行保留编辑与 dirty 标记，成功行清掉快照。 */
async function saveAll() {
  const id = appState.connection?.profileId
  if (!id || savingAll.value) return
  const targets = [...dirtyRows.value]
  if (targets.length === 0) {
    diffOpen.value = false
    return
  }
  savingAll.value = true
  let saved = 0
  const failures: string[] = []
  try {
    for (const row of targets) {
      try {
        await ipc.grantsPut(id, row.user, rowToGrants(row))
        row.initial = { ...row.cells }
        saved++
      } catch (e) {
        failures.push(`${row.user}: ${errorText(e)}`)
      }
    }
  } finally {
    savingAll.value = false
  }
  diffOpen.value = false
  if (saved > 0) message.success(tt`已保存 ${saved} 个用户的 grants（整表替换）`)
  if (failures.length > 0) {
    message.error(failures.join('\n').slice(0, 900), { duration: 9000 })
  }
}

function resetRow(row: GrantRow) {
  row.cells = { ...row.initial }
}

watch(
  () => uiState.grantOpen,
  (open) => {
    if (open) void load()
  },
)

watch(
  () => appState.connection?.profileId,
  () => {
    if (uiState.grantOpen) void load()
  },
)
</script>

<template>
  <NDrawer v-model:show="show" :width="980" placement="right">
    <NDrawerContent :title="$t('grants 矩阵')" closable>
      <div class="body">
        <div class="topbar">
          <span class="chip">{{ rows.length }} {{ $t("用户") }}</span>
          <span class="chip">{{ databases.length }} {{ $t("挂载库 + *") }}</span>
          <span v-if="dirtyRows.length > 0" class="chip warn">
            {{ $t("未保存") }} {{ dirtyRows.length }} {{ $t("行") }}
          </span>
          <span class="hint">{{ $t("保存 = 整表替换（一次提交一用户的整行）；服务端每请求现查，立即生效") }}</span>
          <span class="spacer" />
          <NButton
            size="small"
            type="primary"
            secondary
            :disabled="dirtyRows.length === 0"
            @click="diffOpen = true"
          >
            {{ $t("预览变更（") }}{{ dirtyRows.length }}{{ $t("）") }}
          </NButton>
          <NButton size="small" :loading="loading" @click="load">{{ $t("刷新") }}</NButton>
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

        <div v-else-if="loading && rows.length === 0" class="empty-state">
          <strong>{{ $t("正在读取用户与授权…") }}</strong>
          <div class="sub">{{ $t("SHOW USERS（user / role / grants 摘要），矩阵列来自已挂载库。") }}</div>
        </div>

        <div v-else-if="rows.length === 0" class="empty-state">
          <strong>{{ $t("没有用户") }}</strong>
          <div class="sub">{{ $t("用户 CRUD 走 SQL / CLI；本面板只做 grants 调整。") }}</div>
        </div>

        <div v-else class="matrix-wrap">
          <div class="matrix" :style="gridStyle">
            <div class="th">{{ $t("用户") }}</div>
            <div v-for="c in columns" :key="c" class="th">
              {{ c === '*' ? $t('*（通配）') : c }}
            </div>
            <div class="th">{{ $t("操作") }}</div>

            <template v-for="row in rows" :key="row.user">
              <div class="user-cell" :class="{ dirty: isRowDirty(row) }">
                <span class="mono user">{{ row.user }}</span>
                <span v-if="row.globalRole" class="chip role">{{ row.globalRole }}</span>
              </div>
              <div
                v-for="c in columns"
                :key="c"
                class="cell"
                :class="{ dirty: isRowDirty(row) }"
              >
                <NSelect
                  v-model:value="row.cells[c]"
                  size="tiny"
                  :options="GRANT_OPTIONS.map((o) => ({ ...o, label: $t(o.label) }))"
                  :consistent-menu-width="false"
                />
              </div>
              <div class="cell action-cell" :class="{ dirty: isRowDirty(row) }">
                <NButton
                  size="tiny"
                  secondary
                  :disabled="!isRowDirty(row) || savingAll"
                  @click="resetRow(row)"
                >
                  {{ $t("撤销") }}
                </NButton>
                <NButton
                  size="tiny"
                  type="primary"
                  :disabled="!isRowDirty(row)"
                  :loading="savingUser === row.user || savingAll"
                  @click="save(row)"
                >
                  {{ $t("保存") }}
                </NButton>
              </div>
            </template>
          </div>
        </div>

        <div class="foot-note">
          {{ $t("单元格 = reader / writer / admin / 无权（显式 null）。`*` 是通配授权；\n          某个库的单元格会覆盖 `*`。保存时会保留摘要里**未挂载库**的旧授权\n          （矩阵不展示，但不静默丢）。写 grants 需要 admin；reader 保存会收到 403。") }}
        </div>
      </div>
    </NDrawerContent>

    <NModal
      v-model:show="diffOpen"
      preset="card"
      :title="$t('保存前确认 · grants 变更')"
      style="width: 660px"
      :mask-closable="false"
    >
      <div v-if="diffRows.length === 0" class="diff-empty">{{ $t("没有未保存修改。") }}</div>
      <div v-else class="diff-list">
        <div v-for="d in diffRows" :key="d.row.user" class="diff-row">
          <div class="diff-user">
            <span class="mono">{{ d.row.user }}</span>
            <span v-if="d.row.globalRole" class="chip role">{{ d.row.globalRole }}</span>
          </div>
          <div class="diff-changes">
            <span v-for="c in d.changes" :key="c.col" class="diff-item">
              <b class="mono">{{ c.col === '*' ? $t('*（通配）') : c.col }}</b>
              <span class="from">{{ grantLabel(c.from) }}</span>
              <span class="arrow">→</span>
              <span class="to">{{ grantLabel(c.to) }}</span>
            </span>
          </div>
        </div>
      </div>
      <div class="diff-note">
        {{ $t("保存会按用户整表替换；矩阵里未展示的") }} <b>{{ $t("未挂载库") }}</b> {{ $t("旧授权会原样带回，不会丢。\n        某个库的单元格覆盖") }} <code>*</code>，<code>{{ $t('无权') }}</code> {{ $t("会显式写成 null。") }}
      </div>
      <template #footer>
        <div class="modal-footer">
          <span class="spacer" />
          <NButton size="small" :disabled="savingAll" @click="diffOpen = false">
            {{ $t("取消") }}
          </NButton>
          <NButton
            size="small"
            type="primary"
            :loading="savingAll"
            :disabled="diffRows.length === 0"
            @click="saveAll"
          >
            {{ $t("保存全部（") }}{{ dirtyRows.length }} {{ $t("用户）") }}
          </NButton>
        </div>
      </template>
    </NModal>
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
  flex-wrap: wrap;
}

.hint {
  font-size: 10.5px;
  color: var(--muted);
}

.spacer {
  flex: 1;
}

.matrix-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.matrix {
  display: grid;
  min-width: 100%;
}

.th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 8px 10px;
  background: var(--surface-soft);
  border-bottom: 1px solid var(--border-strong);
  font-size: 10.5px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.user-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--row-line);
  overflow: hidden;
}

.user {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip.role {
  height: 17px;
  font-size: 10px;
  padding: 0 5px;
}

.cell {
  display: flex;
  align-items: center;
  padding: 4px 6px;
  border-bottom: 1px solid var(--row-line);
}

.action-cell {
  justify-content: flex-end;
  gap: 3px;
}

.user-cell.dirty,
.cell.dirty {
  background: var(--warn-soft);
}

.user-cell.dirty {
  box-shadow: inset 3px 0 0 var(--warn);
}

.diff-empty {
  font-size: 12px;
  color: var(--muted);
}

.diff-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow: auto;
}

.diff-row {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-raised);
  padding: 8px 10px;
}

.diff-user {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 650;
}

.diff-changes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.diff-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface-soft);
}

.diff-item .from {
  color: var(--muted);
}

.diff-item .arrow {
  color: var(--muted);
}

.diff-item .to {
  color: var(--accent-strong);
  font-weight: 650;
}

.diff-note {
  margin-top: 10px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
}

.diff-note code {
  font-family: var(--mono);
}

.modal-footer {
  display: flex;
  align-items: center;
  gap: 8px;
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
  line-height: 1.65;
  color: var(--muted);
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
</style>
