<script setup lang="ts">
import { NButton, NDrawer, NDrawerContent, useDialog, useMessage } from 'naive-ui'
import { computed, ref } from 'vue'
import { importState } from '../stores/import'
import {
  clearNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationsState,
  removeNotification,
  unreadNotifications,
} from '../stores/notifications'
import { queryState } from '../stores/query'
import { uiState } from '../stores/ui'
import { activateEditorTab, workspaceState } from '../stores/workspace'
import type {
  AppNotification,
  NotificationPanel,
  NotificationTarget,
} from '../utils/notifications'

import { t, tt } from '../i18n'

const dialog = useDialog()
const message = useMessage()

const show = computed({
  get: () => uiState.notificationsOpen,
  set: (v: boolean) => {
    uiState.notificationsOpen = v
  },
})

const filter = ref<'all' | 'unread'>('all')

const visible = computed(() =>
  filter.value === 'unread'
    ? notificationsState.items.filter((n) => !n.read)
    : notificationsState.items,
)

const PANEL_LABEL: Record<NotificationPanel, string> = {
  connection: '连接管理',
  history: '执行历史',
  config: '三闸热更',
  ops: '会话 / 查询',
  watch: '变化流',
  grant: '授权矩阵',
  appearance: '外观设置',
  copy: 'COPY 向导',
  import: 'CSV 导入',
}

const KIND_LABEL: Record<AppNotification['kind'], string> = {
  success: '完成',
  info: '信息',
  warn: '注意',
  error: '失败',
}

function openPanel(panel: NotificationPanel): void {
  switch (panel) {
    case 'connection':
      uiState.connectionOpen = true
      break
    case 'history':
      uiState.historyOpen = true
      break
    case 'config':
      uiState.configOpen = true
      break
    case 'ops':
      uiState.opsOpen = true
      break
    case 'watch':
      uiState.watchOpen = true
      break
    case 'grant':
      uiState.grantOpen = true
      break
    case 'appearance':
      uiState.appearanceOpen = true
      break
    case 'copy':
      uiState.copyOpen = true
      break
    case 'import':
      importState.visible = true
      break
  }
}

function targetLabel(target: NotificationTarget): string {
  if (target.kind === 'result') return t('查看结果')
  return tt`打开${t(PANEL_LABEL[target.panel])}`
}

function jump(n: AppNotification): void {
  markNotificationRead(n.id)
  const target = n.target
  if (!target) return
  if (target.kind === 'panel') {
    show.value = false
    openPanel(target.panel)
    return
  }

  const editor = workspaceState.tabs.find((t) => t.key === target.editorKey)
  const result = queryState.tabs.find((t) => t.key === target.tabKey)
  if (!editor || !result) {
    message.warning(t('结果页或编辑器标签已关闭，通知仍可在列表里回看。'), {
      duration: 5000,
    })
    return
  }
  show.value = false
  activateEditorTab(editor.key)
  queryState.activeKeys[editor.key] = result.key
}

function onItemClick(n: AppNotification): void {
  if (n.target) jump(n)
  else markNotificationRead(n.id)
}

function timeLabel(at: number): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return '—'
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay ? tt`今天 ${clock}` : `${d.getMonth() + 1}/${d.getDate()} ${clock}`
}

function markAll() {
  const n = markAllNotificationsRead()
  if (n > 0) message.success(tt`已标记 ${n} 条为已读`)
}

function confirmClear() {
  if (notificationsState.items.length === 0) return
  dialog.warning({
    title: t('清空通知'),
    content: tt`确定清空 ${notificationsState.items.length} 条通知？通知只保留在本次会话，清空后无法恢复。`,
    positiveText: t('清空'),
    negativeText: t('取消'),
    onPositiveClick: () => clearNotifications(),
  })
}
</script>

<template>
  <NDrawer v-model:show="show" :width="480" placement="right">
    <NDrawerContent :title="$t('通知中心')" closable>
      <div class="body">
        <div class="toolbar">
          <div class="segmented">
            <button
              class="seg-btn"
              :class="{ active: filter === 'all' }"
              @click="filter = 'all'"
            >
              {{ $t("全部") }}
              <span class="count">{{ notificationsState.items.length }}</span>
            </button>
            <button
              class="seg-btn"
              :class="{ active: filter === 'unread' }"
              @click="filter = 'unread'"
            >
              {{ $t("未读") }}
              <span class="count">{{ unreadNotifications }}</span>
            </button>
          </div>
          <span class="spacer" />
          <NButton
            size="tiny"
            quaternary
            :disabled="unreadNotifications === 0"
            @click="markAll"
          >
            {{ $t("全部已读") }}
          </NButton>
          <NButton
            size="tiny"
            quaternary
            :disabled="notificationsState.items.length === 0"
            @click="confirmClear"
          >
            {{ $t("清空") }}
          </NButton>
        </div>

        <div v-if="visible.length === 0" class="empty-state">
          <strong>{{ filter === 'unread' ? $t('没有未读通知') : $t('还没有通知') }}</strong>
          <div class="sub">
            {{ $t("后台查询收尾、CSV 导入结果、变化流游标重置等事件会出现在这里，\n            方便离开现场后回看。通知只在本次会话内存中保留，不落盘。") }}
          </div>
        </div>

        <div v-else class="list">
          <div
            v-for="n in visible"
            :key="n.id"
            class="item"
            :class="[n.kind, { unread: !n.read }]"
            :title="n.target ? targetLabel(n.target) : $t('点击标记为已读')"
            @click="onItemClick(n)"
          >
            <span class="dot" />
            <div class="main">
              <div class="head">
                <span class="title">{{ n.title }}</span>
                <span v-if="n.code" class="code-badge">{{ n.code }}</span>
                <span class="spacer" />
                <span class="time">{{ timeLabel(n.at) }}</span>
              </div>
              <pre v-if="n.detail" class="detail">{{ n.detail }}</pre>
              <div class="foot">
                <span class="kind" :class="n.kind">{{ $t(KIND_LABEL[n.kind]) }}</span>
                <span v-if="!n.read" class="unread-tag">{{ $t("未读") }}</span>
                <span class="spacer" />
                <NButton
                  v-if="n.target"
                  size="tiny"
                  quaternary
                  @click.stop="jump(n)"
                >
                  {{ targetLabel(n.target) }}
                </NButton>
                <NButton
                  size="tiny"
                  quaternary
                  :title="$t('从通知列表移除（不影响结果页/面板）')"
                  @click.stop="removeNotification(n.id)"
                >
                  {{ $t("移除") }}
                </NButton>
              </div>
            </div>
          </div>
        </div>

        <div class="foot-hint">
          {{ $t("通知只存在本会话；不写日志、不落盘。单条可“移除”，全部可“清空”。") }}
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

.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.segmented {
  display: flex;
  padding: 2px;
  gap: 2px;
  border-radius: 9px;
  background: var(--surface-soft);
  border: 1px solid var(--border-subtle);
}

.seg-btn {
  border: none;
  background: transparent;
  color: var(--text-soft);
  font-size: 11.5px;
  padding: 4px 9px;
  border-radius: 7px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.seg-btn.active {
  background: var(--panel-strong);
  color: var(--text);
  font-weight: 650;
  box-shadow: 0 1px 5px rgb(10 16 28 / 10%);
}

.count {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--muted);
  background: var(--surface-soft);
  border-radius: 7px;
  padding: 0 5px;
}

.seg-btn.active .count {
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.spacer {
  flex: 1;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  overflow: auto;
  min-height: 0;
  padding-right: 2px;
}

.item {
  display: flex;
  gap: 9px;
  padding: 9px 10px;
  border-radius: 10px;
  border: 1px solid var(--border-subtle);
  background: var(--surface-soft);
  cursor: default;
}

.item[title] {
  cursor: pointer;
}

.item:hover {
  border-color: var(--border-strong);
}

.item.unread {
  background: var(--panel-raised);
  border-color: var(--accent-border);
}

.item.unread.success {
  border-left: 3px solid var(--ok);
}

.item.unread.warn {
  border-left: 3px solid var(--warn);
}

.item.unread.error {
  border-left: 3px solid var(--danger);
}

.item.unread.info {
  border-left: 3px solid var(--accent);
}

.dot {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--muted);
}

.item.success .dot {
  background: var(--ok);
}

.item.warn .dot {
  background: var(--warn);
}

.item.error .dot {
  background: var(--danger);
}

.item.info .dot {
  background: var(--accent);
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.title {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--muted);
  flex: 0 0 auto;
}

.detail {
  margin: 0;
  font-family: var(--mono);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-soft);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 96px;
  overflow: auto;
}

.foot {
  display: flex;
  align-items: center;
  gap: 6px;
}

.kind {
  font-size: 9.5px;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0 5px;
}

.kind.success {
  color: var(--ok);
  border-color: var(--ok-border);
  background: var(--ok-soft);
}

.kind.warn {
  color: var(--warn);
  border-color: var(--warn-border);
  background: var(--warn-soft);
}

.kind.error {
  color: var(--danger);
  border-color: var(--danger-border);
  background: var(--danger-soft);
}

.kind.info {
  color: var(--accent-strong);
  border-color: var(--accent-border);
  background: var(--accent-soft);
}

.unread-tag {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--accent-strong);
}

.foot-hint {
  flex: 0 0 auto;
  font-size: 10px;
  line-height: 1.5;
  color: var(--muted);
  border-top: 1px solid var(--border-subtle);
  padding-top: 8px;
}

.empty-state {
  height: auto;
  flex: 1;
}
</style>
