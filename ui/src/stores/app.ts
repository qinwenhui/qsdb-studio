// 连接档案 / 多连接注册表 / 元数据树的应用状态。
//
// 多标签多连接（M3）：每个连接档案可以在同一时刻保持打开（`connections`），
// 编辑器标签各自绑定一个 `profileId`；下面这些 getter 始终指向**当前激活
// 标签**所用的连接，侧栏元数据树、M2 面板因此天然跟着活动标签走。
// 每个连接各自拥有 session / 元数据缓存，互不覆盖。

import { computed, reactive } from 'vue'
import { t } from '../i18n'
import * as ipc from '../ipc'
import type {
  ConnInfo,
  ProfileInput,
  ProfileView,
  QueryOptionsInput,
  SessionView,
  StudioError,
  WireDb,
  WireTable,
} from '../ipc/types'

export interface ConnState {
  info: ConnInfo
  session: SessionView | null
  databases: WireDb[]
  tables: WireTable[]
  metaLoading: boolean
  defaultDb: string
}

interface AppState {
  profiles: ProfileView[]
  /** 已打开的连接（profileId → 状态）。同一档案同一时刻至多一条连接。 */
  connections: Record<string, ConnState>
  /** 当前激活编辑器标签绑定的档案 id（由 workspace store 同步）。 */
  activeProfileId: string | null
  connectingIds: Record<string, boolean>
  readonly connState: ConnState | null
  readonly connection: ConnInfo | null
  readonly session: SessionView | null
  readonly databases: WireDb[]
  readonly tables: WireTable[]
  readonly metaLoading: boolean
  readonly defaultDb: string
  readonly connecting: boolean
  readonly connectedIds: string[]
}

const initial: AppState = {
  profiles: [],
  connections: {},
  activeProfileId: null,
  connectingIds: {},
  get connState() {
    const id = this.activeProfileId
    return id ? (this.connections[id] ?? null) : null
  },
  get connection() {
    return this.connState?.info ?? null
  },
  get session() {
    return this.connState?.session ?? null
  },
  get databases() {
    return this.connState?.databases ?? []
  },
  get tables() {
    return this.connState?.tables ?? []
  },
  get metaLoading() {
    return this.connState?.metaLoading ?? false
  },
  get defaultDb() {
    return this.connState?.defaultDb ?? 'default'
  },
  get connecting() {
    const id = this.activeProfileId
    return id ? Boolean(this.connectingIds[id]) : false
  },
  get connectedIds() {
    return Object.keys(this.connections)
  },
}

export const appState: AppState = reactive(initial)

export const activeProfile = computed(
  () => appState.profiles.find((p) => p.id === appState.activeProfileId) ?? null,
)

export function profileOf(id: string | null | undefined): ProfileView | null {
  if (!id) return null
  return appState.profiles.find((p) => p.id === id) ?? null
}

/** 档案是否已打开连接。 */
export function isConnected(profileId: string | null | undefined): boolean {
  return Boolean(profileId && appState.connections[profileId])
}

export function existingConn(profileId: string | null | undefined): ConnState | null {
  if (!profileId) return null
  return appState.connections[profileId] ?? null
}

export async function refreshProfiles() {
  // 只刷新列表；活动连接由 workspace 的标签绑定决定（见 ensureBindings）。
  appState.profiles = await ipc.profilesList()
}

export async function saveProfile(input: ProfileInput): Promise<ProfileView> {
  const view = await ipc.profileSave(input)
  await refreshProfiles()
  return view
}

export async function deleteProfile(id: string): Promise<void> {
  if (isConnected(id)) await disconnect(id)
  await ipc.profileDelete(id)
  await refreshProfiles()
}

/**
 * 建连 + 登录 + 读元数据。**不关闭**其他连接（这正是多连接）。
 *
 * 同一个档案已有连接时直接返回现有握手信息；不会重建（重建会丢会话）。
 * 登录失败不销毁连接：版本/健康仍可用，错误显式抛给调用方。
 */
export async function connectProfile(profileId: string): Promise<ConnInfo> {
  const existing = existingConn(profileId)
  if (existing) return existing.info

  appState.connectingIds[profileId] = true
  try {
    const info = await ipc.connCreate(profileId)
    appState.connections[profileId] = {
      info,
      session: null,
      databases: [],
      tables: [],
      metaLoading: false,
      defaultDb: profileOf(profileId)?.defaultDatabase ?? 'default',
    }
    // Must mutate the **reactive proxy**, not the raw object we just created:
    // the login result below has to trigger the top/status bar immediately.
    const state = appState.connections[profileId]!

    let failure: unknown = null
    if (info.auth.kind === 'basic') {
      try {
        state.session = await ipc.connLogin(profileId, info.auth.user, null)
      } catch (e) {
        // 连接成功但登录失败：保留连接（版本/健康仍可用），错误显式交给调用方。
        failure = e
      }
    }
    state.defaultDb =
      state.session?.defaultDb ?? profileOf(profileId)?.defaultDatabase ?? 'default'
    try {
      await refreshMeta(profileId)
    } catch (e) {
      if (!failure) failure = e
    }
    // 登录/元数据失败时保留已建立的连接（版本/健康仍可用），错误向上抛。
    if (failure) throw failure
    return info
  } finally {
    delete appState.connectingIds[profileId]
  }
}

/** 重登当前标签的连接（或显式指定的连接）。 */
export async function loginAgain(profileId: string | null = appState.activeProfileId): Promise<void> {
  const state = existingConn(profileId)
  if (!state) throw new Error(t('尚未连接'))
  if (state.info.auth.kind !== 'basic') return
  state.session = await ipc.connLogin(
    state.info.profileId,
    state.info.auth.user,
    null,
  )
  state.defaultDb = state.session.defaultDb
}

/** 关闭一条连接；不传则关闭当前标签使用的连接。 */
export async function disconnect(profileId: string | null = appState.activeProfileId): Promise<void> {
  if (!profileId) return
  const state = appState.connections[profileId]
  delete appState.connections[profileId]
  delete appState.connectingIds[profileId]
  // **不**清 activeProfileId：标签仍绑定这条档案（显示“未连接”，可一键重连）。
  if (!state) return
  try {
    await ipc.connClose(profileId)
  } catch {
    // 本地已断开；服务端会话会在空闲回收时释放。
  }
}

/** 刷新某条连接的库/表/列（不传则刷新当前标签的连接）。 */
export async function refreshMeta(profileId: string | null = appState.activeProfileId): Promise<void> {
  const state = existingConn(profileId)
  if (!state) return
  const id = state.info.profileId
  state.metaLoading = true
  try {
    const [databases, tables] = await Promise.all([
      ipc.metaDatabases(id),
      ipc.metaTables(id),
    ])
    // 刷新期间连接可能已被关闭：丢弃过期响应。
    if (appState.connections[id] !== state) return
    state.databases = databases
    state.tables = tables
  } finally {
    if (appState.connections[id] === state) state.metaLoading = false
  }
}

/** 切换当前标签连接的会话默认库。 */
export async function useDatabase(database: string): Promise<void> {
  const state = appState.connState
  if (!state) throw new Error(t('尚未连接'))
  await ipc.metaUse(state.info.profileId, database)
  if (state.session) state.session.defaultDb = database
  state.defaultDb = database
}

/** 查询选项的基座（参数由调用方补）。 */
export function baseQueryOptions(): QueryOptionsInput {
  return { timeoutMs: null, params: [] }
}

export function toStudioError(e: unknown): StudioError {
  if (ipc.isIpcError(e)) return e.info
  return {
    kind: 'internal',
    message: e instanceof Error ? e.message : String(e),
    retriable: false,
  }
}
