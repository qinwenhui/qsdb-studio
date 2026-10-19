// 结果标签页 / 流式接收 / 护栏三选一。
//
// 关键约束：
// - 大结果不在前端留全量：流式只缓存 spool（Rust）里的**预览尾部**，网格
//   滚动时按页取（ResultGrid 负责页缓存）。
// - 每个结果页记录自己的 `editorKey`（所属编辑器标签）与 `profileId`
//   （执行时的连接）：切换/关闭编辑器标签、断开连接都不会串结果。
// - 所有异步完成都带 `executionSeq` 守卫：重跑/关闭后旧响应不会覆盖新状态。

import { Channel } from '@tauri-apps/api/core'
import { reactive } from 'vue'
import * as ipc from '../ipc'
import type {
  ParamInput,
  QueryOptionsInput,
  QueryResult,
  SqlStatement,
  StreamEvent,
  StudioError,
  WireColumn,
  WireValue,
} from '../ipc/types'
import { buildFilteredSql, type ColumnFilter } from '../utils/filters'
import {
  DEFAULT_PAGE_SIZE,
  canCountTotal,
  pageSql,
  planPagination,
  totalCountSql,
} from '../utils/pagination'
import { wrapWithLimit } from '../utils/sql'
import { appState, profileOf, toStudioError } from './app'
import { notifyQueryFinished } from './notifications'
import { clearErrorMarker, markError } from './ui'

import { t, tt } from '../i18n'

export interface StreamState {
  streamId: string
  columns: WireColumn[]
  totalRows: number
  done: boolean
  /** 客户端接收总耗时（ms，含网络与落盘）。 */
  elapsedMs: number | null
  /** 服务端执行耗时（ms；旧服务端未提供时 null）。 */
  serverElapsedMs: number | null
  /** 最近一块的尾部预览（完整数据在 Rust spool 里）。 */
  preview: { start: number; rows: WireValue[][] } | null
  error: StudioError | null
  stopping: boolean
}

/** 自动分页元数据：原 SQL 未写 LIMIT 时，结果按页取。 */
export interface PageState {
  /** 用户原始 SQL（不含自动补的 LIMIT/OFFSET）。 */
  baseSql: string
  /** 1 基页码。 */
  page: number
  pageSize: number
}

export interface ResultTab {
  key: string
  /** 所属编辑器标签（多标签隔离）。 */
  editorKey: string
  /** 执行时绑定的连接档案。 */
  profileId: string
  profileName: string
  /** 执行时显式指定的目标库（null = 跟随连接默认）。 */
  database: string | null
  /** 执行时的身份徽章（`user @ db`；无会话时为连接名）。 */
  identity: string
  title: string
  sql: string
  opts: QueryOptionsInput
  status: 'running' | 'ok' | 'error' | 'streaming'
  startedAt: number
  result: QueryResult | null
  stream: StreamState | null
  error: StudioError | null
  warnings: string[]
  /** 用户显式 maxRows=0（部署方护栏被本次请求豁免）。 */
  override: boolean
  channelNote: string | null
  errorLine: number | null
  executionSeq: number
  /** bulk 执行前生成的 queryId（运行中取消用；结束后清空）。 */
  requestedQueryId: string | null
  /** 已发出取消请求（等待服务端收尾）。 */
  cancelRequested: boolean
  /** 自动分页（默认 500 行/页）；null = 原样执行（显式 LIMIT / 写语句 / 流式）。 */
  pagination: PageState | null
  /** 本页满页 → 可能有下一页。只知道“可能”，不额外跑 count。 */
  hasNextPage: boolean
  /** 服务端字段筛选（AND 组合）；在分页包装外层执行，覆盖全量查询结果。 */
  filters: ColumnFilter[]
  /** 最近一次成功结果的列（翻页/筛选 loading 时筛选表单仍可用）。 */
  lastColumns: WireColumn[]
  /**
   * 本次查询（含服务端字段筛选）的总行数；十进制字符串，避免 i64 超出
   * JS 安全整数时丢精度。null = 尚未统计。
   */
  totalCount: string | null
  /** “结果总行数”标签状态：空闲 / 统计中 / 失败。 */
  totalCountState: 'idle' | 'loading' | 'error'
  totalCountError: string | null
  /** count 请求序号：筛选变化/关闭结果页后丢弃迟到响应（翻页不回退）。 */
  totalCountSeq: number
}

export interface GuardrailState {
  visible: boolean
  tabKey: string | null
  editorKey: string
  profileId: string
  error: StudioError | null
  sql: string
  opts: QueryOptionsInput
}

export const queryState = reactive({
  tabs: [] as ResultTab[],
  /** 每个编辑器标签各自记住激活的结果页。 */
  activeKeys: {} as Record<string, string>,
  guardrail: {
    visible: false,
    tabKey: null,
    editorKey: '',
    profileId: '',
    error: null,
    sql: '',
    opts: {},
  } as GuardrailState,
  batchRunning: false,
})

/** 某个编辑器标签下的结果页（执行顺序）。 */
export function resultsOf(editorKey: string): ResultTab[] {
  if (!editorKey) return []
  return queryState.tabs.filter((t) => t.editorKey === editorKey)
}

/** 某个编辑器标签当前激活的结果页。 */
export function activeResultOf(editorKey: string): ResultTab | null {
  const list = resultsOf(editorKey)
  return list.find((t) => t.key === queryState.activeKeys[editorKey]) ?? list[0] ?? null
}

let seq = 0

function nextKey(): string {
  seq += 1
  return `res-${Date.now()}-${seq}`
}

function normalizeOpts(opts: QueryOptionsInput): QueryOptionsInput {
  return { ...opts, params: opts.params ?? [] }
}

let bulkSeq = 0

/** bulk 查询的客户端 queryId（服务端冲突会回退，以响应回显为准）。 */
function nextBulkQueryId(): string {
  bulkSeq += 1
  return `studio-bulk-${Date.now()}-${bulkSeq}`
}

function findTab(key: string): ResultTab | null {
  return queryState.tabs.find((t) => t.key === key) ?? null
}

/** 执行时快照身份徽章（之后切库/断连不影响历史结果页的归属展示）。 */
function identityOf(profileId: string): string {
  const state = appState.connections[profileId]
  if (state?.session) return `${state.session.user} @ ${state.session.defaultDb}`
  return profileOf(profileId)?.name ?? profileId
}

function missingConnection(tab: ResultTab): StudioError | null {
  if (appState.connections[tab.profileId]) return null
  return {
    kind: 'usage',
    message: tt`连接「${tab.profileName}」已断开：请重新连接，或把该标签换到其他连接。`,
    retriable: false,
  }
}

function createTab(
  editorKey: string,
  profileId: string,
  title: string,
  sql: string,
  opts: QueryOptionsInput,
  pagination: PageState | null,
): ResultTab {
  // 必须是 reactive：Channel 回调与异步完成都通过这个引用改状态。
  const tab = reactive<ResultTab>({
    key: nextKey(),
    editorKey,
    profileId,
    profileName: profileOf(profileId)?.name ?? profileId,
    database: opts.database ?? null,
    identity: identityOf(profileId),
    title,
    sql,
    opts: normalizeOpts(opts),
    status: 'running',
    startedAt: Date.now(),
    result: null,
    stream: null,
    error: null,
    warnings: [],
    override: opts.maxRows === 0,
    channelNote: null,
    errorLine: null,
    executionSeq: 0,
    requestedQueryId: null,
    cancelRequested: false,
    pagination,
    hasNextPage: false,
    filters: [],
    lastColumns: [],
    totalCount: null,
    totalCountState: 'idle',
    totalCountError: null,
    totalCountSeq: 0,
  })
  queryState.tabs.push(tab)
  queryState.activeKeys[editorKey] = tab.key
  return tab
}

/** 让旧的总行数/在途 count 响应失效（筛选变化、重跑、关闭结果页）。 */
function resetTotalCount(tab: ResultTab) {
  tab.totalCountSeq += 1
  tab.totalCount = null
  tab.totalCountState = 'idle'
  tab.totalCountError = null
}

function resetTab(tab: ResultTab) {
  tab.status = 'running'
  tab.startedAt = Date.now()
  tab.result = null
  tab.stream = null
  tab.error = null
  tab.warnings = []
  tab.channelNote = null
  tab.errorLine = null
  tab.requestedQueryId = null
  tab.cancelRequested = false
  tab.override = tab.opts.maxRows === 0
  tab.identity = identityOf(tab.profileId)
  tab.hasNextPage = false
}

async function executeInto(
  tab: ResultTab,
  sql: string,
  opts: QueryOptionsInput,
  stream: boolean,
  notify = true,
): Promise<void> {
  resetTab(tab)
  const mySeq = ++tab.executionSeq
  const missing = missingConnection(tab)
  if (missing) {
    tab.error = missing
    tab.status = 'error'
    return
  }
  if (stream) {
    await executeStream(tab, sql, opts, mySeq, notify)
  } else {
    // 取消要按**请求时**的 id 发给服务端；回显 id 只有响应到达后才知道。
    const requestedQueryId = nextBulkQueryId()
    tab.requestedQueryId = requestedQueryId
    await executeBulk(tab, sql, { ...opts, queryId: requestedQueryId }, mySeq, notify)
  }
}

async function executeBulk(
  tab: ResultTab,
  sql: string,
  opts: QueryOptionsInput,
  mySeq: number,
  notify: boolean,
): Promise<void> {
  try {
    let result = await ipc.sqlExecute(tab.profileId, sql, opts)
    if (tab.executionSeq !== mySeq) return
    const cancelWasRequested = tab.cancelRequested
    tab.requestedQueryId = null
    tab.cancelRequested = false
    // 分页查询多取了 1 行做“还有下一页”判断；展示/导出只保留 pageSize 行。
    let hasNext = false
    if (
      tab.pagination &&
      result.kind === 'rows' &&
      result.rows.length > tab.pagination.pageSize
    ) {
      hasNext = true
      result = {
        ...result,
        rows: result.rows.slice(0, tab.pagination.pageSize),
        rowCount: tab.pagination.pageSize,
      }
    }
    tab.result = result
    if (result.kind === 'rows' && result.columns.length > 0) {
      tab.lastColumns = result.columns
      // 第一页就不满一页：无需额外 count，当前页行数就是完整结果行数。
      // 结果被服务端显式截断时不猜总数。
      if (tab.pagination?.page === 1 && !hasNext && !result.truncated) {
        tab.totalCount = String(result.rowCount)
        tab.totalCountState = 'idle'
        tab.totalCountError = null
        tab.totalCountSeq += 1
      }
    }
    tab.channelNote = result.channelNote ?? null
    tab.warnings = result.warnings ? [...result.warnings] : []
    if (cancelWasRequested) {
      // 取消与完成并发：结果是真的，如实标注，不假装取消成功。
      tab.warnings.push(t('取消请求发出时查询已经完成（结果完整）'))
    }
    tab.status = 'ok'
    tab.hasNextPage = hasNext
    if (notify) notifyQueryFinished(tab, 'ok')
    void syncSession(tab)
  } catch (e) {
    if (tab.executionSeq !== mySeq) return
    tab.requestedQueryId = null
    tab.cancelRequested = false
    const err = toStudioError(e)
    tab.error = err
    tab.status = 'error'
    maybeOpenGuardrail(tab, err)
    if (notify) notifyQueryFinished(tab, 'error')
    void syncSession(tab)
  }
}

/**
 * 登录态是客户端透明维护的：撞 `SESSION_REVOKED` 会自动重登并重发读请求。
 * 这里在每次收尾后对照 sessionId，把"已自动重登"作为**非致命警告**显示出来
 * （设计 §五.1.7：驱动语义要体现在 UI，而不是假装什么都没发生）。
 */
async function syncSession(tab: ResultTab): Promise<void> {
  const state = appState.connections[tab.profileId]
  if (!state || state.info.auth.kind !== 'basic') return
  try {
    const s = await ipc.connSession(tab.profileId)
    if (!s) return
    const prev = state.session
    state.session = s
    state.defaultDb = s.defaultDb
    if (prev && prev.sessionId !== s.sessionId) {
      tab.warnings.push(t('会话已失效并自动重登（服务端签发了新会话）'))
    }
  } catch {
    // 会话展示失败不影响查询结果本身。
  }
}

async function executeStream(
  tab: ResultTab,
  sql: string,
  opts: QueryOptionsInput,
  mySeq: number,
  notify: boolean,
): Promise<void> {
  tab.status = 'streaming'
  tab.stream = {
    streamId: '',
    columns: [],
    totalRows: 0,
    done: false,
    elapsedMs: null,
    serverElapsedMs: null,
    preview: null,
    error: null,
    stopping: false,
  }
  const channel = new Channel<StreamEvent>()
  let streamId = ''
  let buffered: StreamEvent[] = []

  const apply = (ev: StreamEvent) => {
    if (tab.executionSeq !== mySeq) return
    const s = tab.stream
    if (!s) return
    if (ev.kind === 'started') {
      s.columns = ev.columns
      s.serverElapsedMs = ev.serverElapsedMs ?? null
    } else if (ev.kind === 'chunk') {
      s.totalRows = ev.totalRows
      s.preview = { start: ev.start, rows: ev.rows }
    } else if (ev.kind === 'end') {
      s.totalRows = ev.totalRows
      s.elapsedMs = ev.elapsedMs
      s.done = true
      s.stopping = false
      tab.status = 'ok'
      if (notify) notifyQueryFinished(tab, 'ok')
      void syncSession(tab)
    } else {
      s.error = ev.error
      s.totalRows = ev.rowsReceived
      s.done = true
      s.stopping = false
      tab.status = 'error'
      maybeOpenGuardrail(tab, ev.error)
      if (notify) notifyQueryFinished(tab, 'error')
      void syncSession(tab)
    }
  }

  channel.onmessage = (ev) => {
    if (!streamId) {
      buffered.push(ev)
      return
    }
    apply(ev)
  }

  try {
    const id = await ipc.sqlStreamStart(tab.profileId, sql, opts, channel)
    if (tab.executionSeq !== mySeq) {
      // 结果页已关闭/重跑：先停止（执行段 cancel + 传输段 abort），再释放。
      void ipc.sqlStreamStop(tab.profileId, id).catch(() => {})
      void ipc.sqlStreamRelease(id).catch(() => {})
      return
    }
    streamId = id
    tab.stream.streamId = id
    const pending = buffered
    buffered = []
    for (const ev of pending) apply(ev)
  } catch (e) {
    if (tab.executionSeq !== mySeq) return
    const err = toStudioError(e)
    tab.stream.error = err
    tab.stream.done = true
    tab.stream.stopping = false
    tab.status = 'error'
    maybeOpenGuardrail(tab, err)
    if (notify) notifyQueryFinished(tab, 'error')
  }
}

function maybeOpenGuardrail(tab: ResultTab, err: StudioError) {
  if (err.code !== 'RESULT_TOO_LARGE') return
  queryState.guardrail = {
    visible: true,
    tabKey: tab.key,
    editorKey: tab.editorKey,
    profileId: tab.profileId,
    error: err,
    sql: tab.sql,
    opts: { ...tab.opts },
  }
}

/** 执行一条 SQL（在指定编辑器标签下新建结果页）。 */
export async function runSql(
  editorKey: string,
  profileId: string,
  sql: string,
  opts: QueryOptionsInput,
  options: { stream: boolean; title?: string; paginate?: boolean },
): Promise<ResultTab> {
  const title =
    options.title ?? (options.stream ? t('流式结果') : sql.trim().split(/\r?\n/)[0].slice(0, 40))
  // 流式是用户显式选择的大结果通道，不套自动分页；bulk 才默认 500 行/页。
  // `paginate:false` 用于 count(*) 等单行查询，避免无意义的自动分页条。
  const plan =
    options.stream || options.paginate === false
      ? null
      : planPagination(sql, DEFAULT_PAGE_SIZE)
  const pagination: PageState | null = plan
    ? { baseSql: sql, page: 1, pageSize: plan.pageSize }
    : null
  const tab = createTab(editorKey, profileId, title, sql, opts, pagination)
  const execSql = pagination
    ? pageSql(pagination.baseSql, 1, pagination.pageSize, pagination.pageSize + 1)
    : sql
  const execOpts = pagination ? { ...tab.opts, historySql: pagination.baseSql } : tab.opts
  await executeInto(tab, execSql, execOpts, options.stream)
  return tab
}

/** 重跑某个结果页（沿用原 SQL/参数/通道/连接；自动分页的页保持当前页）。 */
export async function retryTab(key: string): Promise<void> {
  const tab = findTab(key)
  if (!tab) return
  const stream = Boolean(tab.stream)
  releaseStream(tab)
  resetTotalCount(tab)
  const execSql = tab.pagination
    ? pageSql(
        tab.pagination.baseSql,
        tab.pagination.page,
        tab.pagination.pageSize,
        tab.pagination.pageSize + 1,
      )
    : tab.sql
  // 历史始终记录用户原始 SQL；筛选/分页只是 Studio 生成的视图 SQL。
  const execOpts = tab.pagination
    ? { ...tab.opts, historySql: tab.sql }
    : { ...tab.opts }
  await executeInto(tab, execSql, execOpts, stream)
}

/** 翻到自动分页的某一页（1 基）；复用同一个结果页，不新建标签。 */
export async function goToPage(key: string, page: number): Promise<void> {
  const tab = findTab(key)
  if (!tab?.pagination) return
  if (tab.status === 'running' || tab.status === 'streaming') return
  const target = Math.max(1, Math.floor(page))
  if (target === tab.pagination.page) return
  tab.pagination.page = target
  const sql = pageSql(
    tab.pagination.baseSql,
    target,
    tab.pagination.pageSize,
    tab.pagination.pageSize + 1,
  )
  // 翻页是用户正在看着的交互，不额外制造通知。
  await executeInto(tab, sql, { ...tab.opts, historySql: tab.sql }, false, false)
}

/**
 * 应用服务端字段筛选：把原查询包成子查询后重新从第 1 页执行。
 * 仅支持自动分页结果（原 SQL 没有 LIMIT）；返回错误文案或 null。
 * 历史仍记录用户原始 SQL；筛选是结果页的即时视图，不写进历史。
 */
export async function applyTabFilters(
  key: string,
  filters: ColumnFilter[],
): Promise<string | null> {
  const tab = findTab(key)
  if (!tab) return t('结果页已关闭')
  if (!tab.pagination) {
    return t('字段筛选只支持未写 LIMIT 的自动分页查询（显式 LIMIT 时筛选的不是全量结果）')
  }
  if (tab.status === 'running' || tab.status === 'streaming') {
    return t('查询正在执行，完成后再调整字段筛选')
  }
  const nextFilters = filters.map((f) => ({ ...f }))
  const base = buildFilteredSql(tab.sql, nextFilters)
  if (!base.sql) return base.error ?? t('筛选条件不合法')
  tab.filters = nextFilters
  tab.pagination.baseSql = base.sql
  tab.pagination.page = 1
  resetTotalCount(tab)
  const sql = pageSql(
    tab.pagination.baseSql,
    1,
    tab.pagination.pageSize,
    tab.pagination.pageSize + 1,
  )
  await executeInto(tab, sql, { ...tab.opts, historySql: tab.sql }, false, false)
  return null
}

/** count(*) 的线上值：安全整数是 number，超出 JS 安全整数是十进制字符串。 */
function countValueOf(value: WireValue | undefined): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  return null
}

/**
 * 统计自动分页结果的**完整总行数**（不是当前页 500 行）：
 * 在当前页的基准 SQL（已含服务端字段筛选）外层执行一次 `count(*)`。
 * count 作为内部查询执行：不新建结果页、不写执行历史、不发通知。
 * 返回错误文案或 null（状态同时写进结果页，供标签显示重试）。
 */
export async function countTotalRows(key: string): Promise<string | null> {
  const tab = findTab(key)
  if (!tab) return t('结果页已关闭')
  if (!tab.pagination) return t('只有自动分页结果支持统计总行数')
  if (!canCountTotal(tab.pagination.baseSql)) {
    return t('当前查询形态不支持统计总行数（QSDB 不允许把 VALUES 放进子查询）')
  }
  if (tab.status === 'running' || tab.status === 'streaming') {
    return t('查询正在执行，完成后再统计总行数')
  }
  if (tab.totalCountState === 'loading') return null
  const missing = missingConnection(tab)
  if (missing) {
    tab.totalCount = null
    tab.totalCountState = 'error'
    tab.totalCountError = missing.message
    return missing.message
  }

  const mySeq = ++tab.totalCountSeq
  tab.totalCountState = 'loading'
  tab.totalCountError = null
  try {
    const result = await ipc.sqlExecute(tab.profileId, totalCountSql(tab.pagination.baseSql), {
      ...tab.opts,
      params: tab.opts.params ?? [],
      skipHistory: true,
    })
    if (tab.totalCountSeq !== mySeq) return null
    if (result.kind !== 'rows' || result.rows.length === 0) {
      throw new Error(t('count 查询没有返回结果行'))
    }
    const count = countValueOf(result.rows[0]?.[0])
    if (count === null) throw new Error(t('count 查询返回了无法识别的行数'))
    tab.totalCount = count
    tab.totalCountState = 'idle'
    return null
  } catch (e) {
    if (tab.totalCountSeq !== mySeq) return null
    const err = toStudioError(e)
    tab.totalCount = null
    tab.totalCountState = 'error'
    tab.totalCountError = err.message
    return err.message
  }
}

/** 逐条执行（失败即停，标出失败语句行）。 */
export async function runBatch(
  editorKey: string,
  profileId: string,
  statements: SqlStatement[],
  opts: QueryOptionsInput,
): Promise<void> {
  clearErrorMarker()
  queryState.batchRunning = true
  try {
    for (let i = 0; i < statements.length; i++) {
      const st = statements[i]
      if (!st.sql.trim()) continue
      const tab = await runSql(editorKey, profileId, st.sql, { ...opts, params: [] }, {
        stream: false,
        title: tt`语句 ${i + 1} · 行 ${st.startLine}`,
      })
      if (tab.error || tab.stream?.error) {
        tab.errorLine = st.startLine
        markError(
          st.startLine,
          tab.error?.message ?? tab.stream?.error?.message ?? t('执行失败'),
          editorKey,
        )
        break
      }
    }
  } finally {
    queryState.batchRunning = false
  }
}

/** 关闭一个结果页（流式结果同时释放磁盘 spool）。 */
export function closeTab(key: string): void {
  const idx = queryState.tabs.findIndex((t) => t.key === key)
  if (idx < 0) return
  const tab = queryState.tabs[idx]
  const siblings = resultsOf(tab.editorKey).map((t) => t.key)
  const pos = siblings.indexOf(key)
  tab.executionSeq += 1
  tab.totalCountSeq += 1
  releaseStream(tab)
  // 关闭正在跑的 bulk 结果页：顺手取消服务端查询，避免留下“看不见的长查询”。
  if (
    tab.status === 'running' &&
    tab.requestedQueryId &&
    appState.connections[tab.profileId]
  ) {
    void ipc.sqlCancel(tab.profileId, tab.requestedQueryId).catch(() => {})
  }
  queryState.tabs.splice(idx, 1)
  const wasActive = queryState.activeKeys[tab.editorKey] === key
  if (wasActive) {
    // 优先选左侧邻居（与编辑器标签习惯一致），同一编辑器标签内选择。
    const remaining = siblings.filter((k) => k !== key)
    const next = remaining[Math.max(0, pos - 1)] ?? remaining[0] ?? ''
    if (next) queryState.activeKeys[tab.editorKey] = next
    else delete queryState.activeKeys[tab.editorKey]
  }
}

/** 关闭某个编辑器标签下的全部结果页（关闭编辑器标签时由 workspace 调用）。 */
export function closeResultsOf(editorKey: string): void {
  for (const tab of [...queryState.tabs]) {
    if (tab.editorKey === editorKey) closeTab(tab.key)
  }
}

/** 关闭所有结果页（保留给“全部关闭”的全局语义）。 */
export function closeAllTabs(): void {
  for (const tab of [...queryState.tabs]) closeTab(tab.key)
}

function releaseStream(tab: ResultTab): void {
  const s = tab.stream
  if (!s?.streamId) return
  if (!s.done) {
    // 停止 = cancel（执行段）+ 本地 abort（传输段）。关闭结果页时也要
    // 真正释放连接，否则后台会继续接收/落盘到流结束。
    // 即使连接已断开也调用：core 的本地停止标记不依赖管理面连接。
    void ipc.sqlStreamStop(tab.profileId, s.streamId).catch(() => {})
  }
  // release 在 core 里也会先打停止标记（与上面的命令并发也安全）。
  void ipc.sqlStreamRelease(s.streamId).catch(() => {})
}

/**
 * 取消正在执行的查询：
 * - 流式：`sqlStreamStop` 走两段语义——执行段由服务端 cancel 命中；传输段
 *   服务端已把查询注销（cancel 404 是预期），Rust reader 在下一个块边界
 *   `RowStream::abort()` 关连接。结果由 `QUERY_CANCELLED` error 事件收尾；
 * - bulk：按执行前生成的 queryId 取消。执行段走管理连接 cancel；传输段
 *   服务端已注销，core 同时 abort 本地请求的 socket（qsdb-client
 *   AbortHandle），正在读响应的 execute 立即返回。结果以 `QUERY_CANCELLED`
 *   收尾，页面标注“不是完整结果”。
 */
export async function stopTab(key: string): Promise<void> {
  const tab = findTab(key)
  if (!tab) return

  const s = tab.stream
  if (s && !s.done && s.streamId) {
    s.stopping = true
    try {
      await ipc.sqlStreamStop(tab.profileId, s.streamId)
    } catch (e) {
      s.stopping = false
      throw e
    }
    return
  }

  if (tab.status !== 'running' || !tab.requestedQueryId || tab.cancelRequested) return
  tab.cancelRequested = true
  try {
    await ipc.sqlCancel(tab.profileId, tab.requestedQueryId)
  } catch (e) {
    tab.cancelRequested = false
    const err = toStudioError(e)
    if (err.code === 'NOT_FOUND') {
      throw new Error(t('服务端没有找到正在运行的查询（可能已经结束），请等待结果返回。'))
    }
    throw e
  }
}

/** 重新打开某结果页的护栏选项（错误页上的按钮）。 */
export function openGuardrailForTab(key: string): void {
  const tab = findTab(key)
  if (!tab) return
  const err = tab.error ?? tab.stream?.error
  if (!err) return
  queryState.guardrail = {
    visible: true,
    tabKey: tab.key,
    editorKey: tab.editorKey,
    profileId: tab.profileId,
    error: err,
    sql: tab.sql,
    opts: { ...tab.opts },
  }
}

/**
 * 护栏三选一：
 * - `limit`：加 LIMIT 重跑（新结果页）；
 * - `unlimited`：本请求 `maxRows=0`（**结果页会标注豁免**）；
 * - `stream`：转流式浏览。
 */
export async function applyGuardrail(
  action: 'limit' | 'unlimited' | 'stream',
  limit?: number,
  params: ParamInput[] = [],
): Promise<void> {
  const g = queryState.guardrail
  const sql = g.sql
  const opts = { ...g.opts, params: g.opts.params ?? params }
  queryState.guardrail.visible = false
  if (!sql.trim() || !g.editorKey || !g.profileId) return
  if (action === 'limit') {
    const n = Math.max(1, Math.floor(limit ?? 10000))
    await runSql(g.editorKey, g.profileId, wrapWithLimit(sql, n), {
      ...opts,
      maxRows: undefined,
    }, {
      stream: false,
      title: tt`结果（LIMIT ${n}）`,
    })
  } else if (action === 'unlimited') {
    await runSql(g.editorKey, g.profileId, sql, { ...opts, maxRows: 0 }, {
      stream: false,
      title: t('结果（本请求不限）'),
    })
  } else {
    // 定案：流式**不豁免**护栏；第三条与“本请求豁免”合并 = rows + maxRows=0。
    // 结果页会显示“本请求已豁免护栏”的显式标注。
    await runSql(g.editorKey, g.profileId, sql, { ...opts, maxRows: 0 }, {
      stream: true,
      title: t('流式结果（本请求豁免）'),
    })
  }
}

/** 关闭护栏弹窗。 */
export function dismissGuardrail(): void {
  queryState.guardrail.visible = false
}
