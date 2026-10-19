// 外观：主题 / 强调色 / 壁纸 / 毛玻璃强度 / 自定义背景图。
//
// 设置存 localStorage；自定义图片只存**路径**，启动时经 Rust 命令重新读成
// data URL（避免把几 MB 图片塞进 localStorage）。图片读取失败会显式报错，
// 面板里可重选，不静默假装换了壁纸。

import { open } from '@tauri-apps/plugin-dialog'
import { computed, reactive } from 'vue'
import { t } from '../i18n'
import * as ipc from '../ipc'

export type ThemeMode = 'light' | 'dark' | 'system'
export type WallpaperPreset = 'auto' | 'dawn' | 'dusk' | 'paper' | 'aurora' | 'image'

interface AccentTones {
  primary: string
  hover: string
  pressed: string
  strong: string
  soft: string
  rgb: string
  border: string
}

export interface AccentPreset {
  id: string
  name: string
  swatch: string
  light: AccentTones
  dark: AccentTones
}

export const ACCENTS: AccentPreset[] = [
  {
    id: 'blue',
    name: '海湾蓝',
    swatch: '#3b6ef5',
    light: {
      primary: '#3b6ef5',
      hover: '#5b86ff',
      pressed: '#2f5bd6',
      strong: '#2a56cc',
      soft: 'rgba(59,110,245,.12)',
      rgb: '59,110,245',
      border: 'rgba(59,110,245,.30)',
    },
    dark: {
      primary: '#7ea2ff',
      hover: '#9bb7ff',
      pressed: '#5b86ff',
      strong: '#a9c0ff',
      soft: 'rgba(126,162,255,.16)',
      rgb: '126,162,255',
      border: 'rgba(126,162,255,.38)',
    },
  },
  {
    id: 'violet',
    name: '暮紫',
    swatch: '#8b5cf6',
    light: {
      primary: '#8b5cf6',
      hover: '#a78bfa',
      pressed: '#7345e0',
      strong: '#6d3fe0',
      soft: 'rgba(139,92,246,.13)',
      rgb: '139,92,246',
      border: 'rgba(139,92,246,.30)',
    },
    dark: {
      primary: '#b69dff',
      hover: '#c9b8ff',
      pressed: '#9f86f5',
      strong: '#d2c4ff',
      soft: 'rgba(182,157,255,.16)',
      rgb: '182,157,255',
      border: 'rgba(182,157,255,.38)',
    },
  },
  {
    id: 'teal',
    name: '青屿',
    swatch: '#14b8a6',
    light: {
      primary: '#0ea5a0',
      hover: '#2dd4bf',
      pressed: '#0b8a86',
      strong: '#0b7f7b',
      soft: 'rgba(20,184,166,.13)',
      rgb: '20,184,166',
      border: 'rgba(20,184,166,.30)',
    },
    dark: {
      primary: '#5eead4',
      hover: '#8af3e3',
      pressed: '#2dd4bf',
      strong: '#b6f7ec',
      soft: 'rgba(94,234,212,.14)',
      rgb: '94,234,212',
      border: 'rgba(94,234,212,.34)',
    },
  },
  {
    id: 'amber',
    name: '琥珀',
    swatch: '#f59e0b',
    light: {
      primary: '#d97706',
      hover: '#f59e0b',
      pressed: '#b45309',
      strong: '#9a5b00',
      soft: 'rgba(245,158,11,.15)',
      rgb: '217,119,6',
      border: 'rgba(217,119,6,.30)',
    },
    dark: {
      primary: '#fbbf24',
      hover: '#fcd34d',
      pressed: '#f59e0b',
      strong: '#ffe7a8',
      soft: 'rgba(251,191,36,.14)',
      rgb: '251,191,36',
      border: 'rgba(251,191,36,.34)',
    },
  },
  {
    id: 'rose',
    name: '玫瑰',
    swatch: '#f43f5e',
    light: {
      primary: '#e11d48',
      hover: '#fb7185',
      pressed: '#be123c',
      strong: '#a9143a',
      soft: 'rgba(225,29,72,.12)',
      rgb: '225,29,72',
      border: 'rgba(225,29,72,.28)',
    },
    dark: {
      primary: '#fb7185',
      hover: '#fda4af',
      pressed: '#f43f5e',
      strong: '#fecdd3',
      soft: 'rgba(251,113,133,.14)',
      rgb: '251,113,133',
      border: 'rgba(251,113,133,.34)',
    },
  },
]

export function accentPreset(id: string): AccentPreset {
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0]
}

export function accentTones(id: string, dark: boolean): AccentTones {
  const p = accentPreset(id)
  return dark ? p.dark : p.light
}

interface Persisted {
  theme: ThemeMode
  accent: string
  wallpaper: WallpaperPreset
  blur: number
  opacity: number
  imagePath: string | null
}

const STORAGE_KEY = 'qsdb-studio.appearance.v1'
const DEFAULTS: Persisted = {
  theme: 'system',
  accent: 'blue',
  wallpaper: 'auto',
  blur: 18,
  opacity: 0.72,
  imagePath: null,
}

const THEMES: ThemeMode[] = ['light', 'dark', 'system']
const WALLPAPERS: WallpaperPreset[] = ['auto', 'dawn', 'dusk', 'paper', 'aurora', 'image']

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export const appearance = reactive({
  theme: DEFAULTS.theme as ThemeMode,
  accent: DEFAULTS.accent,
  wallpaper: DEFAULTS.wallpaper as WallpaperPreset,
  blur: DEFAULTS.blur,
  opacity: DEFAULTS.opacity,
  imagePath: null as string | null,
  imageName: null as string | null,
  imageDataUrl: null as string | null,
  imageError: null as string | null,
  isDark: false,
  ready: false,
})

const media =
  typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

export const currentAccent = computed(() =>
  accentTones(appearance.accent, appearance.isDark),
)

export const accentInfo = computed(() => accentPreset(appearance.accent))

export const wallpaperClass = computed(() => `wp-${appearance.wallpaper}`)

export const wallpaperStyle = computed<Record<string, string>>(() => {
  const style: Record<string, string> = {}
  if (appearance.wallpaper === 'image' && appearance.imageDataUrl) {
    style.backgroundImage = `url("${appearance.imageDataUrl}")`
  }
  return style
})

function apply() {
  const dark =
    appearance.theme === 'dark' || (appearance.theme === 'system' && Boolean(media?.matches))
  appearance.isDark = dark
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  const a = accentTones(appearance.accent, dark)
  root.style.setProperty('--accent', a.primary)
  root.style.setProperty('--accent-hover', a.hover)
  root.style.setProperty('--accent-pressed', a.pressed)
  root.style.setProperty('--accent-strong', a.strong)
  root.style.setProperty('--accent-soft', a.soft)
  root.style.setProperty('--accent-rgb', a.rgb)
  root.style.setProperty('--accent-border', a.border)
  root.style.setProperty('--panel-alpha', String(appearance.opacity))
  root.style.setProperty(
    '--panel-strong-alpha',
    String(Math.min(0.97, appearance.opacity + 0.18)),
  )
  root.style.setProperty('--glass-blur', `${appearance.blur}px`)
}

function persist() {
  const p: Persisted = {
    theme: appearance.theme,
    accent: appearance.accent,
    wallpaper: appearance.wallpaper,
    blur: appearance.blur,
    opacity: appearance.opacity,
    imagePath: appearance.imagePath,
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    // localStorage 不可用（隐私模式）时不影响当前会话。
  }
}

async function loadImage() {
  if (!appearance.imagePath) {
    appearance.imageDataUrl = null
    return
  }
  try {
    appearance.imageDataUrl = await ipc.readImageDataUrl(appearance.imagePath)
    appearance.imageError = null
  } catch (e) {
    appearance.imageDataUrl = null
    const info = (e as { info?: { message: string } }).info
    appearance.imageError = info?.message ?? (e instanceof Error ? e.message : String(e))
  }
}

let initialized = false

export async function initAppearance() {
  if (initialized) return
  initialized = true
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>
      if (p.theme && THEMES.includes(p.theme)) appearance.theme = p.theme
      if (p.accent && ACCENTS.some((a) => a.id === p.accent)) appearance.accent = p.accent
      if (p.wallpaper && WALLPAPERS.includes(p.wallpaper)) appearance.wallpaper = p.wallpaper
      if (typeof p.blur === 'number') appearance.blur = Math.min(32, Math.max(0, p.blur))
      if (typeof p.opacity === 'number') {
        appearance.opacity = Math.min(0.98, Math.max(0.35, p.opacity))
      }
      if (typeof p.imagePath === 'string' && p.imagePath) {
        appearance.imagePath = p.imagePath
        appearance.imageName = baseName(p.imagePath)
      }
    }
  } catch {
    // 设置损坏：用默认值（外观是辅助数据，不影响查询）。
  }
  apply()
  await loadImage()
  media?.addEventListener('change', () => {
    if (appearance.theme === 'system') apply()
  })
  appearance.ready = true
}

export function setTheme(theme: ThemeMode) {
  appearance.theme = theme
  apply()
  persist()
}

export function setAccent(id: string) {
  if (!ACCENTS.some((a) => a.id === id)) return
  appearance.accent = id
  apply()
  persist()
}

export function setWallpaper(wallpaper: WallpaperPreset) {
  appearance.wallpaper = wallpaper
  persist()
}

export function setBlur(n: number) {
  appearance.blur = Math.min(32, Math.max(0, Math.round(n)))
  apply()
  persist()
}

export function setOpacity(n: number) {
  appearance.opacity = Math.min(0.98, Math.max(0.35, n))
  apply()
  persist()
}

export async function chooseImage() {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: t('图片'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  })
  if (typeof selected !== 'string') return
  try {
    const url = await ipc.readImageDataUrl(selected)
    appearance.imagePath = selected
    appearance.imageName = baseName(selected)
    appearance.imageDataUrl = url
    appearance.imageError = null
    appearance.wallpaper = 'image'
    persist()
  } catch (e) {
    const info = (e as { info?: { message: string } }).info
    appearance.imageError = info?.message ?? (e instanceof Error ? e.message : String(e))
  }
}

export function clearImage() {
  appearance.imagePath = null
  appearance.imageName = null
  appearance.imageDataUrl = null
  appearance.imageError = null
  if (appearance.wallpaper === 'image') appearance.wallpaper = 'auto'
  persist()
}

export async function retryImage() {
  await loadImage()
}

export function resetAppearance() {
  appearance.theme = DEFAULTS.theme
  appearance.accent = DEFAULTS.accent
  appearance.wallpaper = DEFAULTS.wallpaper
  appearance.blur = DEFAULTS.blur
  appearance.opacity = DEFAULTS.opacity
  appearance.imagePath = null
  appearance.imageName = null
  appearance.imageDataUrl = null
  appearance.imageError = null
  apply()
  persist()
}
