// 客户端自身版本信息（来自 Tauri 配置，唯一真值 = tauri.conf.json）。
//
// 服务端版本是 appState.connection.version，两者不要混用；状态栏与“关于”
// 面板都读这里。读取失败（例如纯浏览器里跑 Vite）时保持空串，不伪造版本。
import { getTauriVersion, getVersion } from '@tauri-apps/api/app'
import { reactive } from 'vue'

export const appInfo = reactive({
  version: '',
  tauriVersion: '',
  loaded: false,
  loading: false,
})

let pending: Promise<void> | null = null

export function loadAppInfo(): Promise<void> {
  if (appInfo.loaded) return Promise.resolve()
  if (pending) return pending
  appInfo.loading = true
  pending = Promise.all([getVersion(), getTauriVersion()])
    .then(([version, tauriVersion]) => {
      appInfo.version = version
      appInfo.tauriVersion = tauriVersion
      appInfo.loaded = true
    })
    .catch(() => {
      // 非 Tauri 运行环境：保持空值，不把未知显示成 0.1.0。
    })
    .finally(() => {
      appInfo.loading = false
      pending = null
    })
  return pending
}
