// 执行前护栏（SQL 工作台 / 历史重跑 / 收藏重跑共用）。
//
// 只读连接拦截写语句；危险语句弹确认。这里不直接弹 toast：调用方决定
// 如何呈现（编辑器里是 error message，抽屉里也复用同一套文案）。

import { appState } from './app'
import { colorForProfile } from './connectionColors'
import { confirmDangerous } from './safety'
import { analyzeSql, dangerTypingText } from '../utils/sqlRisk'

import { tt } from '../i18n'

export interface GuardItem {
  sql: string
  /** 语句起始行（1 基，用于提示位置）。 */
  line: number
}

export interface GuardOutcome {
  ok: boolean
  /** 用户在危险确认弹窗里点了取消（不需要再报错）。 */
  cancelled?: boolean
  /** 被拦截/无法执行的原因（只读连接等）。 */
  reason?: string
}

export async function guardSqlForExecution(
  profileId: string,
  items: GuardItem[],
): Promise<GuardOutcome> {
  const profile = appState.profiles.find((p) => p.id === profileId) ?? null
  const analyzed = items.map((it) => ({ ...it, analysis: analyzeSql(it.sql) }))

  if (profile?.readOnly) {
    const blocked = analyzed.filter((it) => !it.analysis.readOnly)
    if (blocked.length > 0) {
      const detail = blocked
        .slice(0, 5)
        .map(
          (it) =>
            tt`第 ${it.line} 行 ${it.analysis.verb}${
              it.analysis.table ? ` ${it.analysis.table}` : ''
            }`,
        )
        .join('；')
      const more = blocked.length > 5 ? tt` 等 ${blocked.length} 条` : ''
      return {
        ok: false,
        reason:
          tt`连接「${profile.name}」标记为只读：已阻止 ${blocked.length} 条可能写入的语句` +
          tt`（${detail}${more}）。只读连接允许 SELECT / SHOW / EXPLAIN 等读语句。`,
      }
    }
  }

  const dangerous = analyzed.filter((it) => it.analysis.dangerous)
  if (dangerous.length === 0) return { ok: true }

  const confirmed = await confirmDangerous({
    items: dangerous,
    profileName: profile?.name ?? profileId,
    profileColor: colorForProfile(profileId),
    typingText: dangerTypingText(dangerous.map((it) => it.analysis)),
  })
  return confirmed ? { ok: true } : { ok: false, cancelled: true }
}
