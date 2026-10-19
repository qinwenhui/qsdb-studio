<script setup lang="ts">
// 左侧活动栏：类似 VS Code 的窄图标导航。
// 这里只做“打开哪个工作区面板”的编排；具体面板仍是既有抽屉/侧栏，
// 不引入第二条状态路径。
import { computed } from 'vue'
import { appState } from '../stores/app'
import { colorForProfile } from '../stores/connectionColors'
import { layoutState } from '../stores/layout'
import { unreadNotifications } from '../stores/notifications'
import { queryState } from '../stores/query'
import { uiState } from '../stores/ui'

interface RailTool {
  key: string
  label: string
  paths: string[]
  active: boolean
  disabled?: boolean
  badge?: number
  badgeKind?: 'accent' | 'danger'
  shortcut?: string
}

const connected = computed(() => Boolean(appState.connection))
const runningCount = computed(
  () =>
    queryState.tabs.filter(
      (t) => t.status === 'running' || t.status === 'streaming',
    ).length,
)
const unread = computed(() => unreadNotifications.value)
const connectionColor = computed(() =>
  appState.activeProfileId
    ? colorForProfile(appState.activeProfileId)
    : 'var(--muted)',
)

const TOOLS: RailTool[] = [
  {
    key: 'explorer',
    label: '数据浏览器',
    shortcut: 'Ctrl+B',
    paths: [
      'M4 5.5h16v13H4z',
      'M4 9.5h16',
      'M9.5 9.5v9',
    ],
    active: false,
  },
  {
    key: 'files',
    label: '文件管理（原始段文件）',
    paths: [
      'M3.4 6.3h6.1l1.8 2.1h9.3v9.9a1.8 1.8 0 0 1-1.8 1.8H5.2a1.8 1.8 0 0 1-1.8-1.8V6.3Z',
      'M3.4 8.4h17.2',
    ],
    active: false,
  },
  {
    key: 'history',
    label: '执行历史 / 收藏',
    paths: [
      'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
      'M12 7.2v5.1l3.3 1.9',
    ],
    active: false,
  },
  {
    key: 'connections',
    label: '连接管理',
    paths: [
      'M9 2.5v4.2M15 2.5v4.2',
      'M7 6.7h10v3.1a5 5 0 0 1-10 0V6.7Z',
      'M12 14.8v6.7',
    ],
    active: false,
  },
  {
    key: 'ops',
    label: '会话 / 运行查询',
    paths: ['M3 12h3.5l2.4-6.6 4.2 13.2 2.4-6.6H21'],
    active: false,
    badgeKind: 'accent',
  },
  {
    key: 'watch',
    label: '数据变化流',
    paths: [
      'M2.7 12S6.2 5.8 12 5.8 21.3 12 21.3 12 17.8 18.2 12 18.2 2.7 12 2.7 12Z',
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    ],
    active: false,
  },
  {
    key: 'grants',
    label: '授权矩阵',
    paths: [
      'M12 2.6 4.7 5.6v5.2c0 4.9 3.1 8.4 7.3 10 4.2-1.6 7.3-5.1 7.3-10V5.6L12 2.6Z',
      'm8.6 11.6 2.3 2.3 4.6-4.8',
    ],
    active: false,
  },
  {
    key: 'config',
    label: '三闸热更',
    paths: [
      'M4 6h16M4 12h16M4 18h16',
      'M9 4.2v3.6M15 10.2v3.6M7 16.2v3.6',
    ],
    active: false,
  },
  {
    key: 'copy',
    label: 'COPY 导出',
    paths: [
      'M4 15.5v4h16v-4',
      'M12 3v11',
      'm7.5 9.8 4.5 4.7 4.5-4.7',
    ],
    active: false,
  },
]

const BOTTOM_TOOLS: RailTool[] = [
  {
    key: 'notifications',
    label: '通知中心',
    paths: [
      'M12 3.3c-3.4 0-5.7 2.5-5.7 5.9v3c0 .7-.3 1.4-.8 1.9l-1 1c-.7.7-.2 1.9.8 1.9h13.4c1 0 1.5-1.2.8-1.9l-1-1c-.5-.5-.8-1.2-.8-1.9v-3c0-3.4-2.3-5.9-5.7-5.9Z',
      'M9.6 19a2.5 2.5 0 0 0 4.8 0',
    ],
    active: false,
    badgeKind: 'danger',
  },
  {
    key: 'help',
    label: '快捷键速查',
    paths: [
      'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
      'M9.6 9.3a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2 1-1.2 1.9v.2',
      'M12 16.8h.01',
    ],
    active: false,
  },
  {
    key: 'about',
    label: '关于 QSDB Studio',
    paths: [
      'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
      'M12 10.6v6.1',
      'M12 7.3h.01',
    ],
    active: false,
  },
  {
    key: 'appearance',
    label: '外观设置',
    paths: [
      'M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-.6-.3-1-.6-1.5-.3-.4-.6-.9-.6-1.5 0-1.1 1-2 2.1-2H16a5 5 0 0 0 5-5c0-3.9-4-6.2-9-6.2Z',
      'M7.6 10.4h.01M10 7.2h.01M14.4 7.2h.01',
    ],
    active: false,
  },
]

const mainTools = computed<RailTool[]>(() => {
  const active: Record<string, boolean> = {
    // 侧栏收起时仍保留“数据浏览器”选中态：再次点击（或 Ctrl+B）展开。
    explorer: true,
    files: uiState.filesOpen,
    history: uiState.historyOpen,
    connections: uiState.connectionOpen,
    ops: uiState.opsOpen,
    watch: uiState.watchOpen,
    grants: uiState.grantOpen,
    config: uiState.configOpen,
    copy: uiState.copyOpen,
  }
  return TOOLS.map((t) => ({
    ...t,
    active: active[t.key] ?? false,
    disabled: t.key !== 'explorer' && t.key !== 'history' && t.key !== 'connections' && !connected.value,
    badge: t.key === 'ops' ? runningCount.value : undefined,
  }))
})

const bottomTools = computed<RailTool[]>(() => {
  const active: Record<string, boolean> = {
    notifications: uiState.notificationsOpen,
    about: uiState.aboutOpen,
    help: uiState.helpOpen,
    appearance: uiState.appearanceOpen,
  }
  return BOTTOM_TOOLS.map((t) => ({
    ...t,
    active: active[t.key] ?? false,
    badge: t.key === 'notifications' ? unread.value : undefined,
  }))
})

function toggle(key: string) {
  switch (key) {
    case 'explorer':
      layoutState.sidebarCollapsed = !layoutState.sidebarCollapsed
      break
    case 'files':
      uiState.filesOpen = !uiState.filesOpen
      break
    case 'history':
      uiState.historyOpen = !uiState.historyOpen
      break
    case 'connections':
      uiState.connectionOpen = !uiState.connectionOpen
      break
    case 'ops':
      uiState.opsOpen = !uiState.opsOpen
      break
    case 'watch':
      uiState.watchOpen = !uiState.watchOpen
      break
    case 'grants':
      uiState.grantOpen = !uiState.grantOpen
      break
    case 'config':
      uiState.configOpen = !uiState.configOpen
      break
    case 'copy':
      uiState.copyOpen = !uiState.copyOpen
      break
    case 'notifications':
      uiState.notificationsOpen = !uiState.notificationsOpen
      break
    case 'about':
      uiState.aboutOpen = !uiState.aboutOpen
      break
    case 'help':
      uiState.helpOpen = !uiState.helpOpen
      break
    case 'appearance':
      uiState.appearanceOpen = !uiState.appearanceOpen
      break
  }
}

function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n)
}
</script>

<template>
  <nav class="rail" :aria-label="$t('工作区导航')">
    <div class="rail-group">
      <button
        v-for="tool in mainTools"
        :key="tool.key"
        type="button"
        class="rail-btn"
        :class="{ active: tool.active }"
        :disabled="tool.disabled"
        :aria-label="$t(tool.label)"
        :aria-pressed="tool.active"
        @click="toggle(tool.key)"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            v-for="(d, i) in tool.paths"
            :key="i"
            :d="d"
            stroke="currentColor"
            stroke-width="1.55"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span
          v-if="tool.badge && tool.badge > 0"
          class="rail-badge"
          :class="tool.badgeKind"
        >{{ badgeText(tool.badge) }}</span>
        <span class="rail-tip" aria-hidden="true">
          {{ tool.disabled ? $t('未连接') : $t(tool.label) }}
          <kbd v-if="tool.shortcut && !tool.disabled">{{ tool.shortcut }}</kbd>
        </span>
      </button>
    </div>

    <div class="rail-spacer" />

    <div class="rail-group bottom">
      <span class="rail-divider" aria-hidden="true" />
      <button
        v-for="tool in bottomTools"
        :key="tool.key"
        type="button"
        class="rail-btn"
        :class="{ active: tool.active }"
        :aria-label="$t(tool.label)"
        :aria-pressed="tool.active"
        @click="toggle(tool.key)"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            v-for="(d, i) in tool.paths"
            :key="i"
            :d="d"
            stroke="currentColor"
            stroke-width="1.55"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span
          v-if="tool.badge && tool.badge > 0"
          class="rail-badge"
          :class="tool.badgeKind"
        >{{ badgeText(tool.badge) }}</span>
        <span class="rail-tip" aria-hidden="true">{{ $t(tool.label) }}</span>
      </button>
    </div>

    <button
      type="button"
      class="rail-status"
      :style="{ '--conn-color': connectionColor }"
      :title="connected ? $t('连接已打开 · 点击连接管理') : $t('未连接 · 点击连接管理')"
      :aria-label="$t('连接状态')"
      @click="uiState.connectionOpen = true"
    >
      <span class="status-dot" :class="{ on: connected }" />
      <span class="rail-tip" aria-hidden="true">
        {{ connected ? $t('连接已打开') : $t('未连接') }}
      </span>
    </button>
  </nav>
</template>

<style scoped>
.rail {
  position: relative;
  z-index: 12;
  flex: 0 0 52px;
  width: 52px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 6px;
  border-radius: 18px;
  background: var(--panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-soft);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.35);
  backdrop-filter: blur(var(--glass-blur)) saturate(1.35);
  animation: rail-in 0.55s cubic-bezier(0.22, 0.68, 0.24, 1) both;
}

.rail::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.16),
    transparent 28%,
    transparent 76%,
    rgba(255, 255, 255, 0.05)
  );
  pointer-events: none;
}

html[data-theme='dark'] .rail::after {
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.045),
    transparent 32%,
    transparent 78%,
    rgba(255, 255, 255, 0.02)
  );
}

.rail > * {
  position: relative;
  z-index: 1;
}

.rail-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  width: 100%;
}

.bottom {
  gap: 5px;
}

.rail-spacer {
  flex: 1;
  min-height: 8px;
}

.rail-divider {
  width: 24px;
  height: 1px;
  margin: 1px 0 4px;
  background: var(--border-subtle);
}

.rail-btn {
  position: relative;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  flex: none;
  border: 1px solid transparent;
  border-radius: 11px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition:
    color 0.18s ease,
    background 0.18s ease,
    border-color 0.18s ease,
    transform 0.18s ease,
    box-shadow 0.22s ease;
}

.rail-btn:hover:not(:disabled) {
  color: var(--text);
  background: var(--hover);
  transform: translateY(-1px);
}

.rail-btn:active:not(:disabled) {
  transform: translateY(0) scale(0.94);
}

.rail-btn.active {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--accent-border);
  box-shadow: 0 8px 20px -12px rgba(var(--accent-rgb), 0.7);
}

.rail-btn.active::before {
  content: '';
  position: absolute;
  left: -7px;
  top: 50%;
  width: 3px;
  height: 18px;
  margin-top: -9px;
  border-radius: 3px;
  background: linear-gradient(180deg, var(--accent-hover), var(--accent));
  box-shadow: 0 0 9px rgba(var(--accent-rgb), 0.75);
  animation: rail-marker 0.24s ease both;
}

.rail-btn:disabled {
  opacity: 0.32;
  cursor: default;
}

.rail-btn svg {
  width: 18px;
  height: 18px;
  transition: transform 0.18s ease;
}

.rail-btn:hover:not(:disabled) svg {
  transform: scale(1.06);
}

.rail-btn.active svg {
  filter: drop-shadow(0 0 6px rgba(var(--accent-rgb), 0.42));
}

.rail-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--accent);
  color: #fff;
  font-family: var(--mono);
  font-size: 8.5px;
  font-weight: 700;
  line-height: 14px;
  text-align: center;
  box-shadow: 0 0 0 2px var(--panel), 0 2px 6px rgba(0, 0, 0, 0.2);
}

.rail-badge.danger {
  background: var(--danger);
}

.rail-tip {
  position: absolute;
  left: calc(100% + 12px);
  top: 50%;
  z-index: 80;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-strong);
  box-shadow: var(--shadow-soft);
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
  color: var(--text-soft);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translate(-4px, -50%);
  transition:
    opacity 0.16s ease,
    transform 0.18s ease,
    visibility 0.16s;
}

.rail-tip kbd {
  padding: 1px 4px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--surface-soft);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 9px;
}

.rail-btn:hover .rail-tip,
.rail-btn:focus-visible .rail-tip,
.rail-status:hover .rail-tip {
  opacity: 1;
  visibility: visible;
  transform: translate(0, -50%);
}

.rail-status {
  position: relative;
  width: 38px;
  height: 27px;
  display: grid;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  cursor: pointer;
  transition: background 0.18s ease, border-color 0.18s ease;
}

.rail-status:hover {
  background: var(--hover);
  border-color: var(--border-subtle);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
  box-shadow: 0 0 0 3px var(--surface-soft);
  transition: background 0.25s ease, box-shadow 0.25s ease;
}

.status-dot.on {
  background: var(--conn-color, var(--ok));
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--conn-color, var(--ok)) 16%, transparent),
    0 0 10px color-mix(in srgb, var(--conn-color, var(--ok)) 55%, transparent);
  animation: conn-breathe 3.2s ease-in-out infinite;
}

@keyframes rail-in {
  from {
    opacity: 0;
    transform: translateX(-10px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateX(0) scale(1);
  }
}

@keyframes rail-marker {
  from {
    height: 4px;
    margin-top: -2px;
    opacity: 0;
  }
  to {
    height: 18px;
    margin-top: -9px;
    opacity: 1;
  }
}

@keyframes conn-breathe {
  0%,
  100% {
    box-shadow:
      0 0 0 3px color-mix(in srgb, var(--conn-color, var(--ok)) 14%, transparent),
      0 0 8px color-mix(in srgb, var(--conn-color, var(--ok)) 45%, transparent);
  }
  50% {
    box-shadow:
      0 0 0 4px color-mix(in srgb, var(--conn-color, var(--ok)) 7%, transparent),
      0 0 14px color-mix(in srgb, var(--conn-color, var(--ok)) 70%, transparent);
  }
}

@media (max-width: 900px) {
  .rail {
    flex-basis: 48px;
    width: 48px;
    padding-left: 4px;
    padding-right: 4px;
  }

  .rail-btn {
    width: 36px;
    height: 36px;
  }
}

@media (max-height: 620px) {
  .rail {
    gap: 3px;
    padding-top: 6px;
    padding-bottom: 6px;
  }

  .rail-group {
    gap: 2px;
  }

  .rail-btn {
    width: 34px;
    height: 34px;
  }

  .rail-tip {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rail,
  .rail-btn.active::before,
  .status-dot.on {
    animation: none !important;
  }
}
</style>
