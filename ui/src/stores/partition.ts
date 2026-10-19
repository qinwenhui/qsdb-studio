// 分区面板状态：表 → /partitions；预览 / OVERWRITE 模板都走现有 API。

import { reactive } from 'vue'
import * as ipc from '../ipc'
import type { StudioError, WirePartition, WireTable } from '../ipc/types'
import { t } from '../i18n'
import { appState, toStudioError } from './app'

export const partitionState = reactive({
  visible: false,
  table: null as WireTable | null,
  /** 打开面板时快照的连接：多标签下切走标签也不改变本面板的目标。 */
  profileId: null as string | null,
  partitions: [] as WirePartition[],
  loading: false,
  error: null as StudioError | null,
})

export async function openPartitions(table: WireTable): Promise<void> {
  partitionState.table = table
  partitionState.profileId = appState.activeProfileId
  partitionState.visible = true
  partitionState.partitions = []
  partitionState.error = null
  await loadPartitions()
}

export async function loadPartitions(): Promise<void> {
  const table = partitionState.table
  const id = partitionState.profileId ?? appState.activeProfileId
  if (!table) return
  if (!id) {
    partitionState.error = {
      kind: 'usage',
      message: t('尚未连接 QSDB 实例'),
      retriable: false,
    }
    return
  }
  partitionState.loading = true
  partitionState.error = null
  try {
    partitionState.partitions = await ipc.metaPartitions(id, table.name)
  } catch (e) {
    partitionState.error = toStudioError(e)
  } finally {
    partitionState.loading = false
  }
}

export function closePartitions(): void {
  partitionState.visible = false
}
