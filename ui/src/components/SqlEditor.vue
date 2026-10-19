<script setup lang="ts">
// 只引编辑器 API + SQL 语言 + 必要贡献，避免把 80+ 种语言打包进来。
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/editor/browser/coreCommands'
import 'monaco-editor/editor/common/standaloneStrings'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/contrib/comment/browser/comment'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu'
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/folding/browser/folding'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution'
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations'
import 'monaco-editor/languages/definitions/sql/register'
// 注意 monaco 0.57 的 exports 映射把 `./*` 指到 `esm/vs/*.js`，
// 所以子路径写 `monaco-editor/editor/editor.worker`（不要带 esm/vs 前缀）。
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { WireTable } from '../ipc/types'
import { appearance } from '../stores/appearance'
import type { ErrorMarker } from '../stores/ui'
import { uiPrefs } from '../stores/uiPrefs'
import { buildCompletions, type CompletionKind } from '../utils/completions'
import { formatSql } from '../utils/formatSql'
import { hoverMarkdown } from '../utils/hover'

import { t, tt } from '../i18n'

/** 执行方式：当前语句（选区优先）/ 仅选区 / 全部 / 光标到结尾。 */
export type ExecuteMode = 'statement' | 'selection' | 'all' | 'toEnd'

export interface ExecuteRequest {
  mode: ExecuteMode
  selection: string | null
  selectionStart: number
  cursor: number
  /** 光标所在 1 基行号（当前语句定位用）。 */
  cursorLine: number
}

export interface FormatResult {
  ok: boolean
  error?: string
}

/** 每个编辑器标签独立保存的视图状态（切换标签/重启后恢复）。 */
export interface EditorViewState {
  cursor: number
  scrollTop: number
}

/** 回报时带上所属标签 key，父组件可丢弃切标签瞬间的迟到事件。 */
export interface EditorViewReport extends EditorViewState {
  tabKey: string
}

const props = defineProps<{
  modelValue: string
  marker: ErrorMarker | null
  /** 当前库的表/列缓存（来自 `meta_tables`，补全零额外请求）。 */
  schema: WireTable[]
  /** 当前活动标签 key：用来区分“切标签”与“同一标签内容变化”。 */
  tabKey: string
  /** 该标签上次的光标偏移与滚动位置。 */
  view: EditorViewState
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'execute', req: ExecuteRequest): void
  (e: 'selection-change', active: boolean): void
  (e: 'format-error', message: string): void
  (e: 'view-change', view: EditorViewReport): void
}>()

// Monaco 基础 worker（SQL 不需要语言服务；仅编辑器 worker）。
;(self as unknown as { MonacoEnvironment: { getWorker(): Worker } }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

const host = ref<HTMLElement | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
let applying = false
let currentSchema: WireTable[] = props.schema
let completionDisposable: monaco.IDisposable | null = null
let hoverDisposable: monaco.IDisposable | null = null
/** 切标签/外部替换内容期间抑制视图回报，避免把恢复中的瞬态位置写回标签。 */
let suppressView = false
let viewTimer: number | undefined
let loadedTabKey = ''

function completionKind(kind: CompletionKind): monaco.languages.CompletionItemKind {
  switch (kind) {
    case 'keyword':
      return monaco.languages.CompletionItemKind.Keyword
    case 'table':
      return monaco.languages.CompletionItemKind.Struct
    case 'partition':
      return monaco.languages.CompletionItemKind.Property
    case 'snippet':
      return monaco.languages.CompletionItemKind.Snippet
    case 'alias':
      return monaco.languages.CompletionItemKind.Variable
    default:
      return monaco.languages.CompletionItemKind.Field
  }
}

monaco.editor.defineTheme('qsdb-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '2a56cc', fontStyle: 'bold' },
    { token: 'string', foreground: '16794c' },
    { token: 'number', foreground: '9a5b00' },
    { token: 'comment', foreground: '8a94a6', fontStyle: 'italic' },
    { token: 'operator', foreground: '3d4757' },
    { token: 'delimiter', foreground: '5d6a7e' },
  ],
  colors: {
    'editor.background': '#fbfcff',
    'editor.lineHighlightBackground': '#f3f6ff',
    'editorLineNumber.foreground': '#a7b1c0',
    'editorLineNumber.activeForeground': '#3d4757',
    'editor.selectionBackground': '#dbe7ff',
    'editor.inactiveSelectionBackground': '#e8eefb',
    'editorCursor.foreground': '#3b6ef5',
    'editorIndentGuide.background1': '#eef1f5',
    'editorIndentGuide.activeBackground1': '#dbe2ec',
    'editorGutter.background': '#fbfcff',
    // 右键菜单：自定义主题必须显式给出，否则菜单容器背景为空（透明）。
    'menu.background': '#ffffff',
    'menu.foreground': '#2a3444',
    'menu.border': '#dbe3ef',
    'menu.selectionBackground': '#eef3ff',
    'menu.selectionForeground': '#17202e',
    'menu.selectionBorder': '#3b6ef5',
    'menu.separatorBackground': '#e8edf5',
    'list.hoverBackground': '#eef3ff',
    'list.hoverForeground': '#17202e',
    'widget.shadow': '#2e0f172a',
    'editorWidget.border': '#dbe3ef',
  },
})

monaco.editor.defineTheme('qsdb-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '9bb7ff', fontStyle: 'bold' },
    { token: 'string', foreground: '7dd3a8' },
    { token: 'number', foreground: 'ffc66d' },
    { token: 'comment', foreground: '6f7a8a', fontStyle: 'italic' },
    { token: 'operator', foreground: 'c7d0de' },
    { token: 'delimiter', foreground: '93a0b3' },
  ],
  colors: {
    'editor.background': '#151a22',
    'editor.lineHighlightBackground': '#1b2230',
    'editorLineNumber.foreground': '#5d6879',
    'editorLineNumber.activeForeground': '#c7d0de',
    'editor.selectionBackground': '#2b3b5c',
    'editor.inactiveSelectionBackground': '#233048',
    'editorCursor.foreground': '#7ea2ff',
    'editorIndentGuide.background1': '#232a36',
    'editorIndentGuide.activeBackground1': '#2f3a4a',
    'editorGutter.background': '#151a22',
    // 右键菜单：深色主题下的菜单背景/选中态。
    'menu.background': '#1b2230',
    'menu.foreground': '#dbe3ef',
    'menu.border': '#24ffffff',
    'menu.selectionBackground': '#2e7ea2ff',
    'menu.selectionForeground': '#f3f7ff',
    'menu.selectionBorder': '#7ea2ff',
    'menu.separatorBackground': '#1fffffff',
    'list.hoverBackground': '#2e7ea2ff',
    'list.hoverForeground': '#f3f7ff',
    'widget.shadow': '#73000000',
    'editorWidget.border': '#24ffffff',
  },
})

/**
 * 格式化：有选区只格式化选区，否则整篇。用 executeEdits 保留撤销栈；
 * 格式化失败不修改任何内容，由调用方显式报错。
 */
function formatEditor(): FormatResult {
  if (!editor) return { ok: false, error: t('编辑器尚未就绪') }
  const model = editor.getModel()
  if (!model) return { ok: false, error: t('编辑器没有内容') }
  const sel = editor.getSelection()
  const whole = !sel || sel.isEmpty() || !model.getValueInRange(sel).trim()
  const range = whole ? model.getFullModelRange() : sel
  const text = model.getValueInRange(range)
  if (!text.trim()) return { ok: false, error: t('没有可格式化的 SQL') }
  try {
    const formatted = formatSql(text)
    if (formatted === text) return { ok: true }
    editor.pushUndoStop()
    editor.executeEdits('qsdb-format', [{ range, text: formatted, forceMoveMarkers: true }])
    editor.pushUndoStop()
    const start = range.getStartPosition()
    editor.setPosition(start)
    editor.revealPositionInCenterIfOutsideViewport(start)
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      error: tt`SQL 格式化失败（未修改内容）：${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

function execute(mode: ExecuteMode) {
  if (!editor) return
  const model = editor.getModel()
  const pos = editor.getPosition()
  if (!model || !pos) return
  const sel = editor.getSelection()
  let selection: string | null = null
  let selectionStart = model.getOffsetAt(pos)
  if (sel && !sel.isEmpty()) {
    const text = model.getValueInRange(sel)
    if (text.trim()) {
      selection = text
      selectionStart = model.getOffsetAt(sel.getStartPosition())
    }
  }
  emit('execute', {
    mode,
    selection,
    selectionStart,
    cursor: model.getOffsetAt(pos),
    cursorLine: pos.lineNumber,
  })
}

// ---------------------------------------------------------------------------
// 标签视图状态：光标偏移 + 垂直滚动位置
// ---------------------------------------------------------------------------

function snapshotView(): EditorViewState | null {
  if (!editor) return null
  const model = editor.getModel()
  const pos = editor.getPosition()
  if (!model || !pos) return null
  return {
    cursor: model.getOffsetAt(pos),
    scrollTop: Math.round(editor.getScrollTop()),
  }
}

function emitView() {
  if (!editor || suppressView || applying) return
  const view = snapshotView()
  if (!view) return
  emit('view-change', { ...view, tabKey: loadedTabKey })
}

/** 滚动事件很密集：合并到 ~120ms 一次，持久化 watcher 本身也有防抖。 */
function scheduleViewEmit() {
  if (viewTimer !== undefined || suppressView) return
  viewTimer = window.setTimeout(() => {
    viewTimer = undefined
    emitView()
  }, 120)
}

/** 把光标/滚动恢复到该标签上次的位置；越界偏移按当前文档长度收敛。 */
function restoreView() {
  if (!editor) return
  const model = editor.getModel()
  if (!model) return
  const cursor = Math.max(0, Math.min(model.getValueLength(), Math.round(props.view.cursor)))
  editor.setPosition(model.getPositionAt(cursor), 'qsdb-restore-view')
  editor.setScrollTop(Math.max(0, Math.round(props.view.scrollTop)))
}

/**
 * 标签切换或内容被外部替换（历史回填）时：先换内容，再恢复该标签的视图。
 * 用两帧的抑制窗口覆盖 Monaco 因 setValue/布局产生的瞬态光标与滚动事件。
 */
function syncTabContent(tabKey: string, value: string) {
  if (!editor) return
  const tabChanged = tabKey !== loadedTabKey
  const contentChanged = value !== editor.getValue()
  if (!tabChanged && !contentChanged) return
  loadedTabKey = tabKey
  suppressView = true
  window.clearTimeout(viewTimer)
  viewTimer = undefined
  if (contentChanged) {
    applying = true
    editor.setValue(value)
    applying = false
  }
  restoreView()
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      suppressView = false
    })
  })
}

onMounted(() => {
  if (!host.value) return
  editor = monaco.editor.create(host.value, {
    value: props.modelValue,
    language: 'sql',
    theme: appearance.isDark ? 'qsdb-dark' : 'qsdb-light',
    automaticLayout: true,
    fontFamily:
      "'JetBrains Mono', 'Cascadia Code', 'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
    fontSize: uiPrefs.editorFontSize,
    lineHeight: uiPrefs.editorLineHeight,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    renderLineHighlight: 'line',
    lineNumbersMinChars: 4,
    tabSize: 2,
    padding: { top: 10, bottom: 12 },
    wordWrap: 'off',
    bracketPairColorization: { enabled: true },
    guides: { indentation: true },
    suggestOnTriggerCharacters: true,
    quickSuggestions: true,
    // 只用 schema 感知补全：Monaco 默认的“文档里出现过的词”会在字符串/注释里
    // 弹出无关候选，破坏“字面量内不补全”的约定。
    wordBasedSuggestions: 'off',
    fixedOverflowWidgets: true,
  })

  editor.onDidChangeModelContent(() => {
    if (applying || !editor) return
    emit('update:modelValue', editor.getValue())
  })

  // Ctrl/Cmd+Enter：有选区执行选区，否则执行光标所在语句。
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
    execute('statement'),
  )
  // Ctrl/Cmd+Shift+Enter：有选区执行选区，否则执行整篇（逐条）。
  editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
    () => execute('all'),
  )

  // 格式化：Shift+Alt+F（VS Code 习惯）/ Ctrl/Cmd+Alt+L（DataGrip 习惯）。
  editor.addAction({
    id: 'qsdb.format-sql',
    label: t('格式化 SQL'),
    keybindings: [
      monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL,
    ],
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 1.5,
    run: () => {
      const r = formatEditor()
      if (!r.ok && r.error) emit('format-error', r.error)
    },
  })

  editor.onDidChangeCursorSelection(() => {
    if (!editor) return
    const sel = editor.getSelection()
    const model = editor.getModel()
    const active = Boolean(sel && model && !sel.isEmpty() && model.getValueInRange(sel).trim())
    emit('selection-change', active)
  })

  editor.onDidChangeCursorPosition(() => emitView())
  editor.onDidScrollChange((e) => {
    if (e.scrollTopChanged) scheduleViewEmit()
  })

  // schema 感知补全：关键词 / 表名 / 列名 / 别名 / 片段；按当前语句的
  // FROM/JOIN 作用域与 INSERT 列清单收敛候选。
  completionDisposable = monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position)
      // 整段“光标前文本”：作用域（FROM/JOIN/别名）与字符串/注释判定都靠它。
      const textBefore = model.getValueInRange(
        new monaco.Range(1, 1, position.lineNumber, position.column),
      )
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      )
      return {
        suggestions: buildCompletions(currentSchema, word.word, textBefore).map((e) => ({
          label: e.label,
          kind: completionKind(e.kind),
          detail: e.detail,
          insertText: e.insertText,
          insertTextRules: e.snippet
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
          sortText: e.sortText,
          range,
        })),
      }
    },
  })

  // Hover：表 / 列的 schema 信息（不额外发请求）。
  hoverDisposable = monaco.languages.registerHoverProvider('sql', {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position)
      if (!word) return null
      const md = hoverMarkdown(currentSchema, word.word)
      if (!md) return null
      return {
        range: new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        ),
        contents: [{ value: md }],
      }
    },
  })

  applyMarker(props.marker)

  // 首次挂载：等一帧让自动布局拿到尺寸，再恢复该标签的光标/滚动位置。
  loadedTabKey = props.tabKey
  suppressView = true
  window.requestAnimationFrame(() => {
    restoreView()
    window.requestAnimationFrame(() => {
      suppressView = false
    })
  })
})

// 标签切换或同一标签内容被外部替换：换内容并恢复视图。
watch(
  () => [props.tabKey, props.modelValue] as const,
  ([tabKey, value]) => syncTabContent(tabKey, value),
)

watch(
  () => props.marker,
  (m) => applyMarker(m),
)

watch(
  () => props.schema,
  (s) => {
    currentSchema = s
  },
)

watch(
  () => appearance.isDark,
  (dark) => {
    monaco.editor.setTheme(dark ? 'qsdb-dark' : 'qsdb-light')
  },
)

// 字号/行高实时生效；光标与滚动位置由 Monaco 保持（不改内容）。
watch(
  () => [uiPrefs.editorFontSize, uiPrefs.editorLineHeight] as const,
  ([fontSize, lineHeight]) => {
    editor?.updateOptions({ fontSize, lineHeight })
  },
)

function applyMarker(marker: ErrorMarker | null) {
  if (!editor) return
  const model = editor.getModel()
  if (!model) return
  if (!marker) {
    monaco.editor.setModelMarkers(model, 'qsdb', [])
    return
  }
  const line = Math.max(1, Math.min(marker.line, model.getLineCount()))
  monaco.editor.setModelMarkers(model, 'qsdb', [
    {
      startLineNumber: line,
      startColumn: 1,
      endLineNumber: line,
      endColumn: model.getLineMaxColumn(line),
      message: marker.message,
      severity: monaco.MarkerSeverity.Error,
    },
  ])
  editor.revealLineInCenterIfOutsideViewport(line)
  editor.setPosition({ lineNumber: line, column: 1 })
}

onBeforeUnmount(() => {
  window.clearTimeout(viewTimer)
  viewTimer = undefined
  completionDisposable?.dispose()
  completionDisposable = null
  hoverDisposable?.dispose()
  hoverDisposable = null
  editor?.dispose()
  editor = null
})

defineExpose({
  /** Ctrl/Cmd+Enter 的默认目标（选区优先，否则当前语句）。 */
  executeDefault: () => execute('statement'),
  /** 仅执行选区。 */
  executeSelection: () => execute('selection'),
  /** 执行整篇（逐条）。 */
  executeAll: () => execute('all'),
  /** 从光标/选区起点执行到文件尾。 */
  executeToEnd: () => execute('toEnd'),
  /** 格式化选区/整篇；失败时由调用方提示。 */
  formatDocument: (): FormatResult => formatEditor(),
  /** 切换标签前同步取走旧标签的最后光标/滚动位置。 */
  snapshotView: (): EditorViewState | null => snapshotView(),
  focus: () => editor?.focus(),
})
</script>

<template>
  <div ref="host" class="editor-host" />
</template>

<style scoped>
.editor-host {
  height: 100%;
  width: 100%;
}
</style>
