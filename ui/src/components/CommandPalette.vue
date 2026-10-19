<script setup lang="ts">
import { NInput, NModal, useMessage } from 'naive-ui'
import { computed, nextTick, ref, watch } from 'vue'
import { appState, connectProfile, isConnected, refreshMeta, toStudioError } from '../stores/app'
import { editorActions } from '../stores/actions'
import { layoutState, resetLayout } from '../stores/layout'
import { activeResultOf, closeResultsOf } from '../stores/query'
import {
  basename,
  openSqlFile,
  openSqlFileDialog,
  saveActiveSql,
  sqlFilesState,
} from '../stores/sqlFiles'
import { openTablePreview } from '../stores/tablePreview'
import { requestExport, uiState } from '../stores/ui'
import {
  activeEditor,
  bindActiveProfile,
  closeEditorTab,
  closeEditorTabs,
  newEditorTab,
  workspaceState,
} from '../stores/workspace'

import { t, tt } from '../i18n'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const message = useMessage()
const inputRef = ref<InstanceType<typeof NInput> | null>(null)
const listRef = ref<HTMLElement | null>(null)
const query = ref('')
const selected = ref(0)

const show = computed({
  get: () => props.show,
  set: (v: boolean) => emit('update:show', v),
})

interface PaletteCommand {
  id: string
  label: string
  group: string
  hint?: string
  shortcut?: string
  disabled?: boolean
  run: () => void | Promise<void>
}

function panelCommand(
  id: string,
  label: string,
  group: string,
  run: () => void,
): PaletteCommand {
  return { id, label, group, run }
}

const baseCommands = computed<PaletteCommand[]>(() => {
  const ed = editorActions.current
  const tab = activeEditor.value
  const result = tab ? activeResultOf(tab.key) : null
  const list: PaletteCommand[] = [
    {
      id: 'exec-current',
      label: t('执行当前语句（有选区时执行选区）'),
      group: t('执行'),
      shortcut: 'Ctrl/⌘ + Enter',
      disabled: !ed,
      run: () => ed?.executeCurrent(),
    },
    {
      id: 'exec-all',
      label: t('执行整篇（逐条，失败即停）'),
      group: t('执行'),
      shortcut: 'Ctrl/⌘ + Shift + Enter',
      disabled: !ed,
      run: () => ed?.executeAll(),
    },
    {
      id: 'exec-to-end',
      label: t('从光标执行到结尾'),
      group: t('执行'),
      disabled: !ed,
      run: () => ed?.executeToEnd(),
    },
    {
      id: 'format-sql',
      label: t('格式化 SQL（有选区时只格式化选区）'),
      group: t('编辑器'),
      shortcut: 'Shift + Alt + F',
      disabled: !ed,
      run: () => ed?.format(),
    },
    {
      id: 'tab-new',
      label: t('新建编辑器标签'),
      group: t('编辑器'),
      shortcut: 'Ctrl/⌘ + T',
      run: () => {
        newEditorTab()
      },
    },
    {
      id: 'tab-close',
      label: t('关闭当前编辑器标签'),
      group: t('编辑器'),
      shortcut: 'Ctrl/⌘ + W',
      disabled: !tab,
      run: () => {
        if (tab) closeEditorTab(tab.key)
      },
    },
    {
      id: 'tab-close-others',
      label: t('关闭其他编辑器标签'),
      group: t('编辑器'),
      disabled: !tab || workspaceState.tabs.length <= 1,
      run: () => {
        if (!tab) return
        closeEditorTabs(
          workspaceState.tabs.filter((t) => t.key !== tab.key).map((t) => t.key),
        )
      },
    },
    {
      id: 'tab-close-right',
      label: t('关闭右侧编辑器标签'),
      group: t('编辑器'),
      disabled: !tab,
      run: () => {
        if (!tab) return
        const idx = workspaceState.tabs.findIndex((t) => t.key === tab.key)
        if (idx >= 0) {
          closeEditorTabs(workspaceState.tabs.slice(idx + 1).map((t) => t.key))
        }
      },
    },
    {
      id: 'file-open',
      label: t('打开 SQL 文件…'),
      group: t('文件'),
      shortcut: 'Ctrl/⌘ + O',
      run: async () => {
        const outcome = await openSqlFileDialog()
        if (outcome) {
          message.success(
            outcome.existing
              ? tt`已切换到已打开的文件：${outcome.tab.title}`
              : tt`已打开 ${outcome.tab.title}`,
          )
        }
      },
    },
    {
      id: 'file-save',
      label: t('保存当前 SQL 文件'),
      group: t('文件'),
      shortcut: 'Ctrl/⌘ + S',
      disabled: !tab,
      run: async () => {
        const outcome = await saveActiveSql(false)
        if (outcome?.saved) message.success(tt`已保存 ${outcome.path}`)
      },
    },
    {
      id: 'file-save-as',
      label: t('SQL 另存为…'),
      group: t('文件'),
      shortcut: 'Ctrl/⌘ + Shift + S',
      disabled: !tab,
      run: async () => {
        const outcome = await saveActiveSql(true)
        if (outcome?.saved) message.success(tt`已保存 ${outcome.path}`)
      },
    },
    {
      id: 'results-close',
      label: t('关闭当前标签的全部结果'),
      group: t('结果'),
      disabled: !tab,
      run: () => {
        if (tab) closeResultsOf(tab.key)
      },
    },
    {
      id: 'result-export',
      label: t('导出当前结果（CSV）'),
      group: t('结果'),
      disabled: !result,
      run: () => {
        if (result) requestExport()
        else message.warning(t('当前标签没有可导出的结果'))
      },
    },
    {
      id: 'meta-refresh',
      label: t('刷新元数据（库 / 表 / 列）'),
      group: t('元数据'),
      disabled: !appState.connection,
      run: async () => {
        try {
          await refreshMeta()
          message.success(t('元数据已刷新'))
        } catch (e) {
          const err = toStudioError(e)
          message.error(`${err.code ?? err.kind}: ${err.message}`)
        }
      },
    },
    panelCommand('panel-connection', t('打开连接管理'), t('面板'), () => {
      uiState.connectionOpen = true
    }),
    panelCommand('panel-notifications', t('打开通知中心（后台查询 / 导入 / 变化流）'), t('面板'), () => {
      uiState.notificationsOpen = true
    }),
    panelCommand('panel-history', t('打开执行历史 / 收藏'), t('面板'), () => {
      uiState.historyOpen = true
    }),
    panelCommand('panel-files', t('打开文件管理（浏览原始段文件）'), t('面板'), () => {
      uiState.filesOpen = true
    }),
    panelCommand('panel-config', t('打开三闸热更'), t('面板'), () => {
      uiState.configOpen = true
    }),
    panelCommand('panel-ops', t('打开会话 / 运行查询'), t('面板'), () => {
      uiState.opsOpen = true
    }),
    panelCommand('panel-watch', t('打开数据变化流'), t('面板'), () => {
      uiState.watchOpen = true
    }),
    panelCommand('panel-grants', t('打开授权矩阵'), t('面板'), () => {
      uiState.grantOpen = true
    }),
    panelCommand('panel-copy', t('打开 COPY 导出向导'), t('面板'), () => {
      uiState.copyOpen = true
    }),
    panelCommand('panel-appearance', t('打开外观设置'), t('面板'), () => {
      uiState.appearanceOpen = true
    }),
    panelCommand('panel-about', t('关于 QSDB Studio（版本 / 作者 / 许可证）'), t('面板'), () => {
      uiState.aboutOpen = true
    }),
    {
      id: 'view-sidebar',
      label: layoutState.sidebarCollapsed ? t('展开侧栏') : t('收起侧栏'),
      group: t('视图'),
      run: () => {
        layoutState.sidebarCollapsed = !layoutState.sidebarCollapsed
      },
    },
    {
      id: 'view-reset',
      label: t('恢复默认布局（侧栏宽度 / 分割比例）'),
      group: t('视图'),
      run: () => {
        resetLayout()
        message.success(t('布局已恢复默认'))
      },
    },
    {
      id: 'view-help',
      label: t('快捷键速查'),
      group: t('视图'),
      shortcut: '?',
      run: () => {
        uiState.helpOpen = true
      },
    },
  ]

  // 最近文件：只列已存在的记录；打开失败会由 store 从最近列表移除。
  for (const path of sqlFilesState.recent) {
    list.push({
      id: `recent-${path}`,
      label: tt`打开最近文件：${basename(path)}`,
      group: t('文件'),
      hint: path,
      run: async () => {
        const outcome = await openSqlFile(path)
        if (!outcome.existing) message.success(tt`已打开 ${outcome.tab.title}`)
      },
    })
  }

  // 连接：切绑 = 只改当前标签；连接 = 打开网络会话后切绑。
  for (const p of appState.profiles) {
    list.push({
      id: `profile-bind-${p.id}`,
      label: tt`当前标签切换到连接：${p.name}`,
      group: t('连接'),
      hint: p.url,
      run: () => bindActiveProfile(p.id),
    })
    if (!isConnected(p.id)) {
      list.push({
        id: `profile-connect-${p.id}`,
        label: tt`连接并绑定：${p.name}`,
        group: t('连接'),
        hint: p.url,
        run: async () => {
          try {
            await connectProfile(p.id)
            bindActiveProfile(p.id)
            message.success(tt`已连接 ${p.name}`)
          } catch (e) {
            const err = toStudioError(e)
            message.error(`${err.code ?? err.kind}: ${err.message}`, { duration: 6000 })
          }
        },
      })
    }
  }

  return list
})

const needle = computed(() => query.value.trim().toLowerCase())

const commandMatches = computed(() => {
  if (!needle.value) return baseCommands.value
  const q = needle.value
  return baseCommands.value.filter((c) =>
    `${c.label} ${c.group} ${c.hint ?? ''}`.toLowerCase().includes(q),
  )
})

const tableMatches = computed(() => {
  if (!needle.value) return []
  const q = needle.value
  return appState.tables.filter((t) => t.name.toLowerCase().includes(q))
})

const TABLE_LIMIT = 50

const filtered = computed<PaletteCommand[]>(() => {
  const out = [...commandMatches.value]
  const tables = tableMatches.value
  for (const table of tables.slice(0, TABLE_LIMIT)) {
    out.push({
      id: `table-${table.name}`,
      label: tt`打开表 ${table.name}（自动分页，500 行/页）`,
      group: t('表'),
      hint: tt`${table.columns.length} 列`,
      run: () => {
        const outcome = openTablePreview(table)
        if (outcome && !outcome.executed) {
          message.warning(t('已打开查询 SQL；当前标签的连接尚未打开。'), { duration: 6000 })
        }
      },
    })
  }
  if (tables.length > TABLE_LIMIT) {
    out.push({
      id: 'table-more',
      label: tt`还有 ${tables.length - TABLE_LIMIT} 张表匹配，请继续输入缩小范围`,
      group: t('表'),
      disabled: true,
      run: () => {},
    })
  }
  return out
})

function resetSelection() {
  const i = filtered.value.findIndex((c) => !c.disabled)
  selected.value = Math.max(0, i)
}

watch(query, () => {
  resetSelection()
})

watch(
  () => props.show,
  (open) => {
    if (!open) return
    query.value = ''
    resetSelection()
    void nextTick(() => inputRef.value?.focus())
  },
  { immediate: true },
)

function move(delta: number) {
  const list = filtered.value
  if (list.length === 0) return
  let i = selected.value
  for (let k = 0; k < list.length; k++) {
    i = (i + delta + list.length) % list.length
    if (!list[i].disabled) {
      selected.value = i
      break
    }
  }
  void nextTick(() => {
    listRef.value?.querySelector('.cmd.active')?.scrollIntoView({ block: 'nearest' })
  })
}

async function runCommand(cmd: PaletteCommand) {
  if (cmd.disabled) return
  show.value = false
  try {
    await cmd.run()
  } catch (e) {
    const err = toStudioError(e)
    message.error(`${err.code ?? err.kind}: ${err.message}`, { duration: 6000 })
  }
}

function runSelected() {
  const cmd = filtered.value[selected.value]
  if (cmd) void runCommand(cmd)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    move(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    move(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    runSelected()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    show.value = false
  }
}

</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="$t('命令面板')"
    :bordered="false"
    :closable="false"
    class="palette-modal"
    style="width: 680px; max-width: 92vw"
  >
    <NInput
      ref="inputRef"
      v-model:value="query"
      size="large"
      clearable
      :placeholder="$t('输入命令、表名或连接名…')"
      @keydown="onKeydown"
    />
    <div ref="listRef" class="cmd-list">
      <div
        v-for="(cmd, i) in filtered"
        :key="cmd.id"
        class="cmd"
        :class="{ active: i === selected, disabled: cmd.disabled }"
        @mousemove="selected = i"
        @click="runCommand(cmd)"
      >
        <span class="cmd-group">{{ cmd.group }}</span>
        <span class="cmd-label">{{ cmd.label }}</span>
        <span v-if="cmd.hint" class="cmd-hint">{{ cmd.hint }}</span>
        <span v-if="cmd.shortcut" class="cmd-shortcut">{{ cmd.shortcut }}</span>
      </div>
      <div v-if="filtered.length === 0" class="cmd-empty">
        <template v-if="needle">{{ $t("没有匹配的命令或表：") }}{{ query }}</template>
        <template v-else>{{ $t("没有可用命令（连接后会有更多操作）") }}</template>
      </div>
    </div>
    <div class="cmd-foot">
      {{ $t("↑↓ 选择 · Enter 执行 · Esc 关闭 · 输入表名可直接跳转预览") }}
    </div>
  </NModal>
</template>

<style scoped>
.cmd-list {
  max-height: 430px;
  overflow: auto;
  margin-top: 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  background: var(--surface-soft);
}

.cmd {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 34px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-subtle);
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text-soft);
}

.cmd:last-child {
  border-bottom: none;
}

.cmd.active {
  background: var(--accent-soft);
  color: var(--text);
}

.cmd.disabled {
  opacity: 0.45;
  cursor: default;
}

.cmd-group {
  flex: 0 0 44px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--muted);
  text-transform: uppercase;
}

.cmd.active .cmd-group {
  color: var(--accent-strong);
}

.cmd-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmd-hint {
  flex: 0 1 180px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  text-align: right;
}

.cmd-shortcut {
  flex: 0 0 auto;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
  background: var(--surface-raised);
}

.cmd-empty {
  padding: 20px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
}

.cmd-foot {
  padding-top: 8px;
  font-size: 10.5px;
  color: var(--muted);
  text-align: center;
}
</style>
