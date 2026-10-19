// 分区目录名 → 预览 SQL / INSERT OVERWRITE 模板。
//
// 目录名编码与内核 `partition::encode_partition_value` 对齐：
// `%`→`%25`、`/`→`%2F`、`=`→`%3D`、控制字符→`%XX`；其余字节原样。

import type { WireColumnInfo, WireTable } from '../ipc/types'

import { t, tt } from '../i18n'

export interface PartitionKey {
  column: string
  value: string
}

export interface PartitionOp {
  sql: string
  /** 生成失败的原因（显式报错，不猜）。 */
  error?: string
}

/** 反转义分区目录值。 */
export function decodePartitionValue(enc: string): string {
  return enc.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) =>
    String.fromCharCode(Number.parseInt(h, 16)),
  )
}

/**
 * 解析目录名 `k1=v1/k2=v2`。
 * 返回 `null` = 形态不是 hive 分区目录。
 */
export function parsePartitionName(name: string): PartitionKey[] | null {
  const parts = name.split('/').filter((p) => p.length > 0)
  if (parts.length === 0) return null
  const out: PartitionKey[] = []
  for (const p of parts) {
    const eq = p.indexOf('=')
    if (eq <= 0) return null
    out.push({
      column: p.slice(0, eq),
      value: decodePartitionValue(p.slice(eq + 1)),
    })
  }
  return out
}

/** 标识符：QSDB 的列名约束是 `[A-Za-z_][A-Za-z0-9_]*`，直接用裸名；
 *  服务端解析器不把双引号当标识符（实测会按 DATE 字面量报错）。 */
function ident(name: string): string {
  return name
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** 按分区列类型生成 SQL 字面量。 */
export function partitionLiteral(column: WireColumnInfo, value: string): string {
  const t = column.typeName.toUpperCase()
  if (t.includes('TIMESTAMP')) {
    return `TIMESTAMP ${quoteString(value)}`
  }
  if (t.includes('DATE')) {
    return `DATE ${quoteString(value)}`
  }
  if (t.includes('BOOL')) {
    const v = value.toLowerCase()
    if (v === 'true' || v === '1') return 'TRUE'
    if (v === 'false' || v === '0') return 'FALSE'
    throw new Error(tt`BOOLEAN 分区值 ${JSON.stringify(value)} 不是 true/false/1/0`)
  }
  if (/(BIGINT|INTEGER|SMALLINT|TINYINT|INT|DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC)/.test(t)) {
    if (!/^-?\d+(\.\d+)?$/.test(value)) {
      throw new Error(tt`${column.typeName} 分区值 ${JSON.stringify(value)} 不是数字`)
    }
    return value
  }
  return quoteString(value)
}

function partitionColumns(table: WireTable): WireColumnInfo[] {
  return table.columns.filter((c) => c.partition)
}

/** 生成 `col = literal AND …` 谓词。 */
export function partitionPredicate(
  table: WireTable,
  keys: PartitionKey[],
): PartitionOp {
  const cols = partitionColumns(table)
  if (cols.length === 0) {
    return { sql: '', error: t('该表没有分区列') }
  }
  const predicates: string[] = []
  for (const k of keys) {
    const col = cols.find((c) => c.name.toLowerCase() === k.column.toLowerCase())
    if (!col) {
      return {
        sql: '',
        error: tt`分区目录里的列 ${JSON.stringify(k.column)} 不在表的 schema 中`,
      }
    }
    try {
      predicates.push(`${ident(col.name)} = ${partitionLiteral(col, k.value)}`)
    } catch (e) {
      return { sql: '', error: e instanceof Error ? e.message : String(e) }
    }
  }
  return { sql: predicates.join(' AND ') }
}

/** 分区预览：谓词只落在分区列上，服务端可做分区裁剪。 */
export function previewSql(table: WireTable, partitionName: string, limit = 500): PartitionOp {
  const keys = parsePartitionName(partitionName)
  if (!keys) return { sql: '', error: tt`无法解析分区目录名 ${JSON.stringify(partitionName)}` }
  const pred = partitionPredicate(table, keys)
  if (pred.error) return pred
  return {
    sql: `SELECT * FROM ${table.name} WHERE ${pred.sql} LIMIT ${Math.max(1, limit)}`,
  }
}

/**
 * INSERT OVERWRITE 模板：
 * - 预填分区列字面量与当前 generation（注释）；
 * - QSDB 的 SQL 语法**没有** CAS 参数：需要 expected_generation 请走批量写 API；
 * - FROM 用表自身做占位，用户替换成真实源。
 */
export function overwriteTemplate(
  table: WireTable,
  partitionName: string,
  generation: number,
): PartitionOp {
  const keys = parsePartitionName(partitionName)
  if (!keys) return { sql: '', error: tt`无法解析分区目录名 ${JSON.stringify(partitionName)}` }
  const pred = partitionPredicate(table, keys)
  if (pred.error) return pred

  const nonPartition = table.columns.filter((c) => !c.partition)
  const parts = partitionColumns(table)
  const selectCols = nonPartition.map((c) => ident(c.name))
  for (const k of keys) {
    const col = parts.find((c) => c.name.toLowerCase() === k.column.toLowerCase())
    if (!col) return { sql: '', error: tt`分区目录里的列 ${k.column} 不在表的 schema 中` }
    let lit: string
    try {
      lit = partitionLiteral(col, k.value)
    } catch (e) {
      return { sql: '', error: e instanceof Error ? e.message : String(e) }
    }
    selectCols.push(`${lit} AS ${ident(col.name)}`)
  }
  if (nonPartition.length === 0) {
    return { sql: '', error: t('分区表至少需要一个非分区列（内核 DDL 约束）') }
  }

  const sql = `-- 分区 ${partitionName} · 当前 generation ${generation}
-- INSERT OVERWRITE = 分区级原子替换（谓词命中的分区整体换掉，其余不动）
-- 注意：SQL 语法不带 CAS generation；需要乐观并发保护请用批量写接口的 expected_generation。
-- 把 FROM 换成你的源（read_parquet / 另一张表 / 子查询）。
INSERT OVERWRITE ${table.name}
SELECT
  ${selectCols.join(',\n  ')}
FROM ${table.name}
WHERE ${pred.sql};`
  return { sql }
}
