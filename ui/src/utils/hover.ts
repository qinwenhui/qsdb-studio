// Hover 内容：表 / 列的 schema 信息（数据源 = 已缓存的 meta_tables）。

import type { WireTable } from '../ipc/types'

import { t, tt } from '../i18n'

function shortName(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1) : name
}

/**
 * 返回 hover 的 Markdown；没有匹配的 schema 对象时返回 null（不弹空 hover）。
 * 同名列可能来自多张表，全部列出而不是猜一张。
 */
export function hoverMarkdown(tables: WireTable[], word: string): string | null {
  const w = word.trim().toLowerCase()
  if (!w) return null
  const blocks: string[] = []

  for (const tbl of tables) {
    if (tbl.name.toLowerCase() === w || shortName(tbl.name).toLowerCase() === w) {
      const cols = tbl.columns
        .slice(0, 20)
        .map(
          (c) =>
            `- \`${c.name}\` ${c.typeName}${c.partition ? t(' · 分区列') : ''}${
              c.nullable ? '' : ' · NOT NULL'
            }`,
        )
        .join('\n')
      const more = tbl.columns.length > 20 ? tt`\n- …（共 ${tbl.columns.length} 列）` : ''
      blocks.push(tt`**表 ${tbl.name}** · ${tbl.columns.length} 列\n\n${cols}${more}`)
    }
    for (const c of tbl.columns) {
      if (c.name.toLowerCase() !== w) continue
      const partition = c.partition ? t(' · 分区列') : ''
      const nullable = c.nullable ? t(' · 允许 NULL') : ' · NOT NULL'
      blocks.push(
        tt`**${c.name}** · \`${c.typeName}\`${partition}${nullable}\n\n来自表 \`${tbl.name}\``,
      )
    }
  }

  return blocks.length > 0 ? blocks.slice(0, 8).join('\n\n---\n\n') : null
}
