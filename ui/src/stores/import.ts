// CSV 导入向导状态：从元数据树表节点打开，绑定一张表。

import { reactive } from 'vue'
import type { WireTable } from '../ipc/types'
import { appState } from './app'

export const importState = reactive({
  visible: false,
  table: null as WireTable | null,
  /** 打开向导时快照的连接：多标签下切走标签也不改变导入目标。 */
  profileId: null as string | null,
})

export function openImport(table: WireTable) {
  importState.table = table
  importState.profileId = appState.activeProfileId
  importState.visible = true
}

export function closeImport() {
  importState.visible = false
}
