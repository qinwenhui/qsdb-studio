<script setup lang="ts">
import { NButton, NDrawer, NDrawerContent, NSlider, useMessage } from 'naive-ui'
import { computed } from 'vue'
import { language, setLanguage } from '../i18n'
import {
  ACCENTS,
  accentInfo,
  appearance,
  chooseImage,
  clearImage,
  resetAppearance,
  retryImage,
  setAccent,
  setBlur,
  setOpacity,
  setTheme,
  setWallpaper,
  wallpaperClass,
  wallpaperStyle,
  type ThemeMode,
  type WallpaperPreset,
} from '../stores/appearance'
import { resetLayout } from '../stores/layout'
import { uiState } from '../stores/ui'
import {
  resetUiPrefs,
  setEditorFontSize,
  setEditorLineHeight,
  setGridFontSize,
  setGridRowHeight,
  uiPrefs,
} from '../stores/uiPrefs'
import { UI_PREF_LIMITS, editorLineMin, gridRowMin } from '../utils/uiPrefs'

import { t, tt } from '../i18n'

const message = useMessage()

const show = computed({
  get: () => uiState.appearanceOpen,
  set: (v: boolean) => {
    uiState.appearanceOpen = v
  },
})

const WALLPAPERS: { id: WallpaperPreset; label: string; cls: string }[] = [
  { id: 'auto', label: '随主题', cls: 'wp-auto' },
  { id: 'dawn', label: '晨雾', cls: 'wp-dawn' },
  { id: 'dusk', label: '暮色', cls: 'wp-dusk' },
  { id: 'paper', label: '纸感', cls: 'wp-paper' },
  { id: 'aurora', label: '极光', cls: 'wp-aurora' },
  { id: 'image', label: '自定义', cls: 'wp-image' },
]

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'system', label: '跟随系统' },
]

const opacityPercent = computed(() => Math.round(appearance.opacity * 100))

function onOpacity(v: number) {
  setOpacity(v / 100)
}

const accentName = computed(() => accentInfo.value.name)

async function onWallpaper(w: { id: WallpaperPreset }) {
  if (w.id === 'image' && !appearance.imageDataUrl) {
    await onPickImage()
    return
  }
  setWallpaper(w.id)
}

async function onPickImage() {
  await chooseImage()
  if (appearance.imageError) {
    message.error(appearance.imageError, { duration: 7000 })
  } else if (appearance.imageDataUrl) {
    message.success(tt`已应用背景图：${appearance.imageName ?? ''}`)
  }
}

function onClearImage() {
  clearImage()
  message.info(t('已移除自定义背景图'))
}

function onResetLayout() {
  resetLayout()
  message.success(t('布局已恢复默认（侧栏宽度 / 编辑-结果分割）'))
}

function onReset() {
  resetAppearance()
  message.success(t('外观已恢复默认'))
}

function onResetPrefs() {
  resetUiPrefs()
  message.success(t('字体与密度已恢复默认'))
}
</script>

<template>
  <NDrawer v-model:show="show" :width="500" placement="right">
    <NDrawerContent :title="$t('外观')" closable>
      <div class="body">
        <!-- 预览：迷你窗口浮在壁纸上（装饰用，不承担交互） -->
        <div class="preview">
          <div class="preview-bg" :class="wallpaperClass" :style="wallpaperStyle" />
          <div class="preview-veil" />
          <div class="mini-window">
            <div class="mini-top">
              <i class="tl red" />
              <i class="tl yellow" />
              <i class="tl green" />
              <span class="mini-title">QSDB Studio</span>
              <span class="mini-accent" />
            </div>
            <div class="mini-body">
              <div class="mini-side">
                <span class="ms-line w70" />
                <span class="ms-line w50" />
                <span class="ms-line w60" />
              </div>
              <div class="mini-main">
                <div class="mini-toolbar">
                  <span class="mb-pill" />
                  <span class="mb-pill" />
                  <span class="mb-grow" />
                  <span class="mb-dot" />
                </div>
                <div class="mini-line w80" />
                <div class="mini-line w55" />
                <div class="mini-grid">
                  <i /><i /><i /><i /><i /><i /><i /><i />
                </div>
              </div>
            </div>
          </div>
          <div class="preview-caption">{{ $t("玻璃面板 · 壁纸 ·") }} {{ $t(accentName) }}</div>
        </div>

        <section>
          <div class="section-title">{{ $t('语言 / Language') }}</div>
          <div class="segmented">
            <button
              class="seg-btn"
              :class="{ active: language.pref === 'system' }"
              @click="setLanguage('system')"
            >
              {{ $t('跟随系统') }}
            </button>
            <button
              class="seg-btn"
              :class="{ active: language.pref === 'zh' }"
              @click="setLanguage('zh')"
            >
              {{ $t("中文") }}
            </button>
            <button
              class="seg-btn"
              :class="{ active: language.pref === 'en' }"
              @click="setLanguage('en')"
            >
              English
            </button>
          </div>
          <div class="hint">
            {{ $t('即时切换界面语言；选择会保存在本机。') }}
            <template v-if="language.pref === 'system'">
              {{ $t('当前系统语言解析为：{lang}', { lang: language.locale === 'zh' ? '中文' : 'English' }) }}
            </template>
          </div>
        </section>

        <section>
          <div class="section-title">{{ $t('主题') }}</div>
          <div class="segmented">
            <button
              v-for="themeOpt in THEMES"
              :key="themeOpt.id"
              class="seg-btn"
              :class="{ active: appearance.theme === themeOpt.id }"
              @click="setTheme(themeOpt.id)"
            >
              {{ $t(themeOpt.label) }}
            </button>
          </div>
        </section>

        <section>
          <div class="section-title">{{ $t("强调色") }}</div>
          <div class="accent-row">
            <button
              v-for="a in ACCENTS"
              :key="a.id"
              class="swatch"
              :class="{ active: appearance.accent === a.id }"
              :style="{ background: a.swatch }"
              :title="$t(a.name)"
              @click="setAccent(a.id)"
            >
              <svg v-if="appearance.accent === a.id" viewBox="0 0 16 16" class="check">
                <path
                  d="M3.5 8.5 6.5 11.5 12.5 5"
                  fill="none"
                  stroke="#fff"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <span class="accent-name">{{ $t(accentName) }}</span>
          </div>
        </section>

        <section>
          <div class="section-title">{{ $t("壁纸") }}</div>
          <div class="wp-grid">
            <button
              v-for="w in WALLPAPERS"
              :key="w.id"
              class="wp-tile"
              :class="{ active: appearance.wallpaper === w.id }"
              @click="onWallpaper(w)"
            >
              <div
                class="tile-bg"
                :class="w.cls"
                :style="
                  w.id === 'image' && appearance.imageDataUrl
                    ? { backgroundImage: `url('${appearance.imageDataUrl}')` }
                    : undefined
                "
              >
                <span v-if="w.id === 'image' && !appearance.imageDataUrl" class="tile-plus">＋</span>
              </div>
              <span class="tile-label">{{ $t(w.label) }}</span>
              <span v-if="appearance.wallpaper === w.id" class="tile-check">✓</span>
            </button>
          </div>

          <div class="image-row">
            <NButton size="small" @click="onPickImage">{{ $t("选择本地图片…") }}</NButton>
            <NButton v-if="appearance.imagePath" size="small" quaternary @click="onClearImage">
              {{ $t("移除") }}
            </NButton>
            <span v-if="appearance.imageName" class="image-name" :title="appearance.imagePath ?? ''">
              {{ appearance.imageName }}
            </span>
            <span v-else class="image-name muted">{{ $t("png / jpg / webp / gif / bmp，≤16 MiB") }}</span>
          </div>

          <div v-if="appearance.imageError" class="error-box">
            <div class="err-msg">{{ appearance.imageError }}</div>
            <div class="err-actions">
              <NButton size="tiny" secondary @click="retryImage">{{ $t("重试") }}</NButton>
              <NButton size="tiny" secondary @click="onPickImage">{{ $t("重新选择") }}</NButton>
            </div>
          </div>
        </section>

        <section>
          <div class="section-title">
            {{ $t("毛玻璃") }}
            <span class="value">{{ appearance.blur }}px</span>
          </div>
          <NSlider
            :value="appearance.blur"
            :min="0"
            :max="32"
            :step="1"
            :tooltip="false"
            @update:value="setBlur"
          />
          <div class="hint">{{ $t("面板与抽屉的 backdrop blur；0 = 纯色玻璃。") }}</div>
        </section>

        <section>
          <div class="section-title">
            {{ $t("面板透明度") }}
            <span class="value">{{ opacityPercent }}%</span>
          </div>
          <NSlider
            :value="opacityPercent"
            :min="35"
            :max="98"
            :step="1"
            :tooltip="false"
            @update:value="onOpacity"
          />
          <div class="hint">{{ $t("越低越透（壁纸更明显）；文字对比度不足时调高。") }}</div>
        </section>

        <section>
          <div class="section-title">
            {{ $t("字体与密度") }}
            <span class="value">
              {{ $t("编辑器") }} {{ uiPrefs.editorFontSize }}{{ $t("px · 结果") }} {{ uiPrefs.gridFontSize }}px
            </span>
          </div>
          <div class="pref-grid">
            <span class="pref-label">{{ $t("编辑器字号") }}</span>
            <NSlider
              :value="uiPrefs.editorFontSize"
              :min="UI_PREF_LIMITS.editorFontSize.min"
              :max="UI_PREF_LIMITS.editorFontSize.max"
              :step="0.5"
              :tooltip="false"
              @update:value="setEditorFontSize"
            />
            <span class="pref-value">{{ uiPrefs.editorFontSize }}px</span>

            <span class="pref-label">{{ $t("编辑器行高") }}</span>
            <NSlider
              :value="uiPrefs.editorLineHeight"
              :min="editorLineMin(uiPrefs.editorFontSize)"
              :max="UI_PREF_LIMITS.editorLineHeight.max"
              :step="1"
              :tooltip="false"
              @update:value="setEditorLineHeight"
            />
            <span class="pref-value">{{ uiPrefs.editorLineHeight }}px</span>

            <span class="pref-label">{{ $t("结果字号") }}</span>
            <NSlider
              :value="uiPrefs.gridFontSize"
              :min="UI_PREF_LIMITS.gridFontSize.min"
              :max="UI_PREF_LIMITS.gridFontSize.max"
              :step="0.5"
              :tooltip="false"
              @update:value="setGridFontSize"
            />
            <span class="pref-value">{{ uiPrefs.gridFontSize }}px</span>

            <span class="pref-label">{{ $t("结果行高") }}</span>
            <NSlider
              :value="uiPrefs.gridRowHeight"
              :min="gridRowMin(uiPrefs.gridFontSize)"
              :max="UI_PREF_LIMITS.gridRowHeight.max"
              :step="1"
              :tooltip="false"
              @update:value="setGridRowHeight"
            />
            <span class="pref-value">{{ uiPrefs.gridRowHeight }}px</span>
          </div>
          <div class="hint">
            {{ $t("行高低于字号可读下限时会自动抬高；虚拟滚动按新行高立即重排。\n            这些偏好只影响渲染，不改变结果数据。") }}
          </div>
          <NButton size="small" quaternary @click="onResetPrefs">
            {{ $t("恢复默认字体与密度") }}
          </NButton>
        </section>

        <section>
          <div class="section-title">
            {{ $t("布局") }}
            <span class="value">{{ $t("侧栏 / 编辑-结果分割") }}</span>
          </div>
          <div class="hint">
            {{ $t("侧栏宽度、折叠状态、分割比例与窗口位置尺寸会自动保存；\n            这里只恢复侧栏与分割比例，窗口位置仍由系统管理。") }}
          </div>
          <NButton size="small" quaternary @click="onResetLayout">{{ $t("恢复默认布局") }}</NButton>
        </section>

        <div class="actions">
          <NButton size="small" quaternary @click="onReset">{{ $t("恢复默认外观") }}</NButton>
          <span class="spacer" />
          <span class="foot-hint">{{ $t("设置保存在本机；自定义图片只存路径") }}</span>
        </div>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  height: 100%;
  min-height: 0;
  overflow: auto;
  /* 强调色圆点选中时外圈 box-shadow 会溢出 4px；滚动容器在 padding
     边缘裁剪，必须留出横向内边距，否则第一个圆的外圈会被左侧白边切掉。 */
  padding: 4px 10px 4px 8px;
}

.preview {
  position: relative;
  height: 190px;
  border-radius: 16px;
  overflow: hidden;
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
  flex: 0 0 auto;
}

.preview-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
}

.preview-veil {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(10, 14, 22, 0.14));
}

.mini-window {
  position: absolute;
  left: 26px;
  right: 26px;
  top: 28px;
  bottom: 28px;
  border-radius: 12px;
  background: var(--panel-strong);
  border: 1px solid var(--border);
  box-shadow: 0 18px 40px rgba(8, 12, 20, 0.28);
  -webkit-backdrop-filter: blur(14px) saturate(1.35);
  backdrop-filter: blur(14px) saturate(1.35);
  overflow: hidden;
}

.mini-top {
  height: 26px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 9px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-soft);
}

.tl {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
}

.tl.red {
  background: #ff5f57;
}

.tl.yellow {
  background: #febc2e;
}

.tl.green {
  background: #28c840;
}

.mini-title {
  margin-left: 6px;
  font-size: 8.5px;
  font-weight: 700;
  color: var(--text-soft);
  letter-spacing: 0.02em;
}

.mini-accent {
  margin-left: auto;
  width: 26px;
  height: 5px;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--accent), var(--accent-hover));
}

.mini-body {
  display: flex;
  height: calc(100% - 26px);
}

.mini-side {
  width: 64px;
  border-right: 1px solid var(--border-subtle);
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  background: var(--surface-stripe);
}

.ms-line {
  height: 4px;
  border-radius: 2px;
  background: var(--border-strong);
  opacity: 0.55;
}

.ms-line.w70 {
  width: 70%;
}

.ms-line.w50 {
  width: 50%;
}

.ms-line.w60 {
  width: 60%;
}

.mini-main {
  flex: 1;
  padding: 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.mini-toolbar {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 2px;
}

.mb-pill {
  width: 28px;
  height: 7px;
  border-radius: 4px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-border);
}

.mb-grow {
  flex: 1;
}

.mb-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
}

.mini-line {
  height: 5px;
  border-radius: 3px;
  background: var(--border-strong);
  opacity: 0.4;
}

.mini-line.w80 {
  width: 80%;
}

.mini-line.w55 {
  width: 55%;
}

.mini-grid {
  margin-top: 2px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 3px;
  flex: 1;
}

.mini-grid i {
  border-radius: 3px;
  background: var(--surface-soft);
  border: 1px solid var(--border-subtle);
}

.preview-caption {
  position: absolute;
  left: 14px;
  bottom: 10px;
  font-size: 10px;
  letter-spacing: 0.08em;
  color: rgba(255, 255, 255, 0.86);
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  text-transform: uppercase;
}

section {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}

.section-title .value {
  font-family: var(--mono);
  letter-spacing: 0;
  text-transform: none;
  color: var(--text-soft);
}

.segmented {
  display: flex;
  padding: 3px;
  border-radius: 12px;
  background: var(--surface-soft);
  border: 1px solid var(--border-subtle);
  gap: 2px;
}

.seg-btn {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text-soft);
  font-size: 12px;
  padding: 7px 8px;
  border-radius: 9px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
}

.seg-btn:hover {
  color: var(--text);
}

.seg-btn.active {
  background: var(--panel-strong);
  color: var(--text);
  font-weight: 650;
  box-shadow: 0 2px 10px rgba(10, 16, 28, 0.12);
}

.accent-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.swatch {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(10, 16, 28, 0.16);
  transition: transform 0.15s, box-shadow 0.15s;
}

.swatch:hover {
  transform: translateY(-1px) scale(1.04);
}

.swatch.active {
  box-shadow:
    0 0 0 2px var(--panel-strong),
    0 0 0 4px var(--accent),
    0 6px 16px rgba(10, 16, 28, 0.2);
}

.check {
  width: 14px;
  height: 14px;
}

.accent-name {
  margin-left: 2px;
  font-size: 11.5px;
  color: var(--muted);
}

.wp-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.wp-tile {
  position: relative;
  border: 1px solid var(--border);
  background: var(--surface-soft);
  border-radius: 12px;
  padding: 4px;
  cursor: pointer;
  text-align: left;
  transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s;
}

.wp-tile:hover {
  transform: translateY(-1px);
  border-color: var(--border-strong);
}

.wp-tile.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.tile-bg {
  height: 58px;
  border-radius: 9px;
  background-size: cover;
  background-position: center;
  border: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
}

.tile-plus {
  font-size: 20px;
  color: var(--text-soft);
  opacity: 0.8;
}

.tile-label {
  display: block;
  padding: 5px 4px 2px;
  font-size: 11px;
  color: var(--text-soft);
  font-weight: 600;
}

.tile-check {
  position: absolute;
  right: 8px;
  top: 8px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(10, 16, 28, 0.3);
}

.image-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.image-name {
  font-size: 11px;
  color: var(--text-soft);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint {
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--muted);
}

.pref-grid {
  display: grid;
  grid-template-columns: 74px 1fr 52px;
  align-items: center;
  gap: 7px 10px;
}

.pref-label {
  font-size: 11.5px;
  color: var(--text-soft);
}

.pref-value {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--muted);
  text-align: right;
}

.error-box {
  border: 1px solid var(--danger-border);
  background: var(--danger-soft);
  border-radius: 9px;
  padding: 9px 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.err-msg {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--danger);
  white-space: pre-wrap;
  word-break: break-word;
}

.err-actions {
  display: flex;
  gap: 6px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.spacer {
  flex: 1;
}

.foot-hint {
  font-size: 10.5px;
  color: var(--muted);
}
</style>
