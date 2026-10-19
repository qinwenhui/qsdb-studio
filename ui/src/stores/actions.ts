// 编辑器动作注册：命令面板通过它触发“执行当前语句/全部/到结尾”，
// 具体实现仍由 SqlWorkbench 提供（不复制一套执行逻辑）。

import { reactive } from 'vue'

export interface EditorActions {
  executeCurrent: () => void
  executeAll: () => void
  executeToEnd: () => void
  format: () => void
}

export const editorActions = reactive<{ current: EditorActions | null }>({
  current: null,
})
