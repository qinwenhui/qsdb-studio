import { describe, expect, it } from 'vitest'
import type { StoredQuery, StoredSession } from '../../ipc/types'
import { filterQueriesBySession, sortQueries, sortSessions } from '../ops'

function q(id: string, elapsedMs: number, memoryBytes: number, sessionId: string | null): StoredQuery {
  return { id, sql: `SELECT ${id}`, elapsedMs, memoryBytes, cancelled: false, sessionId }
}

function s(id: string, user: string, idleMs: number, running: number, total = 0): StoredSession {
  return {
    id,
    user,
    role: 'admin',
    client: 'test',
    createdAtMs: 0,
    lastActiveMs: 0,
    idleMs,
    defaultDb: 'default',
    runningQueries: Array.from({ length: running }, (_, i) => `${id}-q${i}`),
    queriesTotal: total,
    rowsWritten: 0,
  }
}

describe('ops sorting', () => {
  const queries = [q('b', 10, 500, 's1'), q('a', 30, 100, 's2'), q('c', 10, 900, 's1')]

  it('sorts queries by elapsed, memory or session without mutating input', () => {
    expect(sortQueries(queries, 'elapsed').map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(sortQueries(queries, 'memory').map((x) => x.id)).toEqual(['c', 'b', 'a'])
    expect(sortQueries(queries, 'session').map((x) => x.id)).toEqual(['b', 'c', 'a'])
    expect(queries.map((x) => x.id)).toEqual(['b', 'a', 'c'])
  })

  it('filters queries by session id', () => {
    expect(filterQueriesBySession(queries, null)).toHaveLength(3)
    expect(filterQueriesBySession(queries, 's1').map((x) => x.id)).toEqual(['b', 'c'])
    expect(filterQueriesBySession(queries, 'missing')).toEqual([])
  })

  it('sorts sessions by running count, idle time or user', () => {
    const sessions = [s('1', 'bob', 10, 0), s('2', 'alice', 99, 2), s('3', 'carol', 50, 2, 7)]
    expect(sortSessions(sessions, 'running').map((x) => x.id)).toEqual(['3', '2', '1'])
    expect(sortSessions(sessions, 'idle').map((x) => x.id)).toEqual(['2', '3', '1'])
    expect(sortSessions(sessions, 'user').map((x) => x.id)).toEqual(['2', '1', '3'])
    expect(sessions.map((x) => x.id)).toEqual(['1', '2', '3'])
  })
})
