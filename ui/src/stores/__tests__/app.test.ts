import { afterEach, describe, expect, it } from 'vitest'
import type { SessionView } from '../../ipc/types'
import { appState, isConnected, type ConnState } from '../app'

function conn(id: string, db: string, user: string): ConnState {
  const session: SessionView = {
    sessionId: `s-${id}`,
    user,
    role: 'reader',
    grants: {},
    defaultDb: db,
  }
  return {
    info: {
      profileId: id,
      profileName: `conn-${id}`,
      url: 'http://127.0.0.1:9430',
      version: '0.1.0',
      auth: { kind: 'none' },
    },
    session,
    databases: [{ name: db, readOnly: true }],
    tables: [],
    metaLoading: false,
    defaultDb: db,
  }
}

afterEach(() => {
  appState.connections = {}
  appState.activeProfileId = null
  appState.connectingIds = {}
})

describe('多连接注册表', () => {
  it('keeps each connection state isolated', () => {
    appState.connections = { a: conn('a', 'db_a', 'alice'), b: conn('b', 'db_b', 'bob') }
    appState.activeProfileId = 'a'
    expect(appState.connection?.profileName).toBe('conn-a')
    expect(appState.session?.user).toBe('alice')
    expect(appState.databases.map((d) => d.name)).toEqual(['db_a'])
    expect(appState.defaultDb).toBe('db_a')

    appState.activeProfileId = 'b'
    expect(appState.connection?.profileName).toBe('conn-b')
    expect(appState.session?.user).toBe('bob')
    expect(appState.defaultDb).toBe('db_b')
    expect(isConnected('a')).toBe(true)
    expect(isConnected('missing')).toBe(false)
  })

  it('falls back to empty/neutral values when the active profile is unbound', () => {
    appState.connections = { a: conn('a', 'db_a', 'alice') }
    appState.activeProfileId = null
    expect(appState.connection).toBeNull()
    expect(appState.session).toBeNull()
    expect(appState.databases).toEqual([])
    expect(appState.defaultDb).toBe('default')
    expect(appState.connectedIds).toEqual(['a'])
  })

  it('tracks per-profile connecting flags', () => {
    appState.connections = { a: conn('a', 'db_a', 'alice'), b: conn('b', 'db_b', 'bob') }
    appState.connectingIds = { b: true }
    appState.activeProfileId = 'a'
    expect(appState.connecting).toBe(false)
    appState.activeProfileId = 'b'
    expect(appState.connecting).toBe(true)
  })
})
