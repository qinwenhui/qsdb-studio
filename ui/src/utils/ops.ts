// 会话 / 运行查询面板的排序与过滤（纯函数，便于单测）。
//
// 只做客户端展示排序，不改服务端语义；同分时用稳定键（id / 用户）兜底，
// 避免每 2s 轮询刷新时行来回跳。

import type { StoredQuery, StoredSession } from '../ipc/types'

export type QuerySort = 'elapsed' | 'memory' | 'session'
export type SessionSort = 'running' | 'idle' | 'user'

export function filterQueriesBySession<T extends StoredQuery>(
  queries: T[],
  sessionId: string | null,
): T[] {
  if (!sessionId) return queries
  return queries.filter((q) => q.sessionId === sessionId)
}

export function sortQueries<T extends StoredQuery>(queries: T[], sort: QuerySort): T[] {
  const out = [...queries]
  out.sort((a, b) => {
    switch (sort) {
      case 'memory':
        return b.memoryBytes - a.memoryBytes || a.id.localeCompare(b.id)
      case 'session':
        return (
          (a.sessionId ?? '').localeCompare(b.sessionId ?? '') ||
          b.elapsedMs - a.elapsedMs ||
          a.id.localeCompare(b.id)
        )
      case 'elapsed':
      default:
        return b.elapsedMs - a.elapsedMs || a.id.localeCompare(b.id)
    }
  })
  return out
}

export function sortSessions(sessions: StoredSession[], sort: SessionSort): StoredSession[] {
  const out = [...sessions]
  out.sort((a, b) => {
    switch (sort) {
      case 'idle':
        return b.idleMs - a.idleMs || a.id.localeCompare(b.id)
      case 'user':
        return a.user.localeCompare(b.user) || b.idleMs - a.idleMs || a.id.localeCompare(b.id)
      case 'running':
      default:
        return (
          b.runningQueries.length - a.runningQueries.length ||
          b.queriesTotal - a.queriesTotal ||
          a.id.localeCompare(b.id)
        )
    }
  })
  return out
}
