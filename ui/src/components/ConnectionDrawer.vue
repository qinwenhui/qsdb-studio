<script setup lang="ts">
import { NButton, NDrawer, NDrawerContent, useDialog, useMessage } from 'naive-ui'
import { computed, ref } from 'vue'
import type { ProfileView } from '../ipc/types'
import {
  appState,
  connectProfile,
  deleteProfile,
  disconnect,
  isConnected,
} from '../stores/app'
import {
  CONNECTION_COLORS,
  colorForProfile,
  setProfileColor,
} from '../stores/connectionColors'
import { uiState } from '../stores/ui'
import {
  bindActiveProfile,
  dropProfile,
  ensureBindings,
  workspaceState,
} from '../stores/workspace'
import ProfileDialog from './ProfileDialog.vue'

import { language, t, tt } from '../i18n'

const message = useMessage()
const dialog = useDialog()

const dialogShow = ref(false)
const editing = ref<ProfileView | null>(null)
const busyId = ref('')
const connectingAll = ref(false)

const disconnected = computed(() => appState.profiles.filter((p) => !isConnected(p.id)))

function errText(e: unknown): string {
  const info = (e as { info?: { message?: string; code?: string } }).info
  const msg = info?.message ?? (e instanceof Error ? e.message : String(e))
  return info?.code ? `${msg} [${info.code}]` : msg
}

/** 多连接管理：一次打开所有尚未连接的档案；失败逐条报告，不静默。 */
async function connectAll() {
  if (connectingAll.value) return
  connectingAll.value = true
  let ok = 0
  const failures: string[] = []
  try {
    for (const p of disconnected.value) {
      try {
        await connectProfile(p.id)
        ok++
      } catch (e) {
        failures.push(`${p.name}: ${errText(e)}`)
      }
    }
  } finally {
    connectingAll.value = false
  }
  if (ok > 0) message.success(tt`已连接 ${ok} 条（不会切换当前标签）`)
  if (failures.length > 0) {
    message.error(failures.join('\n').slice(0, 900), { duration: 9000 })
  }
}

function openNew() {
  editing.value = null
  dialogShow.value = true
}

function openEdit(p: ProfileView) {
  editing.value = p
  dialogShow.value = true
}

const openCount = computed(() => appState.connectedIds.length)

function tabsBound(p: ProfileView): number {
  return workspaceState.tabs.filter((t) => t.profileId === p.id).length
}

async function connect(p: ProfileView) {
  busyId.value = p.id
  try {
    const info = await connectProfile(p.id)
    // 连接与“当前标签使用”是两个动作：连接管理里点击即绑定，符合直觉。
    bindActiveProfile(p.id)
    message.success(tt`已连接「${p.name}」· ${info.version}`)
  } catch (e) {
    const info = (e as { info?: { message: string; code?: string } }).info
    const suffix = info?.code ? ` [${info.code}]` : ''
    message.error(`${info?.message ?? (e instanceof Error ? e.message : String(e))}${suffix}`, {
      duration: 7000,
    })
  } finally {
    busyId.value = ''
  }
}

function bindOnly(p: ProfileView) {
  bindActiveProfile(p.id)
  message.success(tt`当前标签已切换到「${p.name}」`)
}

function confirmDisconnect(p: ProfileView) {
  const count = tabsBound(p)
  dialog.warning({
    title: t('断开连接'),
    content:
      count > 1
        ? tt`有 ${count} 个编辑器标签绑定「${p.name}」。断开后这些标签的查询会失败，SQL 草稿与已有结果保留。`
        : tt`确定断开「${p.name}」？SQL 草稿与已有结果会保留。`,
    positiveText: t('断开'),
    negativeText: t('取消'),
    onPositiveClick: async () => {
      await disconnect(p.id)
      message.info(tt`已断开「${p.name}」`)
    },
  })
}

function confirmDelete(p: ProfileView) {
  dialog.warning({
    title: t('删除连接'),
    content: tt`确定删除「${p.name}」？系统凭据管理器里的密码/Token 也会一并删除。`,
    positiveText: t('删除'),
    negativeText: t('取消'),
    onPositiveClick: async () => {
      try {
        await deleteProfile(p.id)
        dropProfile(p.id)
        ensureBindings(appState.profiles.map((x) => x.id))
        message.success(t('已删除'))
      } catch (e) {
        message.error(e instanceof Error ? e.message : String(e))
      }
    },
  })
}

function authLabel(p: ProfileView): string {
  if (p.auth.kind === 'basic') return `Basic · ${p.auth.user}`
  if (p.auth.kind === 'bearer') return 'Bearer Token'
  return t('匿名')
}

function secretLabel(p: ProfileView): string {
  return p.auth.kind === 'bearer' ? 'Token' : t('密码')
}

function secretChip(p: ProfileView): string {
  const label = secretLabel(p)
  if (language.locale === 'en') {
    return p.hasSecret ? `Saved ${label}` : `${label} not saved`
  }
  return p.hasSecret ? `已保存${label}` : `未保存${label}`
}

function onSaved(saved: ProfileView) {
  // 新建：绑定到当前标签并收起抽屉，回到顶栏就能直接点“连接”。
  // 新建时 ProfileDialog 的 editing 为 null；编辑时保持抽屉打开，方便继续管理。
  if (editing.value === null) {
    bindActiveProfile(saved.id)
    uiState.connectionOpen = false
    message.success(tt`已新建「${saved.name}」并绑定到当前标签；点顶栏“连接”打开。`, {
      duration: 7000,
    })
    return
  }
  message.success(tt`已保存连接「${saved.name}」`)
  // 保存成功后列表已刷新；不自动重连（避免打断当前工作），但要说清楚。
  if (isConnected(saved.id)) {
    message.info(t('当前连接仍使用旧凭据；断开后重新连接才会生效。'), { duration: 6000 })
  }
}
</script>

<template>
  <NDrawer v-model:show="uiState.connectionOpen" :width="560" placement="right">
    <NDrawerContent :title="$t('连接管理')" closable>
      <div class="drawer-body">
        <div class="drawer-toolbar">
          <div class="drawer-hint">
            {{ $t("档案存 JSON；密码/Token 只进系统凭据管理器（Windows Credential Manager /\n            Keychain / Secret Service），不会出现在日志或界面回显中。\n            多条连接可以同时打开，每个编辑器标签各自绑定一条。") }}
          </div>
          <div class="drawer-actions">
            <span v-if="openCount > 0" class="chip ok">{{ $t("已打开") }} {{ openCount }} {{ $t("条连接") }}</span>
            <NButton
              v-if="disconnected.length > 0"
              size="small"
              secondary
              :loading="connectingAll"
              :title="$t('依次连接所有未打开的档案；当前标签绑定不变')"
              @click="connectAll"
            >
              {{ $t("连接全部（") }}{{ disconnected.length }}{{ $t("）") }}
            </NButton>
            <NButton type="primary" size="small" @click="openNew">{{ $t("新建连接") }}</NButton>
          </div>
        </div>

        <div v-if="appState.profiles.length === 0" class="empty-state">
          <strong>{{ $t("还没有连接") }}</strong>
          <div class="sub">{{ $t("新建一个连接档案，填入服务地址与凭证，即可连接 QSDB 实例。") }}</div>
          <NButton size="small" type="primary" @click="openNew">{{ $t("新建连接") }}</NButton>
        </div>

        <div v-else class="profile-list">
          <div
            v-for="p in appState.profiles"
            :key="p.id"
            class="profile-card"
            :class="{ active: appState.activeProfileId === p.id }"
          >
            <div class="profile-head">
              <div class="profile-title">
                <i
                  class="profile-color"
                  :style="{ background: colorForProfile(p.id) }"
                  :title="`${$t('连接颜色')} ${colorForProfile(p.id)}`"
                />
                <span class="name">{{ p.name }}</span>
                <span v-if="appState.activeProfileId === p.id" class="chip">
                  {{ $t("当前标签") }}
                </span>
                <span v-if="isConnected(p.id)" class="chip ok">
                  {{ $t("已连接 ·") }} {{ appState.connections[p.id]?.info.version }}
                </span>
                <span v-else-if="tabsBound(p) > 0" class="chip warn">
                  {{ tabsBound(p) }} {{ $t("个标签待重连") }}
                </span>
                <span
                  v-if="isConnected(p.id) && appState.connections[p.id]?.session"
                  class="chip"
                >
                  {{ appState.connections[p.id]?.session?.user }}
                </span>
              </div>
              <div class="profile-actions">
                <NButton
                  v-if="!isConnected(p.id)"
                  size="tiny"
                  type="primary"
                  secondary
                  :loading="busyId === p.id"
                  @click="connect(p)"
                >
                  {{ $t("连接并绑定") }}
                </NButton>
                <template v-else>
                  <NButton
                    v-if="appState.activeProfileId !== p.id"
                    size="tiny"
                    type="primary"
                    secondary
                    @click="bindOnly(p)"
                  >
                    {{ $t("绑定到当前标签") }}
                  </NButton>
                  <NButton size="tiny" quaternary @click="confirmDisconnect(p)">{{ $t("断开") }}</NButton>
                </template>
                <NButton size="tiny" quaternary @click="openEdit(p)">{{ $t("编辑") }}</NButton>
                <NButton size="tiny" quaternary @click="confirmDelete(p)">{{ $t("删除") }}</NButton>
              </div>
            </div>
            <div class="profile-url mono">{{ p.url }}</div>
            <div class="profile-meta">
              <span class="chip">{{ authLabel(p) }}</span>
              <span
                v-if="p.readOnly"
                class="chip warn"
                :title="$t('只读连接：执行前拦截写语句（SELECT/SHOW/EXPLAIN 仍可用）')"
              >
                {{ $t("只读") }}
              </span>
              <span
                v-if="p.auth.kind !== 'none'"
                class="chip"
                :class="p.hasSecret ? 'ok' : 'warn'"
              >
                {{ secretChip(p) }}
              </span>
              <span v-if="p.defaultDatabase" class="chip">{{ $t("默认库") }} {{ p.defaultDatabase }}</span>
              <span class="color-picker" :title="$t('用于顶栏 / 编辑器标签 / 结果页的连接颜色')">
                <span class="color-label">{{ $t("颜色") }}</span>
                <button
                  v-for="c in CONNECTION_COLORS"
                  :key="c"
                  class="swatch"
                  :class="{ active: colorForProfile(p.id) === c }"
                  :style="{ background: c }"
                  :title="c"
                  @click="setProfileColor(p.id, c)"
                />
              </span>
            </div>
          </div>
        </div>
      </div>
    </NDrawerContent>
  </NDrawer>

  <ProfileDialog v-model:show="dialogShow" :profile="editing" @saved="onSaved" />
</template>

<style scoped>
.drawer-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  min-height: 0;
}

.drawer-toolbar {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  justify-content: space-between;
}

.drawer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.drawer-hint {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--muted);
  max-width: 390px;
}

.profile-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: auto;
  padding-right: 2px;
}

.profile-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 11px 12px;
  background: var(--surface-raised);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.profile-card:hover {
  border-color: var(--border-strong);
  box-shadow: 0 2px 10px rgb(16 24 40 / 5%);
}

.profile-card.active {
  border-color: var(--accent-border);
  background: linear-gradient(180deg, var(--surface-raised), var(--accent-soft));
}

.profile-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.profile-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.name {
  font-weight: 650;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.profile-url {
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--text-soft);
}

.profile-meta {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.profile-color {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 8px;
}

.color-picker {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.color-label {
  font-size: 10px;
  color: var(--muted);
}

.swatch {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  border: 1px solid transparent;
  cursor: pointer;
  padding: 0;
}

.swatch.active {
  border-color: var(--text);
  box-shadow: 0 0 0 2px var(--surface-raised) inset;
}
</style>
