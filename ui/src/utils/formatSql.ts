// SQL 格式化：QSDB 语法是 PostgreSQL 的近亲（COPY / INSERT OVERWRITE /
// SHOW PARTITIONS 都是额外语句），用 sql-formatter 的 postgresql 方言。
// 只改空白与关键字大小写，不引号化标识符（QSDB 解析器不接受双引号标识符）。

import { format } from 'sql-formatter'

/** 格式化 SQL；空输入原样返回。格式化失败由调用方显式提示，不静默吞掉。 */
export function formatSql(sql: string): string {
  if (!sql.trim()) return sql
  return format(sql, {
    language: 'postgresql',
    keywordCase: 'upper',
    tabWidth: 2,
    useTabs: false,
    linesBetweenQueries: 2,
  })
}
