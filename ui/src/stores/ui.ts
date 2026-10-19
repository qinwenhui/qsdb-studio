import { reactive } from 'vue'

/** 编辑器行内错误标记；`editorKey` 保证批执行失败只标在发起它的标签上。 */
export interface ErrorMarker {
  line: number
  message: string
  nonce: number
  editorKey: string
}

export const uiState = reactive({
  connectionOpen: false,
  historyOpen: false,
  configOpen: false,
  opsOpen: false,
  watchOpen: false,
  /** 文件管理面：浏览 / 详情 / 回收站删除原始段文件。 */
  filesOpen: false,
  grantOpen: false,
  appearanceOpen: false,
  copyOpen: false,
  commandOpen: false,
  helpOpen: false,
  /** 通知中心（会话内回看，不落盘）。 */
  notificationsOpen: false,
  /** 关于：客户端版本 / 作者 / 仓库 / 许可 / QSDB 简介。 */
  aboutOpen: false,
  /** 当前活动编辑器标签 key（workspace 同步；通知层判断前后台用）。 */
  activeEditorKey: '',
  /** 命令面板请求导出当前结果（ResultPanel 监听）。 */
  exportNonce: 0,
  errorMarker: null as ErrorMarker | null,
})

export function requestExport(): void {
  uiState.exportNonce += 1
}

let markerNonce = 0

export function markError(line: number, message: string, editorKey = '') {
  uiState.errorMarker = { line, message, nonce: ++markerNonce, editorKey }
}

export function clearErrorMarker() {
  uiState.errorMarker = null
}
