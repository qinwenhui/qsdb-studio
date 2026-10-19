import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Tauri 桌面壳：端口固定 1420（tauri.conf.json 的 devUrl），出错不静默换端口。
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/crates/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'esnext',
    // Monaco 体积 ~3MB（设计已接受）；分开告警阈值，避免噪音。
    chunkSizeWarningLimit: 4000,
  },
})
