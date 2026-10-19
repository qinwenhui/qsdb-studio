<script setup lang="ts">
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  LogicalPosition,
  LogicalSize,
  availableMonitors,
  getCurrentWindow,
} from '@tauri-apps/api/window'
import {
  NButton,
  NSelect,
  useDialog,
  useMessage,
  type SelectOption,
} from 'naive-ui'
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue'
import brandMark from '../assets/qsdb-mark.png'
import AboutPanel from '../components/AboutPanel.vue'
import ActivityRail from '../components/ActivityRail.vue'
import AppearancePanel from '../components/AppearancePanel.vue'
import CommandPalette from '../components/CommandPalette.vue'
import ConfigPanel from '../components/ConfigPanel.vue'
import ConnectionDrawer from '../components/ConnectionDrawer.vue'
import CopyPanel from '../components/CopyPanel.vue'
import FileBrowser from '../components/FileBrowser.vue'
import GrantsPanel from '../components/GrantsPanel.vue'
import HistoryDrawer from '../components/HistoryDrawer.vue'
import ImportPanel from '../components/ImportPanel.vue'
import MetadataTree from '../components/MetadataTree.vue'
import NotificationCenter from '../components/NotificationCenter.vue'
import OpsPanel from '../components/OpsPanel.vue'
import PartitionPanel from '../components/PartitionPanel.vue'
import ShortcutHelp from '../components/ShortcutHelp.vue'
import SqlWorkbench from '../components/SqlWorkbench.vue'
import WatchPanel from '../components/WatchPanel.vue'
import {
  appState,
  connectProfile,
  disconnect,
  isConnected,
  refreshProfiles,
  toStudioError,
} from '../stores/app'
import { appInfo, loadAppInfo } from '../stores/appInfo'
import { colorForProfile } from '../stores/connectionColors'
import { layoutState } from '../stores/layout'
import { queryState } from '../stores/query'
import { openSqlFile, openSqlFileDialog, saveActiveSql } from '../stores/sqlFiles'
import { uiState } from '../stores/ui'
import {
  bindActiveProfile,
  cycleEditorTab,
  ensureBindings,
  workspaceState,
} from '../stores/workspace'
import { errorHint } from '../utils/errors'

import { language, t, tt } from '../i18n'

const message = useMessage()
const dialog = useDialog()
const connecting = computed(() => appState.connecting)

const profileOptions = computed<SelectOption[]>(() =>
  appState.profiles.map((p) => ({
    label: `${p.name}  ·  ${p.url}`,
    value: p.id,
  })),
)

/** 连接选择器里带颜色点与在线状态（多连接一眼分清）。 */
function renderProfileOption(option: SelectOption) {
  const id = String(option.value)
  const open = isConnected(id)
  const readOnly = appState.profiles.find((p) => p.id === id)?.readOnly ?? false
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: '7px', minWidth: '0' } },
    [
      h('i', {
        style: {
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          flex: '0 0 7px',
          background: colorForProfile(id),
        },
      }),
      h(
        'span',
        { style: { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis' } },
        String(option.label ?? ''),
      ),
      readOnly
        ? h(
            'span',
            {
              style: {
                flex: '0 0 auto',
                fontSize: '9.5px',
                padding: '0 5px',
                borderRadius: '7px',
                background: 'var(--warn-soft)',
                color: 'var(--warn)',
              },
            },
            t('只读'),
          )
        : null,
      open
        ? h(
            'span',
            {
              style: {
                flex: '0 0 auto',
                fontSize: '9.5px',
                padding: '0 5px',
                borderRadius: '7px',
                background: 'var(--ok-soft)',
                color: 'var(--ok)',
              },
            },
            t('已连接'),
          )
        : null,
    ],
  )
}

/** 顶栏选择器 = 当前编辑器标签绑定的连接（多标签各自绑定）。 */
const selectedProfileId = computed<string | null>({
  get: () => appState.activeProfileId,
  set: (id) => bindActiveProfile(id),
})

const activeOpen = computed(() => isConnected(appState.activeProfileId))
const boundProfile = computed(
  () => appState.profiles.find((p) => p.id === appState.activeProfileId) ?? null,
)
const tabCountForActive = computed(
  () =>
    workspaceState.tabs.filter(
      (t) => t.profileId && t.profileId === appState.activeProfileId,
    ).length,
)

const identity = computed(() => {
  if (!appState.connection) return t('未连接')
  if (appState.session) {
    return `${appState.session.user} @ ${appState.session.defaultDb}`
  }
  if (appState.connection.auth.kind === 'bearer') return t('静态 Token（无会话身份）')
  if (appState.connection.auth.kind === 'none') return t('匿名连接')
  return t('未登录（Basic 凭证未通过）')
})

const version = computed(() => appState.connection?.version ?? '')
const role = computed(() => appState.session?.role ?? '')

/** 本地正在执行的查询数（服务端全量见“会话 / 运行查询”面板）。 */
const localRunning = computed(
  () =>
    queryState.tabs.filter(
      (t) => t.status === 'running' || t.status === 'streaming',
    ).length,
)
const tabCount = computed(() => workspaceState.tabs.length)

function openOps() {
  if (appState.connection) uiState.opsOpen = true
}

onMounted(() => {
  void loadAppInfo()
})

onMounted(async () => {
  try {
    await refreshProfiles()
    ensureBindings(appState.profiles.map((p) => p.id))
    if (appState.profiles.length === 0) {
      uiState.connectionOpen = true
    }
  } catch (e) {
    const info = (e as { info?: Parameters<typeof errorHint>[0] }).info
    message.error(tt`读取连接档案失败：${info ? errorHint(info) : String(e)}`)
  }
})

async function openSqlFromDialog() {
  try {
    const outcome = await openSqlFileDialog()
    if (!outcome) return
    message.success(
      outcome.existing
        ? tt`已切换到已打开的文件：${outcome.tab.title}`
        : tt`已打开 ${outcome.tab.title}`,
    )
  } catch (e) {
    const err = toStudioError(e)
    message.error(`${err.code ?? err.kind}: ${err.message}`, { duration: 6000 })
  }
}

async function saveSqlFile(saveAs: boolean) {
  try {
    const outcome = await saveActiveSql(saveAs)
    if (outcome?.saved) message.success(tt`已保存 ${outcome.path}`)
  } catch (e) {
    const err = toStudioError(e)
    message.error(`${err.code ?? err.kind}: ${err.message}`, { duration: 6000 })
  }
}

function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  return Boolean(
    el?.closest('input, textarea, select, [contenteditable="true"], .monaco-editor'),
  )
}

/** 全局快捷键：命令面板、帮助、SQL 文件。用捕获阶段，避免 Monaco 先吃掉。 */
function onGlobalKeydown(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  // Ctrl+Tab / Ctrl+Shift+Tab 循环标签；Ctrl+PageUp/PageDown 同义。
  if (
    (e.ctrlKey && key === 'tab') ||
    (mod && !e.altKey && (key === 'pagedown' || key === 'pageup'))
  ) {
    e.preventDefault()
    e.stopPropagation()
    cycleEditorTab(key === 'pageup' || (key === 'tab' && e.shiftKey) ? -1 : 1)
    return
  }
  if (mod && !e.altKey && !e.shiftKey && key === 'b') {
    e.preventDefault()
    e.stopPropagation()
    layoutState.sidebarCollapsed = !layoutState.sidebarCollapsed
    return
  }
  if (mod && !e.altKey && (key === 'k' || (e.shiftKey && key === 'p'))) {
    e.preventDefault()
    e.stopPropagation()
    uiState.commandOpen = true
    return
  }
  if (mod && !e.altKey && key === 'o') {
    e.preventDefault()
    e.stopPropagation()
    void openSqlFromDialog()
    return
  }
  if (mod && !e.altKey && key === 's') {
    e.preventDefault()
    e.stopPropagation()
    void saveSqlFile(e.shiftKey)
    return
  }
  if (e.key === '?' && !mod && !e.altKey && !isTypingTarget(e)) {
    e.preventDefault()
    uiState.helpOpen = true
  }
}

// ---------------------------------------------------------------------------
// 拖拽 .sql 进窗口
// ---------------------------------------------------------------------------

const dragOver = ref(false)
const dragUnlisteners: UnlistenFn[] = []

function pathsOf(payload: unknown): string[] {
  const paths = (payload as { paths?: unknown } | null)?.paths
  return Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
}

async function openDropped(paths: string[]) {
  dragOver.value = false
  const sqlPaths = paths.filter((p) => /\.sql$/i.test(p))
  if (sqlPaths.length === 0) {
    message.warning(t('拖入的文件里没有 .sql；QSDB Studio 只打开 UTF-8 的 SQL 文件。'))
    return
  }
  let opened = 0
  const errors: string[] = []
  for (const p of sqlPaths) {
    try {
      await openSqlFile(p)
      opened++
    } catch (e) {
      const err = toStudioError(e)
      errors.push(`${p}: ${err.message}`)
    }
  }
  if (opened > 0) message.success(tt`已打开 ${opened} 个 SQL 文件`)
  if (errors.length > 0) {
    message.error(errors.join('\n').slice(0, 900), { duration: 8000 })
  }
}

onMounted(async () => {
  try {
    dragUnlisteners.push(
      await listen<unknown>('tauri://drag-enter', (ev) => {
        const paths = pathsOf(ev.payload)
        dragOver.value = paths.length === 0 || paths.some((p) => /\.sql$/i.test(p))
      }),
      await listen<unknown>('tauri://drag-over', () => {
        dragOver.value = true
      }),
      await listen<unknown>('tauri://drag-leave', () => {
        dragOver.value = false
      }),
      await listen<unknown>('tauri://drag-drop', (ev) => {
        void openDropped(pathsOf(ev.payload))
      }),
    )
  } catch {
    // 拖拽事件不可用（例如非桌面壳）时，其余入口（菜单/快捷键）仍可用。
  }
})

onBeforeUnmount(() => {
  for (const un of dragUnlisteners) un()
  dragUnlisteners.length = 0
})

// ---------------------------------------------------------------------------
// 窗口尺寸/位置恢复
// ---------------------------------------------------------------------------

const windowUnlisteners: UnlistenFn[] = []

async function initWindowState() {
  try {
    const win = getCurrentWindow()
    const w = layoutState.windowWidth
    const h = layoutState.windowHeight
    if (w !== null && h !== null && w >= 800 && h >= 520) {
      await win.setSize(new LogicalSize(w, h))
    }

    // 位置只有在仍与某块显示器相交时才恢复，避免换显示器后窗口落在屏幕外。
    const x = layoutState.windowX
    const y = layoutState.windowY
    if (x !== null && y !== null) {
      try {
        const lw = w ?? 1200
        const lh = h ?? 800
        const monitors = await availableMonitors()
        const visible = monitors.some((m) => {
          const mx = m.position.x / m.scaleFactor
          const my = m.position.y / m.scaleFactor
          const mw = m.size.width / m.scaleFactor
          const mh = m.size.height / m.scaleFactor
          return x < mx + mw && x + lw > mx && y < my + mh && y + lh > my
        })
        if (visible) {
          await win.setPosition(new LogicalPosition(x, y))
        } else {
          layoutState.windowX = null
          layoutState.windowY = null
        }
      } catch {
        // 拿不到显示器信息：保守起见不恢复位置。
      }
    }

    if (layoutState.windowMaximized) await win.maximize()

    windowUnlisteners.push(
      await win.onMoved(async ({ payload }) => {
        const scale = await win.scaleFactor()
        layoutState.windowX = Math.round(payload.x / scale)
        layoutState.windowY = Math.round(payload.y / scale)
      }),
      await win.onResized(async ({ payload }) => {
        const scale = await win.scaleFactor()
        const maximized = await win.isMaximized()
        layoutState.windowMaximized = maximized
        if (!maximized) {
          layoutState.windowWidth = Math.round(payload.width / scale)
          layoutState.windowHeight = Math.round(payload.height / scale)
        }
      }),
    )
  } catch {
    // 权限或平台不支持：不恢复窗口状态，其余布局（侧栏/分割）仍生效。
  }
}

onMounted(() => {
  void initWindowState()
})

onBeforeUnmount(() => {
  for (const un of windowUnlisteners) un()
  windowUnlisteners.length = 0
})

onMounted(() => window.addEventListener('keydown', onGlobalKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown, true))

async function onConnect() {
  if (!appState.activeProfileId) {
    message.warning(t('请先选择一个连接（或新建连接）'))
    uiState.connectionOpen = true
    return
  }
  const id = appState.activeProfileId
  try {
    await connectProfile(id)
    bindActiveProfile(id)
    message.success(tt`已连接 ${appState.connection?.profileName ?? ''} · ${version.value}`)
  } catch (e) {
    const info = (e as { info?: Parameters<typeof errorHint>[0] }).info
    message.error(
      info
        ? `${info.message}\n${errorHint(info)}`
        : e instanceof Error
          ? e.message
          : String(e),
      { duration: 6500 },
    )
  }
}

const sidebarResizing = ref(false)

/** 侧栏拖拽调宽（持久化到 layoutState）。 */
function startSidebarResize(e: PointerEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startWidth = layoutState.sidebarWidth
  sidebarResizing.value = true
  const move = (ev: PointerEvent) => {
    layoutState.sidebarWidth = Math.max(
      220,
      Math.min(560, startWidth + ev.clientX - startX),
    )
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    sidebarResizing.value = false
  }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

async function onDisconnect() {
  const id = appState.activeProfileId
  if (!id) return
  const name = boundProfile.value?.name ?? id
  const doDisconnect = async () => {
    await disconnect(id)
    message.info(
      tabCountForActive.value > 1
        ? tt`已断开「${name}」；${tabCountForActive.value} 个标签仍绑定它，可重新连接。`
        : tt`已断开「${name}」`,
    )
  }
  if (tabCountForActive.value > 1) {
    dialog.warning({
      title: t('断开连接'),
      content: tt`当前有 ${tabCountForActive.value} 个编辑器标签绑定「${name}」。断开后这些标签的查询会失败，但 SQL 草稿与已有结果保留。`,
      positiveText: t('断开'),
      negativeText: t('取消'),
      onPositiveClick: doDisconnect,
    })
    return
  }
  await doDisconnect()
}
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <img class="brand-mark" :src="brandMark" alt="" width="30" height="30" />
        <div class="brand-text">
          <span class="brand-name">QSDB Studio</span>
          <span class="brand-sub">{{ $t("查询 · 分区 · 观测") }}</span>
        </div>
      </div>

      <div class="conn-picker">
        <NSelect
          v-model:value="selectedProfileId"
          :options="profileOptions"
          :render-label="renderProfileOption"
          :placeholder="$t('选择连接')"
          size="small"
          style="width: 230px"
          :disabled="connecting"
        />
        <NButton
          v-if="appState.activeProfileId && !activeOpen"
          type="primary"
          size="small"
          :loading="connecting"
          @click="onConnect"
        >
          {{ language.locale === 'en' ? 'Connect' : '连接' }}
        </NButton>
        <NButton v-else-if="activeOpen" size="small" @click="onDisconnect">{{ $t("断开") }}</NButton>
      </div>

      <div class="conn-meta">
        <template v-if="activeOpen">
          <span class="chip ok">
            <i class="dot" />
            {{ version }}
          </span>
          <span v-if="boundProfile" class="chip">
            <i class="conn-color" :style="{ background: colorForProfile(boundProfile.id) }" />
            {{ boundProfile.name }}
          </span>
          <span class="identity" :title="identity">{{ identity }}</span>
          <span
            v-if="boundProfile?.readOnly"
            class="chip warn"
            :title="$t('只读连接：执行前拦截写语句（SELECT/SHOW/EXPLAIN 仍可用）')"
          >
            {{ $t("只读") }}
          </span>
          <span v-if="role" class="chip">{{ role }}</span>
          <span v-if="appState.defaultDb" class="chip">{{ $t("默认库") }} {{ appState.defaultDb }}</span>
        </template>
        <template v-else-if="appState.activeProfileId">
          <span class="chip warn">{{ $t("未连接") }}</span>
          <span v-if="boundProfile" class="identity">{{ boundProfile.name }}</span>
        </template>
        <span v-else class="chip">{{ $t("未绑定连接") }}</span>
        <span
          v-if="appState.connectedIds.length > 1"
          class="chip ok soft"
          :title="$t('同一时间可以打开多条连接（每个标签各自绑定）')"
        >
          {{ $t("已打开") }} {{ appState.connectedIds.length }} {{ $t("条连接") }}
        </span>
      </div>

      <div class="spacer" />

      <button
        type="button"
        class="command-trigger"
        :title="$t('搜索表或执行命令（Ctrl+K）')"
        :aria-label="$t('搜索表或执行命令')"
        @click="uiState.commandOpen = true"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="10.8" cy="10.8" r="6.3" stroke="currentColor" stroke-width="1.6" />
          <path
            d="m15.5 15.5 4.2 4.2"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        <span class="command-label">{{ $t("搜索表或执行命令") }}</span>
        <kbd>Ctrl K</kbd>
      </button>
    </header>

    <div class="body">
      <ActivityRail />
      <div
        class="sidebar-wrap"
        :class="{
          collapsed: layoutState.sidebarCollapsed,
          resizing: sidebarResizing,
        }"
        :style="{
          width: layoutState.sidebarCollapsed
            ? '0px'
            : layoutState.sidebarWidth + 'px',
        }"
      >
        <aside
          class="sidebar"
          :style="{ width: layoutState.sidebarWidth + 'px' }"
          :aria-hidden="layoutState.sidebarCollapsed"
          :inert="layoutState.sidebarCollapsed || undefined"
        >
          <MetadataTree />
        </aside>
        <div
          v-show="!layoutState.sidebarCollapsed"
          class="sidebar-grip"
          :title="$t('拖动调整侧栏宽度')"
          @pointerdown="startSidebarResize"
        />
      </div>
      <main class="workbench">
        <SqlWorkbench />
      </main>
    </div>

    <footer class="statusbar" role="status" :aria-label="$t('全局状态')">
      <button
        class="status-btn"
        :title="$t('打开连接管理')"
        @click="uiState.connectionOpen = true"
      >
        <i
          class="status-conn-dot"
          :style="{
            background: appState.activeProfileId
              ? colorForProfile(appState.activeProfileId)
              : 'var(--muted)',
          }"
        />
        <span class="status-strong">{{ boundProfile?.name ?? $t('未绑定连接') }}</span>
        <span class="status-chip" :class="activeOpen ? 'ok' : 'warn'">
          {{ activeOpen ? $t('已连接') : appState.activeProfileId ? $t('未连接') : $t('未绑定') }}
        </span>
        <span v-if="activeOpen" class="status-text status-identity">{{ identity }}</span>
        <span v-if="boundProfile?.readOnly" class="status-chip warn">{{ $t("只读") }}</span>
      </button>
      <span v-if="role" class="status-text">{{ $t("角色") }} {{ role }}</span>
      <span v-if="activeOpen && appState.defaultDb" class="status-text">
        {{ $t("库") }} {{ appState.defaultDb }}
      </span>

      <span class="spacer" />

      <button
        class="status-btn"
        :disabled="!appState.connection"
        :title="appState.connection ? $t('打开会话 / 运行查询') : $t('未连接')"
        @click="openOps"
      >
        <span v-if="localRunning > 0" class="pulse-dot" />
        {{ localRunning > 0 ? (language.locale === 'en' ? `${localRunning} running` : `${localRunning} 个执行中`) : $t('空闲') }}
      </button>
      <span class="status-text">{{ tabCount }} {{ $t("标签") }}</span>
      <span class="status-text">{{ appState.connectedIds.length }} {{ $t("连接") }}</span>
      <span v-if="version" class="status-text mono" :title="$t('服务端版本')">v{{ version }}</span>
      <button
        type="button"
        class="status-btn status-about"
        :title="$t('关于 QSDB Studio（客户端版本 / 作者 / 许可证）')"
        @click="uiState.aboutOpen = true"
      >
        <svg class="about-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.6" />
          <path d="M12 10.4v5.2M12 7.6h.01" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
        </svg>
        <span class="status-app-version mono">
          {{ appInfo.version ? `Studio v${appInfo.version}` : $t('关于 Studio') }}
        </span>
      </button>
    </footer>

    <ConnectionDrawer />
    <AboutPanel />
    <FileBrowser />
    <HistoryDrawer />
    <NotificationCenter />
    <PartitionPanel />
    <ConfigPanel />
    <OpsPanel />
    <WatchPanel />
    <GrantsPanel />
    <ImportPanel />
    <CopyPanel />
    <AppearancePanel />
    <CommandPalette v-model:show="uiState.commandOpen" />
    <ShortcutHelp v-model:show="uiState.helpOpen" />

    <div v-if="dragOver" class="drop-overlay">
      <div class="drop-card">
        <div class="drop-title">{{ $t("松开以打开 SQL 文件") }}</div>
        <div class="drop-sub">{{ $t("只支持 UTF-8 编码的 .sql；会打开到新标签并继承当前连接") }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shell {
  /* 桌面窗口：用 100vh 而不是 100% —— 不依赖 Naive UI provider 包装层的
     高度链，避免内容高度塌缩（结果网格会把布局撑坏）。 */
  position: relative;
  z-index: 2;
  height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  min-width: 0;
  overflow: hidden;
}

.topbar {
  position: relative;
  height: 60px;
  flex: 0 0 60px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  border-radius: 18px;
  background: var(--panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-soft);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.35);
  backdrop-filter: blur(var(--glass-blur)) saturate(1.35);
  z-index: 10;
  overflow: hidden;
  animation: panel-in 0.5s cubic-bezier(0.22, 0.68, 0.24, 1) both;
}

.topbar::before {
  content: '';
  position: absolute;
  left: 18%;
  right: 18%;
  bottom: -1px;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--accent-border),
    rgba(90, 215, 255, 0.35),
    var(--accent-border),
    transparent
  );
  opacity: 0.8;
  pointer-events: none;
}

.topbar::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 18px;
  background: linear-gradient(120deg, rgba(255, 255, 255, 0.2), transparent 38%);
  pointer-events: none;
}

html[data-theme='dark'] .topbar::after {
  background: linear-gradient(120deg, rgba(255, 255, 255, 0.05), transparent 42%);
}

.topbar > * {
  position: relative;
  z-index: 1;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-right: 12px;
  border-right: 1px solid var(--border-subtle);
  height: 34px;
}

.brand-mark {
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 9px;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.16),
    0 0 0 1px rgba(0, 0, 0, 0.04),
    0 8px 22px -9px rgba(var(--accent-rgb), 0.75);
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}

.brand-name {
  font-weight: 720;
  font-size: 14.5px;
  letter-spacing: -0.01em;
  background: linear-gradient(100deg, var(--text) 20%, var(--accent) 120%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.brand-sub {
  font-size: 9.5px;
  color: var(--muted);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.conn-picker {
  display: flex;
  align-items: center;
  gap: 8px;
}

.conn-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.identity {
  font-size: 12px;
  color: var(--text-soft);
  font-weight: 550;
  max-width: 210px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  display: inline-block;
  box-shadow: 0 0 0 3px var(--ok-soft);
}

.conn-color {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 5px;
}

.spacer {
  flex: 1;
}

.command-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  min-width: 220px;
  max-width: 300px;
  padding: 0 8px 0 11px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background:
    linear-gradient(180deg, var(--surface-raised), var(--surface-soft));
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.16) inset;
  color: var(--muted);
  cursor: pointer;
  transition:
    border-color 0.18s ease,
    background 0.18s ease,
    color 0.18s ease,
    transform 0.18s ease,
    box-shadow 0.2s ease;
}

.command-trigger:hover {
  border-color: var(--accent-border);
  color: var(--text-soft);
  transform: translateY(-1px);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.18) inset,
    0 8px 22px -16px rgba(var(--accent-rgb), 0.55);
}

.command-trigger svg {
  width: 15px;
  height: 15px;
  flex: none;
  transition: transform 0.18s ease;
}

.command-trigger:hover svg {
  transform: scale(1.08);
  color: var(--accent);
}

.command-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
}

.command-trigger kbd {
  flex: none;
  padding: 2px 5px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 5px;
  background: var(--surface-soft);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 9px;
  line-height: 1.1;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 10px;
}

.sidebar-wrap {
  position: relative;
  flex: 0 0 auto;
  min-height: 0;
  display: flex;
  overflow: hidden;
  transition:
    width 0.27s cubic-bezier(0.22, 0.68, 0.24, 1),
    opacity 0.2s ease;
}

.sidebar-wrap.collapsed {
  opacity: 0;
  pointer-events: none;
}

.sidebar-wrap.resizing {
  transition: none;
}

.sidebar {
  width: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  flex: none;
  border-radius: 18px;
  background: var(--panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-soft);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.35);
  backdrop-filter: blur(var(--glass-blur)) saturate(1.35);
  overflow: hidden;
  transition:
    transform 0.27s cubic-bezier(0.22, 0.68, 0.24, 1),
    opacity 0.2s ease;
  animation: panel-in 0.55s 0.04s cubic-bezier(0.22, 0.68, 0.24, 1) both;
}

.sidebar-wrap.collapsed .sidebar {
  transform: translateX(-12px) scale(0.985);
  opacity: 0;
}

.sidebar-grip {
  position: absolute;
  top: 6px;
  right: 0;
  bottom: 6px;
  width: 7px;
  z-index: 5;
  cursor: col-resize;
  border-radius: 5px;
}

.sidebar-grip:hover {
  background: linear-gradient(
    to right,
    transparent 2px,
    var(--accent-border) 2px,
    var(--accent-border) 3px,
    transparent 3px
  );
}

.workbench {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-radius: 18px;
  background: var(--panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-soft);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.35);
  backdrop-filter: blur(var(--glass-blur)) saturate(1.35);
  overflow: hidden;
  animation: panel-in 0.58s 0.07s cubic-bezier(0.22, 0.68, 0.24, 1) both;
  transition: border-color 0.24s ease, box-shadow 0.24s ease;
}

.workbench:hover {
  border-color: var(--border-strong);
}

.statusbar {
  flex: 0 0 28px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-soft);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.35);
  backdrop-filter: blur(var(--glass-blur)) saturate(1.35);
  font-size: 10.5px;
  color: var(--muted);
  overflow: hidden;
  white-space: nowrap;
  animation: panel-in 0.6s 0.1s cubic-bezier(0.22, 0.68, 0.24, 1) both;
}

@keyframes panel-in {
  from {
    opacity: 0;
    transform: translateY(7px) scale(0.995);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.status-btn {
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  border-radius: 6px;
  cursor: pointer;
  min-width: 0;
}

.status-btn:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text-soft);
}

.status-btn:disabled {
  cursor: default;
  opacity: 0.7;
}

.status-conn-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
  box-shadow: 0 0 0 2px var(--surface-soft);
}

.status-strong {
  color: var(--text);
  font-weight: 650;
  font-size: 11px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-identity {
  max-width: 220px;
  color: var(--text-soft);
}

.status-about {
  gap: 5px;
}

.about-icon {
  width: 12px;
  height: 12px;
  flex: none;
  color: var(--muted);
}

.status-about:hover .about-icon {
  color: var(--accent);
}

.status-app-version {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-chip {
  font-size: 9.5px;
  padding: 0 5px;
  border-radius: 7px;
  border: 1px solid var(--border);
  color: var(--muted);
  background: var(--surface-soft);
}

.status-chip.ok {
  color: var(--ok);
  background: var(--ok-soft);
  border-color: var(--ok-border);
}

.status-chip.warn {
  color: var(--warn);
  background: var(--warn-soft);
  border-color: var(--warn-border);
}

.pulse-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: status-pulse 1s ease-in-out infinite;
}

@keyframes status-pulse {
  50% {
    opacity: 0.3;
  }
}

.drop-overlay {
  position: fixed;
  inset: 10px;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 22px;
  border: 2px dashed var(--accent);
  background: color-mix(in srgb, var(--accent-soft) 72%, transparent);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  pointer-events: none;
}

.drop-card {
  padding: 22px 30px;
  border-radius: 16px;
  background: var(--panel);
  border: 1px solid var(--accent-border);
  box-shadow: var(--shadow-soft);
  text-align: center;
}

.drop-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}

.drop-sub {
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--muted);
}

@media (max-width: 1560px) {
  .command-trigger {
    min-width: 180px;
  }
}

@media (max-width: 1280px) {
  .brand-sub,
  .identity,
  .status-identity {
    display: none;
  }

  .conn-picker :deep(.n-select) {
    width: 190px !important;
  }

  .command-trigger {
    width: 34px;
    min-width: 0;
    padding: 0;
    justify-content: center;
  }

  .command-trigger .command-label,
  .command-trigger kbd {
    display: none;
  }
}

@media (max-width: 1120px) {
  .brand-text,
  .conn-meta .chip {
    display: none;
  }

  .statusbar .status-text {
    display: none;
  }
}

@media (max-width: 900px) {
  .body {
    gap: 8px;
  }

  .topbar {
    gap: 8px;
    padding: 0 10px;
  }

  .conn-picker :deep(.n-select) {
    width: 154px !important;
  }
}

@media (max-width: 760px) {
  .command-trigger {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .topbar,
  .sidebar,
  .workbench,
  .statusbar {
    animation: none !important;
  }

  .sidebar-wrap,
  .sidebar {
    transition: none !important;
  }
}
</style>
