<script setup lang="ts">
import { NModal } from 'naive-ui'
import { computed } from 'vue'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const show = computed({
  get: () => props.show,
  set: (v: boolean) => emit('update:show', v),
})

interface ShortcutRow {
  keys: string
  action: string
}

const groups: { name: string; rows: ShortcutRow[] }[] = [
  {
    name: '执行',
    rows: [
      { keys: 'Ctrl/⌘ + Enter', action: '执行光标所在语句（有选区时只执行选区）' },
      { keys: 'Ctrl/⌘ + Shift + Enter', action: '执行整篇（逐条，失败即停）' },
      { keys: '工具栏 ▾', action: '选择当前语句 / 选区 / 全部 / 光标到结尾' },
    ],
  },
  {
    name: '编辑器与文件',
    rows: [
      { keys: 'Ctrl/⌘ + T', action: '新建编辑器标签' },
      { keys: 'Ctrl/⌘ + W', action: '关闭当前编辑器标签' },
      { keys: 'Ctrl + Tab / Ctrl + Shift + Tab', action: '按顺序循环标签（Ctrl+PageUp/PageDown 同义）' },
      { keys: '双击标题 / 右键 / 拖拽 / 中键', action: '重命名 / 标签菜单 / 排序 / 关闭标签' },
      { keys: 'Ctrl/⌘ + O', action: '打开 .sql 文件到新标签' },
      { keys: 'Ctrl/⌘ + S', action: '保存当前 SQL 文件' },
      { keys: 'Ctrl/⌘ + Shift + S', action: '另存为 .sql 文件' },
      { keys: 'Shift + Alt + F', action: '格式化 SQL（也可用 Ctrl/⌘+Alt+L；选区优先）' },
    ],
  },
  {
    name: '命令面板与导航',
    rows: [
      { keys: 'Ctrl/⌘ + K', action: '打开命令面板（也可用 Ctrl/⌘+Shift+P）' },
      { keys: 'Ctrl/⌘ + B', action: '展开 / 收起数据浏览器侧栏' },
      { keys: '左侧活动栏', action: '数据浏览器、文件管理、历史、连接、会话、变化流、授权、三闸、COPY、通知、关于、外观' },
      { keys: '?', action: '打开本快捷键速查（输入框/编辑器内不触发）' },
      { keys: '↑ ↓ / Enter / Esc', action: '命令面板内选择 / 执行 / 关闭' },
    ],
  },
  {
    name: '元数据树',
    rows: [
      { keys: '↑ ↓', action: '在库 / 表之间移动焦点' },
      { keys: '→ / ←', action: '展开 / 收起当前节点' },
      { keys: 'Enter 或双击表', action: '打开并执行表查询（自动分页，500 行/页）' },
      { keys: '左键拖表到查询窗口', action: '生成 SELECT * FROM 表 并在新标签执行' },
      { keys: '右键', action: '复制名、分区、导入、刷新等' },
    ],
  },
  {
    name: '结果网格',
    rows: [
      { keys: '单击 / Shift+单击', action: '选择单元格 / 扩展矩形选区' },
      { keys: '方向键（按住 Shift）', action: '移动选择 / 扩展选区' },
      { keys: 'Ctrl/⌘ + C', action: '复制选区（TSV，粘 Excel 列不乱）' },
      { keys: 'Enter 或双击', action: '打开行详情（完整值 / 类型 / NULL）' },
      { keys: '列头单击 / 右键', action: '排序 / 复制列、隐藏列、更多复制格式' },
    ],
  },
]
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="$t('快捷键速查')"
    :bordered="false"
    style="width: 620px; max-width: 92vw"
  >
    <div class="help-body">
      <section v-for="g in groups" :key="g.name" class="group">
        <div class="group-name">{{ $t(g.name) }}</div>
        <div v-for="r in g.rows" :key="r.keys + r.action" class="row">
          <span class="keys mono">{{ $t(r.keys) }}</span>
          <span class="action">{{ $t(r.action) }}</span>
        </div>
      </section>
    </div>
  </NModal>
</template>

<style scoped>
.help-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 66vh;
  overflow: auto;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.group-name {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 2px;
}

.row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 4px 6px;
  border-radius: 5px;
}

.row:nth-child(odd) {
  background: var(--surface-soft);
}

.keys {
  flex: 0 0 190px;
  font-size: 11px;
  color: var(--text);
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 1px 5px;
  background: var(--surface-raised);
  white-space: nowrap;
}

.action {
  flex: 1;
  font-size: 12px;
  color: var(--text-soft);
  line-height: 1.45;
}

.mono {
  font-family: var(--mono);
}
</style>
