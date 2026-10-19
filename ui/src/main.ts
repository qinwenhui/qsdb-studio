import { createApp } from 'vue'
import App from './App.vue'
import { t } from './i18n'
import { initAppearance } from './stores/appearance'
import './styles/global.css'
// 同步应用结果网格字号/行高变量，避免首帧使用旧密度。
import './stores/uiPrefs'

// 先读外观/语言设置并应用主题，避免深色模式首帧闪白；
// 自定义壁纸是异步读取的，稍后补上。
void initAppearance()

// QSDB Studio renders its own context menus (metadata tree, result grid,
// editor tabs, Monaco). Suppress WebView2's browser menu (Refresh / Save as /
// Print / More tools) globally; preventDefault does not stop our handlers.
window.addEventListener(
  'contextmenu',
  (event) => {
    event.preventDefault()
  },
  { capture: true },
)

const app = createApp(App)
app.config.globalProperties.$t = t
app.mount('#app')
