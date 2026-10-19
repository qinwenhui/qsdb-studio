// schema 感知补全：关键词 / 表名 / 列名 / 别名 / 片段（设计 §5.3）。
//
// 纯函数（不依赖 Monaco），单测直接对撞；编辑器只负责把结果映射成
// CompletionItem。数据源 = `meta_tables` 的 withSchema 缓存，**零额外请求**。
//
// 作用域：只看光标所在的**当前语句**，从 `FROM` / `JOIN` 解析表与别名：
// - `FROM sales s` 后 `s.` 只补 sales 的列；
// - `FROM` / `JOIN` / `INTO` 之后只补表名；
// - `INSERT INTO t (` 内只补 t 的列；
// - 字符串/注释里不弹补全。

import type { WireTable } from '../ipc/types'
import { currentStatement, inLiteralOrComment, maskSql } from './sqlText'

import { t, tt } from '../i18n'

export type CompletionKind = 'keyword' | 'table' | 'column' | 'partition' | 'snippet' | 'alias'

export interface CompletionEntry {
  label: string
  insertText: string
  kind: CompletionKind
  detail: string
  sortText: string
  /** true = Monaco 按 snippet 语法插入（`${1:name}` / 选项）。 */
  snippet?: boolean
}

/** QSDB 常用语句片段（补全里输入前缀即可插入）。 */
export const SQL_SNIPPETS: { label: string; detail: string; body: string }[] = [
  {
    label: 'sel',
    detail: 'SELECT 模板',
    body: 'SELECT ${1:columns}\nFROM ${2:table_name}\nWHERE ${3:condition}\nLIMIT ${4:100};',
  },
  {
    label: 'insov',
    detail: 'INSERT OVERWRITE 模板',
    body: "INSERT OVERWRITE ${1:table_name}\nSELECT\n  ${2:columns}\nFROM ${3:source}\nWHERE ${4:dt = DATE '2026-01-01'};",
  },
  {
    label: 'copyexp',
    detail: 'COPY 导出模板',
    body: "COPY (\n  ${1:SELECT * FROM table_name}\n) TO '${2:exports/name}' (FORMAT ${3|PARQUET,CSV|}, PARTITION_BY (${4:dt}));",
  },
  {
    label: 'showpart',
    detail: 'SHOW PARTITIONS',
    body: 'SHOW PARTITIONS ${1:table_name};',
  },
  {
    label: 'explain',
    detail: 'EXPLAIN',
    body: 'EXPLAIN ${1:SELECT * FROM table_name};',
  },
  {
    label: 'withcte',
    detail: 'WITH CTE 模板',
    body: 'WITH ${1:cte} AS (\n  ${2:SELECT * FROM table_name}\n)\nSELECT *\nFROM ${1:cte};',
  },
]

/** SQL 关键字（含 QSDB 的 INSERT OVERWRITE / COPY 等）。 */
export const SQL_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'INNER JOIN',
  'FULL JOIN',
  'CROSS JOIN',
  'ON',
  'AS',
  'AND',
  'OR',
  'NOT',
  'IS NULL',
  'IS NOT NULL',
  'IN',
  'BETWEEN',
  'LIKE',
  'DISTINCT',
  'UNION',
  'UNION ALL',
  'EXCEPT',
  'INTERSECT',
  'INSERT INTO',
  'INSERT OVERWRITE',
  'VALUES',
  'CREATE TABLE',
  'DROP TABLE',
  'TRUNCATE',
  'PARTITIONED BY',
  'COPY',
  'FORMAT',
  'PARQUET',
  'CSV',
  'CAST',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'DATE',
  'TIMESTAMP',
  'TIME',
  'BOOLEAN',
  'BIGINT',
  'INTEGER',
  'VARCHAR',
  'DOUBLE',
  'DECIMAL',
]

/** 不能再被当作别名/表名的子句词。 */
const ALIAS_STOP = new Set(
  [
    ...SQL_KEYWORDS.flatMap((k) => k.split(/\s+/)),
    'LEFT',
    'RIGHT',
    'INNER',
    'OUTER',
    'FULL',
    'CROSS',
    'GROUP',
    'ORDER',
    'HAVING',
    'PARTITION',
    'USING',
    'SET',
    'INTO',
    'OVERWRITE',
    'TABLE',
    'EXPLAIN',
    'SHOW',
    'DESCRIBE',
    'DESC',
    'WITH',
    'RECURSIVE',
  ].map((w) => w.toUpperCase()),
)

function shortName(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1) : name
}

/** 光标前是否刚输入 `xxx.`（表名/别名/限定名上下文）。 */
export function qualifierBefore(before: string): string | null {
  const m = /([A-Za-z_][\w.]*)\s*\.\s*$/.exec(before)
  return m ? m[1] : null
}

function resolveTable(tables: WireTable[], ref: string): WireTable | null {
  const lower = ref.toLowerCase()
  return (
    tables.find((t) => t.name.toLowerCase() === lower) ??
    tables.find((t) => shortName(t.name).toLowerCase() === lower) ??
    null
  )
}

function tableMatches(t: WireTable, lower: string): boolean {
  return (
    !lower ||
    t.name.toLowerCase().startsWith(lower) ||
    shortName(t.name).toLowerCase().startsWith(lower)
  )
}

function tableEntries(tables: WireTable[], lower: string, sortPrefix = '1_'): CompletionEntry[] {
  const out: CompletionEntry[] = []
  for (const tbl of tables) {
    if (!tableMatches(tbl, lower)) continue
    out.push({
      label: tbl.name,
      insertText: tbl.name,
      kind: 'table',
      detail: tt`表 · ${tbl.columns.length} 列`,
      sortText: `${sortPrefix}${tbl.name}`,
    })
  }
  return out
}

function columnEntries(
  table: WireTable,
  lower: string,
  owner: string,
): CompletionEntry[] {
  const out: CompletionEntry[] = []
  for (const c of table.columns) {
    if (lower && !c.name.toLowerCase().startsWith(lower)) continue
    out.push({
      label: c.name,
      insertText: c.name,
      kind: c.partition ? 'partition' : 'column',
      detail: tt`${c.typeName}${c.partition ? t(' · 分区列') : ''} · ${owner}`,
      sortText: `0_${c.partition ? '0' : '1'}_${c.name}`,
    })
  }
  return out
}

interface Source {
  ref: string
  alias: string | null
}

/**
 * 从当前语句解析 `FROM` / `JOIN` 的数据源与显式别名。
 * 不解析子查询（`FROM (…)` 没有表名，保持“不猜”）。
 */
export function statementSources(statement: string): Source[] {
  const masked = maskSql(statement)
  const out: Source[] = []
  const re = /\b(from|join)\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(masked))) {
    const rest = masked.slice(m.index + m[0].length)
    const tm = /^\s+([A-Za-z_][\w.]*)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/i.exec(rest)
    if (!tm) continue
    const ref = tm[1]
    const aliasRaw = tm[2] ?? null
    const alias =
      aliasRaw && !ALIAS_STOP.has(aliasRaw.toUpperCase()) ? aliasRaw : null
    out.push({ ref, alias })
    // 只推进到表名末尾：别让可选别名把随后的 JOIN 吃掉。
    re.lastIndex = m.index + m[0].length + (rest.length - rest.replace(/^\s+[A-Za-z_][\w.]*/, '').length)
  }
  return out
}

function scopedColumnEntries(
  scoped: { table: WireTable; alias: string | null }[],
  lower: string,
): CompletionEntry[] {
  const merged = new Map<
    string,
    { name: string; typeName: string; partition: boolean; owners: string[] }
  >()
  for (const s of scoped) {
    for (const c of s.table.columns) {
      if (lower && !c.name.toLowerCase().startsWith(lower)) continue
      const owner = s.alias ?? shortName(s.table.name)
      const cur = merged.get(c.name)
      if (cur) {
        if (!cur.owners.includes(owner)) cur.owners.push(owner)
      } else {
        merged.set(c.name, {
          name: c.name,
          typeName: c.typeName,
          partition: c.partition,
          owners: [owner],
        })
      }
    }
  }
  return [...merged.values()].map((c) => ({
    label: c.name,
    insertText: c.name,
    kind: c.partition ? 'partition' : 'column',
    detail: tt`${c.typeName}${c.partition ? t(' · 分区列') : ''} · ${c.owners.join(', ')}${
      c.owners.length > 1 ? t(' · 需限定名') : ''
    }`,
    sortText: `0_${c.partition ? '0' : '1'}_${c.name}`,
  }))
}

function aliasEntries(scoped: { table: WireTable; alias: string | null }[], lower: string): CompletionEntry[] {
  return scoped
    .filter((s) => s.alias && (!lower || s.alias.toLowerCase().startsWith(lower)))
    .map((s) => ({
      label: s.alias as string,
      insertText: s.alias as string,
      kind: 'alias' as const,
      detail: tt`别名 · ${s.table.name}`,
      sortText: `0_a_${s.alias}`,
    }))
}

/** 关键字插入文本跟随输入习惯（全小写输入 → 小写插入）。 */
function keywordText(label: string, word: string): string {
  return word && word === word.toLowerCase() ? label.toLowerCase() : label
}

/**
 * 生成补全候选。
 *
 * - `word`：当前正在输入的词（Monaco 的 `getWordUntilPosition`）；
 * - `before`：**光标前的全部文本**（用于识别字符串/注释、当前语句与
 *   `FROM`/`JOIN` 作用域；只传当前行也能工作，但看不到跨行作用域）。
 */
export function buildCompletions(
  tables: WireTable[],
  word: string,
  before: string,
): CompletionEntry[] {
  // 字符串/注释里不猜。
  if (inLiteralOrComment(before)) return []

  const lower = word.toLowerCase()
  const statement = currentStatement(before)
  // Monaco 的 `before` 以当前词结尾；单测/其他调用方可能只传“词前文本”，
  // 两种情况都兼容（不误切掉限定名的点）。
  const endsWithWord = Boolean(word) && statement.toLowerCase().endsWith(lower)
  const beforeWord = endsWithWord
    ? statement.slice(0, statement.length - word.length)
    : statement
  const maskedBefore = maskSql(beforeWord)
  const qualifier = qualifierBefore(maskedBefore)

  // 1) INSERT 列清单：只补目标表的列（PARTITION (...) 只补分区列）。
  const partitionList =
    /^\s*INSERT\s+OVERWRITE\s+([A-Za-z_][\w.]*)\s+PARTITION\s*\(([^)]*)$/i.exec(
      maskSql(statement),
    )
  if (partitionList) {
    const table = resolveTable(tables, partitionList[1])
    if (table) {
      const prefix = partitionList[2].trim()
      const lastPart = prefix.slice(prefix.lastIndexOf(',') + 1).trim()
      const lowerPart = lastPart ? lastPart.toLowerCase() : lower
      return columnEntries(table, lowerPart, table.name)
        .filter((e) => e.kind === 'partition')
        .slice(0, 300)
    }
  }
  const insertList = /^\s*INSERT\s+(?:INTO|OVERWRITE)\s+([A-Za-z_][\w.]*)\s*\(([^)]*)$/i.exec(
    maskSql(statement),
  )
  if (insertList) {
    const table = resolveTable(tables, insertList[1])
    if (table) return columnEntries(table, lower, table.name).slice(0, 300)
  }

  // 2) 限定名：别名 → 表名 → 库前缀。
  if (qualifier) {
    const sources = statementSources(statement)
    const byAlias = sources.find(
      (s) => s.alias && s.alias.toLowerCase() === qualifier.toLowerCase(),
    )
    if (byAlias) {
      const table = resolveTable(tables, byAlias.ref)
      if (table) return columnEntries(table, lower, byAlias.alias ?? table.name).slice(0, 300)
    }
    const direct = resolveTable(tables, qualifier)
    if (direct) return columnEntries(direct, lower, direct.name).slice(0, 300)
    // `库名.`：只列该库下的表（表名已带 `db.` 前缀）。
    const prefix = `${qualifier}.`
    const inDb = tables.filter((t) => t.name.toLowerCase().startsWith(prefix.toLowerCase()))
    if (inDb.length > 0) {
      return tableEntries(inDb, lower).map((e) => ({
        ...e,
        insertText: shortName(e.label),
        detail: `${e.detail} · ${qualifier}`,
        sortText: `0_${e.sortText}`,
      }))
    }
    // 解析不到：退回一般补全（不报错、不猜列）。
  }

  // 3) 刚输入 FROM / JOIN / INTO 等：只补表名。
  if (
    /(?:\bFROM|\bJOIN|\bINTO|\bUPDATE|\bTABLE|\bTRUNCATE(?:\s+TABLE)?|\bOVERWRITE|\bPARTITIONS|\b(?:DESCRIBE|DESC))\s*$/i.test(
      maskedBefore,
    )
  ) {
    return tableEntries(tables, lower).slice(0, 300)
  }

  const sources = statementSources(statement)
  const scoped = sources
    .map((s) => ({ ...s, table: resolveTable(tables, s.ref) }))
    .filter((s): s is { ref: string; alias: string | null; table: WireTable } => Boolean(s.table))

  const out: CompletionEntry[] = []
  const scopedNames = new Set<string>()

  if (scoped.length > 0) {
    const cols = scopedColumnEntries(scoped, lower)
    for (const c of cols) scopedNames.add(c.label)
    out.push(...cols, ...aliasEntries(scoped, lower))
  }

  // 表名：有作用域时排在列之后；FROM/JOIN 上下文已在上面单独处理。
  out.push(...tableEntries(tables, lower, scoped.length > 0 ? '2_' : '1_'))

  // 其他表的列（无作用域时是主要建议；有作用域时补齐，避免用户改 FROM 时无提示）。
  const seenColumns = new Set<string>(scopedNames)
  const scopeTables = new Set(scoped.map((s) => s.table.name))
  for (const tbl of tables) {
    if (scopeTables.has(tbl.name) && scoped.length > 0) continue
    for (const c of tbl.columns) {
      if (lower && !c.name.toLowerCase().startsWith(lower)) continue
      if (seenColumns.has(c.name)) continue
      seenColumns.add(c.name)
      out.push({
        label: c.name,
        insertText: c.name,
        kind: c.partition ? 'partition' : 'column',
        detail: tt`${c.typeName}${c.partition ? t(' · 分区列') : ''} · ${tbl.name}`,
        sortText: `2_${c.name}`,
      })
    }
  }

  if (lower) {
    for (const s of SQL_SNIPPETS) {
      if (!s.label.startsWith(lower)) continue
      out.push({
        label: s.label,
        insertText: s.body,
        kind: 'snippet',
        detail: t(s.detail),
        sortText: `3_${s.label}`,
        snippet: true,
      })
    }
  }

  for (const kw of SQL_KEYWORDS) {
    if (lower && !kw.toLowerCase().startsWith(lower)) continue
    out.push({
      label: kw,
      insertText: keywordText(kw, word),
      kind: 'keyword',
      detail: t('关键字'),
      sortText: `4_${kw}`,
    })
  }

  out.sort((a, b) => a.sortText.localeCompare(b.sortText))
  return out.slice(0, 300)
}
