// 表行 → 查询窗口的自定义拖拽状态。
//
// 不用原生 HTML5 DnD：Tauri 在 Windows 上接管窗口拖放（用于 .sql 文件拖入），
// 原生 dragstart/drop 会被系统拖放层吞掉。这里用 pointer 事件自己画 ghost，
// 松手时按落点是否在 .editor-pane 内决定是否生成查询。

import { reactive } from 'vue'

export const tableDragState = reactive({
  active: false,
  overEditor: false,
  tableName: '',
})

export function resetTableDrag(): void {
  tableDragState.active = false
  tableDragState.overEditor = false
  tableDragState.tableName = ''
}
