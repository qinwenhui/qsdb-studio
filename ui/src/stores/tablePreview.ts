// “打开表查询”共用的动作：元数据树双击/回车、命令面板按表名跳转、拖拽表。
// 只是把现有 newEditorTab / runSql 组合起来，不引入第二条执行路径。
//
// 生成的 SQL **不写 LIMIT**：执行层会给无 LIMIT 的 bulk 查询自动分页
// （默认 500 行/页），结果面板可继续翻页；流式开关仍由用户显式选择。

import type { WireTable } from '../ipc/types'
import { appState, baseQueryOptions } from './app'
import { runSql } from './query'
import { activeEditor, newEditorTab } from './workspace'

import { t, tt } from '../i18n'

export interface PreviewOutcome {
  editorKey: string
  /** 连接已打开并已发起查询；false = 只填了 SQL。 */
  executed: boolean
}

/**
 * 解析表查询的目标库：
 * - `db.table` 的 db 确实是已挂载库 → 用这个库（限定名与 database 一致）；
 * - 否则沿用当前标签显式选中的库；
 * - 都没有 → null（跟随连接默认）。
 */
function databaseForTable(name: string): string | null {
  const dot = name.indexOf('.')
  const prefix = dot > 0 ? name.slice(0, dot) : ''
  if (prefix && appState.databases.some((d) => d.name === prefix)) return prefix
  return activeEditor.value?.database ?? null
}

function openGeneratedQuery(
  sql: string,
  title: string,
  paginate: boolean,
  database: string | null,
): PreviewOutcome {
  const pid = activeEditor.value?.profileId ?? appState.activeProfileId
  const tab = newEditorTab(pid, sql)
  tab.database = database
  const executed = Boolean(pid && appState.connections[pid])
  if (pid && executed) {
    const opts = { ...baseQueryOptions(), ...(database ? { database } : {}) }
    void runSql(tab.key, pid, sql, opts, {
      stream: false,
      title,
      paginate,
    })
  }
  return { editorKey: tab.key, executed }
}

/**
 * 在**新标签**里生成 `SELECT * FROM name` 并执行（连接未打开时只填 SQL）。
 * `table` 只用于取短名生成标题；拖拽场景允许只有表名字符串。
 */
export function openTableQuery(
  name: string,
  table?: WireTable,
  titlePrefix = t('查询'),
): PreviewOutcome | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const short = (table?.name ?? trimmed).split('.').pop() ?? trimmed
  return openGeneratedQuery(
    `SELECT * FROM ${trimmed}`,
    `${titlePrefix} ${short}`,
    true,
    databaseForTable(trimmed),
  )
}

/** 元数据树双击/命令面板：新标签 + 执行（自动分页）。 */
export function openTablePreview(table: WireTable): PreviewOutcome | null {
  return openTableQuery(table.name, table, t('预览'))
}

/**
 * 查询表行数（精确 count(*)）。单行结果，不套自动分页。
 * 服务端当前没有暴露“表数据字节数”，所以只提供行数。
 */
export function openTableCount(table: WireTable): PreviewOutcome | null {
  const name = table.name.trim()
  if (!name) return null
  const short = name.split('.').pop() ?? name
  return openGeneratedQuery(
    `SELECT count(*) AS row_count FROM ${name}`,
    tt`行数 ${short}`,
    false,
    databaseForTable(name),
  )
}
