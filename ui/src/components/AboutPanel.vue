<script setup lang="ts">
// 关于面板：客户端版本 / 作者 / 仓库 / 许可 / QSDB 简介。
//
// 版本来自 Tauri 配置（appInfo）；这里**不展示**任何连接名、服务端地址或
// 凭据。外链走 tauri-plugin-opener（默认权限只允许 http/https/mailto/tel）。
import { openUrl } from '@tauri-apps/plugin-opener'
import { NButton, NDrawer, NDrawerContent, useMessage } from 'naive-ui'
import { computed, watch } from 'vue'
import brandMark from '../assets/qsdb-mark.png'
import { appInfo, loadAppInfo } from '../stores/appInfo'
import { uiState } from '../stores/ui'
import { copyText } from '../utils/clipboard'

import { t, tt } from '../i18n'

const message = useMessage()

const show = computed({
  get: () => uiState.aboutOpen,
  set: (v: boolean) => {
    uiState.aboutOpen = v
  },
})

const REPO_URL = 'https://github.com/qinwenhui/qsdb-studio'
const KERNEL_URL = 'https://github.com/qinwenhui/qsdb'
const AUTHOR_URL = 'https://github.com/qinwenhui'
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`
const EMAIL = '1510365643@qq.com'

const links = [
  {
    label: 'GitHub 仓库',
    value: 'qinwenhui/qsdb-studio',
    url: REPO_URL,
    icon: 'repo',
  },
  {
    label: '问题与建议',
    value: 'GitHub Issues',
    url: `${REPO_URL}/issues`,
    icon: 'issues',
  },
  {
    label: '许可证',
    value: 'PolyForm Noncommercial 1.0.0',
    url: LICENSE_URL,
    icon: 'license',
  },
  {
    label: '商业授权',
    value: EMAIL,
    url: `mailto:${EMAIL}?subject=QSDB%20Studio%20commercial%20license`,
    icon: 'mail',
  },
  {
    label: 'QSDB 数据库',
    value: 'qinwenhui/qsdb',
    url: KERNEL_URL,
    icon: 'db',
  },
]

const platform = computed(() => {
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS'
  if (/Linux/i.test(ua)) return 'Linux'
  return 'WebView'
})

const versionText = computed(() => appInfo.version || '—')
const tauriText = computed(() => appInfo.tauriVersion || '—')

const versionBlock = computed(() =>
  [
    `QSDB Studio ${appInfo.version || 'unknown'}`,
    `Tauri ${appInfo.tauriVersion || 'unknown'}`,
    `Platform ${platform.value}`,
    `User-Agent ${navigator.userAgent}`,
  ].join('\n'),
)

watch(
  () => uiState.aboutOpen,
  (open) => {
    if (open) void loadAppInfo()
  },
)

async function open(url: string) {
  try {
    await openUrl(url)
  } catch (e) {
    message.error(tt`无法打开外部链接：${e instanceof Error ? e.message : String(e)}`)
  }
}

async function copyVersion() {
  if (await copyText(versionBlock.value)) {
    message.success(t('版本信息已复制（可直接粘贴到 issue）'))
  } else {
    message.error(t('复制失败：剪贴板不可用'))
  }
}
</script>

<template>
  <NDrawer v-model:show="show" :width="540" placement="right">
    <NDrawerContent :title="$t('关于 QSDB Studio')" closable>
      <div class="body">
        <div class="hero">
          <img class="mark" :src="brandMark" alt="QSDB Studio" width="64" height="64" />
          <div class="hero-text">
            <div class="name">QSDB Studio</div>
            <div class="tagline">{{ $t("QSDB 原生桌面工作台") }}</div>
            <div class="version-line">
              <span class="chip mono">v{{ versionText }}</span>
              <span class="chip mono">Tauri {{ tauriText }}</span>
              <span class="chip">{{ platform }}</span>
            </div>
          </div>
        </div>

        <div class="intro">
          <p>
            <b>QSDB</b> {{ $t("是面向大规模分析负载的高性能列式分析数据库：Arrow 原生执行、\n            Parquet 存储，元数据与数据同住，分区以 generation 管理并原子替换。\n            以向量化执行、分区裁剪和行组统计支撑高吞吐分析，无需外部元数据服务或协调器。") }}
          </p>
          <p>
            <b>QSDB Studio</b> {{ $t("是它的官方桌面客户端：连接与查询、分区与表大小、\n            流式结果、提交事件流、会话与运行查询、库级授权、COPY/CSV 以及原始\n            segment 文件管理，都在同一个窗口里。") }}
          </p>
        </div>

        <div class="meta-grid">
          <div class="meta">
            <span class="k">{{ $t("作者") }}</span>
            <button type="button" class="v link" @click="open(AUTHOR_URL)">qinwh</button>
          </div>
          <div class="meta">
            <span class="k">{{ $t("客户端版本") }}</span>
            <span class="v mono">{{ versionText }}</span>
          </div>
          <div class="meta">
            <span class="k">Tauri</span>
            <span class="v mono">{{ tauriText }}</span>
          </div>
          <div class="meta">
            <span class="k">{{ $t("运行平台") }}</span>
            <span class="v">{{ platform }}</span>
          </div>
        </div>

        <div class="links">
          <button
            v-for="l in links"
            :key="l.url"
            type="button"
            class="link-row"
            :title="l.url"
            @click="open(l.url)"
          >
            <span class="link-icon" :class="l.icon" aria-hidden="true">
              <svg v-if="l.icon === 'repo'" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.17c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.71.08-.7.08-.7 1.16.09 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.3-5.27-1.29-5.27-5.73 0-1.26.45-2.3 1.2-3.1-.12-.3-.52-1.48.11-3.08 0 0 .97-.31 3.18 1.19a11 11 0 0 1 5.8 0c2.2-1.5 3.17-1.19 3.17-1.19.63 1.6.23 2.79.12 3.08.74.8 1.19 1.84 1.19 3.1 0 4.45-2.7 5.42-5.28 5.71.41.36.78 1.07.78 2.16v3.2c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
              </svg>
              <svg v-else-if="l.icon === 'issues'" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7" />
                <path d="M12 7.2v5.4M12 16.4h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              </svg>
              <svg v-else-if="l.icon === 'license'" viewBox="0 0 24 24" fill="none">
                <path d="M5 3.5h10.5l3.5 3.5v13.5H5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
                <path d="M8 11h8M8 14.5h8M8 18h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              </svg>
              <svg v-else-if="l.icon === 'mail'" viewBox="0 0 24 24" fill="none">
                <rect x="3.4" y="5.5" width="17.2" height="13" rx="2" stroke="currentColor" stroke-width="1.6" />
                <path d="m4.3 7 7.7 6 7.7-6" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none">
                <ellipse cx="12" cy="5.6" rx="7.6" ry="2.9" stroke="currentColor" stroke-width="1.5" />
                <path d="M4.4 5.6v6.2c0 1.6 3.4 2.9 7.6 2.9s7.6-1.3 7.6-2.9V5.6" stroke="currentColor" stroke-width="1.5" />
                <path d="M4.4 11.8V18c0 1.6 3.4 2.9 7.6 2.9s7.6-1.3 7.6-2.9v-6.2" stroke="currentColor" stroke-width="1.5" />
              </svg>
            </span>
            <span class="link-main">
              <span class="link-label">{{ $t(l.label) }}</span>
              <span class="link-value mono">{{ l.value }}</span>
            </span>
            <span class="link-arrow" aria-hidden="true">↗</span>
          </button>
        </div>

        <div class="license-note">
          <b>{{ $t("Source-available，非 OSI 开源许可。") }}</b>
          {{ $t("Studio 采用 PolyForm Noncommercial 1.0.0：个人学习、研究、教育与非营利\n          使用无需付费；任何商业用途需取得单独授权。QSDB 数据库内核按其仓库中的\n          独立许可证发布。") }}
        </div>

        <div class="actions">
          <NButton size="small" secondary :loading="appInfo.loading" @click="copyVersion">
            {{ $t("复制版本信息") }}
          </NButton>
          <NButton size="small" secondary @click="open(REPO_URL)">{{ $t("打开 GitHub") }}</NButton>
        </div>

        <div class="foot">
          <span>© 2026 qinwh · QSDB Studio</span>
          <span class="mono">Built with Rust · Tauri 2 · Vue 3</span>
        </div>
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

.hero {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background:
    radial-gradient(ellipse 80% 120% at 0% 0%, var(--accent-soft), transparent 60%),
    var(--surface-soft);
}

.mark {
  width: 64px;
  height: 64px;
  flex: none;
  border-radius: 16px;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.18),
    0 10px 28px -12px rgba(var(--accent-rgb), 0.8);
}

.hero-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.name {
  font-size: 20px;
  font-weight: 760;
  letter-spacing: -0.02em;
  color: var(--text);
}

.tagline {
  font-size: 11.5px;
  color: var(--muted);
}

.version-line {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 3px;
}

.intro {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-soft);
}

.intro p {
  margin: 0;
}

.intro b {
  color: var(--text);
}

.meta-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
  min-width: 0;
}

.meta .k {
  font-size: 9.5px;
  letter-spacing: 0.04em;
  color: var(--muted);
  text-transform: uppercase;
}

.meta .v {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--accent);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.link:hover {
  text-decoration: underline;
}

.links {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface-soft);
}

.link-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: none;
  border-bottom: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-soft);
  text-align: left;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
}

.link-row:last-child {
  border-bottom: none;
}

.link-row:hover {
  background: var(--hover);
  color: var(--text);
}

.link-icon {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  flex: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-raised);
  color: var(--muted);
}

.link-icon svg {
  width: 14px;
  height: 14px;
}

.link-row:hover .link-icon {
  color: var(--accent);
  border-color: var(--accent-border);
}

.link-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.link-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.link-value {
  font-size: 10px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link-arrow {
  flex: none;
  color: var(--muted);
  font-size: 12px;
}

.license-note {
  padding: 10px 11px;
  border: 1px solid var(--warn-border);
  border-radius: 9px;
  background: var(--warn-soft);
  color: var(--text-soft);
  font-size: 10.5px;
  line-height: 1.65;
}

.license-note b {
  color: var(--warn);
}

.actions {
  display: flex;
  gap: 7px;
}

.foot {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 10px;
}
</style>
