<script setup lang="ts">
import {
  darkTheme,
  dateEnUS,
  dateZhCN,
  enUS,
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  zhCN,
} from 'naive-ui'
import { computed } from 'vue'
import { language } from './i18n'
import MainView from './views/MainView.vue'
import {
  appearance,
  currentAccent,
  wallpaperClass,
  wallpaperStyle,
} from './stores/appearance'

const theme = computed(() => (appearance.isDark ? darkTheme : null))
const naiveLocale = computed(() => (language.locale === 'en' ? enUS : zhCN))
const naiveDateLocale = computed(() => (language.locale === 'en' ? dateEnUS : dateZhCN))

const themeOverrides = computed(() => {
  const a = currentAccent.value
  return {
    common: {
      primaryColor: a.primary,
      primaryColorHover: a.hover,
      primaryColorPressed: a.pressed,
      primaryColorSuppl: a.hover,
      borderRadius: '10px',
      borderRadiusSmall: '8px',
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
      fontSize: '13px',
      bodyColor: 'transparent',
      cardColor: appearance.isDark ? 'rgba(23, 27, 36, 0.88)' : 'rgba(255, 255, 255, 0.88)',
      modalColor: appearance.isDark ? 'rgba(23, 27, 36, 0.94)' : 'rgba(255, 255, 255, 0.94)',
      popoverColor: appearance.isDark ? 'rgba(28, 32, 42, 0.96)' : 'rgba(255, 255, 255, 0.96)',
    },
    Button: {
      borderRadiusMedium: '10px',
      borderRadiusSmall: '8px',
      fontWeight: '500',
    },
    Input: {
      borderRadius: '10px',
    },
    Select: {
      peers: {
        InternalSelection: {
          borderRadius: '10px',
        },
      },
    },
  }
})

</script>

<template>
  <NConfigProvider
    :theme="theme"
    :locale="naiveLocale"
    :date-locale="naiveDateLocale"
    :theme-overrides="themeOverrides"
  >
    <div class="app-canvas">
      <div class="wallpaper" :class="wallpaperClass" :style="wallpaperStyle" />
      <div class="wallpaper-veil" />
      <div class="ambient-wash" aria-hidden="true" />
      <div class="ambient-grid" aria-hidden="true" />
      <NMessageProvider placement="top">
        <NDialogProvider>
          <MainView />
        </NDialogProvider>
      </NMessageProvider>
    </div>
  </NConfigProvider>
</template>

<style scoped>
.app-canvas {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

.ambient-wash {
  position: fixed;
  inset: -12%;
  z-index: 0;
  pointer-events: none;
  background:
    radial-gradient(
      ellipse 46% 42% at 18% 4%,
      rgba(var(--accent-rgb), 0.14),
      transparent 68%
    ),
    radial-gradient(
      ellipse 40% 36% at 88% 12%,
      rgba(90, 215, 255, 0.09),
      transparent 70%
    ),
    radial-gradient(
      ellipse 44% 40% at 66% 100%,
      rgba(var(--accent-rgb), 0.07),
      transparent 72%
    );
  filter: blur(12px);
  opacity: 0.7;
  animation: ambient-breathe 28s ease-in-out infinite alternate;
}

html[data-theme='dark'] .ambient-wash {
  background:
    radial-gradient(
      ellipse 58% 40% at 50% -8%,
      rgba(55, 120, 255, 0.22),
      transparent 72%
    ),
    radial-gradient(
      ellipse 48% 42% at 16% 2%,
      rgba(var(--accent-rgb), 0.2),
      transparent 66%
    ),
    radial-gradient(
      ellipse 42% 38% at 92% 18%,
      rgba(90, 215, 255, 0.13),
      transparent 68%
    ),
    radial-gradient(
      ellipse 50% 44% at 60% 100%,
      rgba(var(--accent-rgb), 0.11),
      transparent 72%
    );
  opacity: 1;
}

.ambient-grid {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(80, 105, 145, 0.055) 1px, transparent 1px),
    linear-gradient(90deg, rgba(80, 105, 145, 0.055) 1px, transparent 1px);
  background-size: 72px 72px;
  -webkit-mask-image: radial-gradient(
    ellipse 78% 62% at 50% 0%,
    #000 0%,
    transparent 78%
  );
  mask-image: radial-gradient(
    ellipse 78% 62% at 50% 0%,
    #000 0%,
    transparent 78%
  );
  opacity: 0.45;
}

html[data-theme='dark'] .ambient-grid {
  background-image:
    linear-gradient(rgba(140, 175, 230, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(140, 175, 230, 0.05) 1px, transparent 1px);
  opacity: 0.75;
}

@keyframes ambient-breathe {
  0% {
    transform: translate3d(-1.5%, -1%, 0) scale(1);
    opacity: 0.62;
  }
  100% {
    transform: translate3d(1.5%, 1.2%, 0) scale(1.035);
    opacity: 0.9;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ambient-wash {
    animation: none;
  }
}
</style>
