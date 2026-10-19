// 与 qsdb-studio-core 的 IPC 契约（serde camelCase）。改这里 = 改契约。

export type AuthKind =
  | { kind: 'none' }
  | { kind: 'basic'; user: string }
  | { kind: 'bearer' }

export interface ProfileView {
  id: string
  name: string
  url: string
  auth: AuthKind
  defaultDatabase: string | null
  /** 只读连接：Studio 拦截可能写入的语句（服务端授权仍是最终边界）。 */
  readOnly: boolean
  hasSecret: boolean
  createdAtMs: number
  updatedAtMs: number
}

export interface ProfileInput {
  id?: string | null
  name: string
  url: string
  auth: AuthKind
  defaultDatabase?: string | null
  readOnly?: boolean
  secret?: string | null
}

/** CSV 解析失败的结构化定位（用于“复制出错行”）。 */
export interface CsvErrorDetail {
  recordIndex: number
  line: number
  column: string
  value?: string | null
}

/** 按 code 分支的业务错误（文案不做兼容承诺）。 */
export interface StudioError {
  kind: string
  code?: string
  status?: number
  message: string
  retriable: boolean
  details?: CsvErrorDetail
}

export interface ConnInfo {
  profileId: string
  profileName: string
  url: string
  version: string
  auth: AuthKind
}

/** “测试连接”的结果：不落盘、不建池连接。 */
export interface ConnTestResult {
  version: string
  /** Basic 登录后的用户；匿名/Token 为 null。 */
  user: string | null
  role: string | null
  defaultDb: string | null
  warnings: string[]
  elapsedMs: number
}

export interface SessionView {
  sessionId: string
  user: string
  role: string | null
  grants: unknown
  defaultDb: string
}

export interface WireDb {
  name: string
  readOnly: boolean
}

export interface WireColumnInfo {
  name: string
  typeName: string
  nullable: boolean
  partition: boolean
}

export interface WireTable {
  name: string
  columns: WireColumnInfo[]
}

export interface WirePartition {
  name: string
  generation: number
  rows: number
  segments: number
  /** 段文件压缩后落盘字节总量（单表大小 = 各分区求和）。 */
  bytes: number
}

// ---------------------------------------------------------------------------
// 文件管理面（内核二十批）
// ---------------------------------------------------------------------------

/** 调用方可见的挂载（文件浏览器侧栏起点）。 */
export interface FileMount {
  name: string
  isDefault: boolean
}

/** 段的列统计（manifest 内嵌，不读 parquet 就有）。 */
export interface FileColumnStat {
  name: string
  /** 全 NULL 列为 null。 */
  min: string | null
  max: string | null
  nullCount: number
}

/**
 * 段摘要。`referenced` 是**三态**：
 * - true：被存活 manifest 引用，不可删除；
 * - false：孤儿，可移入回收站；
 * - null：未知（manifest 缺失/损坏）——未知 ≠ 未引用，Studio 不放行删除。
 */
export interface FileSegment {
  referenced: boolean | null
  rows: number | null
  bytes: number | null
  createdAtMs: number | null
  generation: number | null
  /** 仅详情填；列表为空数组。 */
  columns: FileColumnStat[]
}

export interface FileEntry {
  name: string
  isDir: boolean
  size: number | null
  modifiedMs: number | null
  /** 仅 `seg_*.parquet` 有。 */
  segment: FileSegment | null
}

export interface FileListing {
  /** 归一化后的目录；空串 = 存储根。 */
  dir: string
  mounts: FileMount[]
  entries: FileEntry[]
}

export interface DirSummary {
  dirs: number
  files: number
  bytes: number
}

export interface ManifestDetail {
  generation: number
  rows: number
  segments: number
  version: number
  partitionValues: [string, string][]
}

export interface FileDetail {
  path: string
  name: string
  isDir: boolean
  /** `segment` | `manifest` | `index` | `tabledef` | `other` | `dir`。 */
  kind: string
  size: number
  modifiedMs: number
  db: string
  table: string | null
  partition: string | null
  summary: DirSummary | null
  segment: FileSegment | null
  manifest: ManifestDetail | null
  tableDef: unknown | null
  /** 单文件预览 SQL（本地库才有；权限由查询面自己管）。 */
  readSql: string | null
}

export interface TrashAck {
  trashed: boolean
  path: string
}

export type Tag =
  | 'bool'
  | 'i8'
  | 'i16'
  | 'i32'
  | 'i64'
  | 'f32'
  | 'f64'
  | 'utf8'
  | 'binary'
  | 'date32'
  | 'time64ns'
  | 'timestampns'
  | 'decimal128'
  | 'interval'

export interface WireColumn {
  name: string
  tag: Tag
  typeName: string
  nullable: boolean
  decimal?: [number, number]
  tz?: string
}

/** 单元格：NULL / 布尔 / 数字 / 字符串（日期与 Decimal 都是契约字符串）。 */
export type WireValue = null | boolean | number | string

export interface QueryResult {
  kind: 'rows' | 'exec'
  columns: WireColumn[]
  rows: WireValue[][]
  rowCount: number
  /** 客户端往返墙钟耗时（ms，含网络与客户端解码）。 */
  elapsedMs: number
  /** 服务端执行耗时（ms，不含序列化/网络/客户端解码）；旧服务端可为 null。 */
  serverElapsedMs?: number | null
  queryId?: string | null
  command?: string | null
  message?: string | null
  rowsAffected?: number | null
  truncated: boolean
  channelNote?: string | null
  warnings: string[]
}

export interface QueryOptionsInput {
  maxRows?: number | null
  timeoutMs?: number | null
  database?: string | null
  queryId?: string | null
  params?: ParamInput[]
  /** 仅用于本地执行历史：原始 SQL（自动分页时不含补上的 LIMIT/OFFSET）。 */
  historySql?: string | null
  /**
   * 仅内部 SQL（如结果总行数统计）使用：不在本地执行历史里留记录。
   * 不会发给服务端。
   */
  skipHistory?: boolean
}

export interface ParamInput {
  value: unknown
  ty?: string | null
}

export interface SqlStatement {
  sql: string
  startLine: number
  endLine: number
}

export type StreamEvent =
  | {
      kind: 'started'
      streamId: string
      columns: WireColumn[]
      /** 服务端执行耗时（ms）；旧服务端未提供时缺省。 */
      serverElapsedMs?: number | null
    }
  | {
      kind: 'chunk'
      streamId: string
      start: number
      rowCount: number
      totalRows: number
      rows: WireValue[][]
    }
  | { kind: 'end'; streamId: string; totalRows: number; elapsedMs: number }
  | { kind: 'error'; streamId: string; error: StudioError; rowsReceived: number }

export interface StreamPage {
  offset: number
  rows: WireValue[][]
  totalRows: number
  done: boolean
}

export interface HistoryEntry {
  tsMs: number
  profileId: string
  connectionName: string
  sql: string
  elapsedMs: number
  rowCount: number
  status: 'ok' | 'error'
  errorCode: string | null
  queryId: string | null
}

// ---------------------------------------------------------------------------
// M2 预留接口（依赖 qsdb-client 一等方法的内核补全批次）
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  queryTimeoutMs: number
  queryMemoryLimitBytes: number
  maxResultRows: number
  maxResultBytes: number
}

export interface StartupConfig {
  scanCacheBytes: number
  trashGraceMs: number
  spillDir: string
}

export interface MemoryConfig {
  budgetBytes: number
  execUsedBytes: number
  cacheUsedBytes: number
  cacheEvictedBytes: number
  note: string
}

export interface ServerConfig {
  maxConcurrentQueries: number
  mounts: string[]
}

export interface ConfigSnapshot {
  runtime: RuntimeConfig
  startup?: StartupConfig | null
  memory?: MemoryConfig | null
  server?: ServerConfig | null
  _hint?: string | null
}

export interface ConfigPatch {
  queryTimeoutMs?: number
  queryMemoryLimitBytes?: number
  maxResultRows?: number
  maxResultBytes?: number
}

export interface ConfigUpdateAck extends RuntimeConfig {
  applied: boolean
}

export interface StoredSession {
  id: string
  user: string
  role: string | null
  client: string
  createdAtMs: number
  lastActiveMs: number
  idleMs: number
  defaultDb: string
  runningQueries: string[]
  queriesTotal: number
  rowsWritten: number
}

export interface SessionsList {
  sessions: StoredSession[]
  count: number
}

export interface KickResult {
  kicked: string
  /** 一并取消的查询数。 */
  cancelledQueries: number
}

export interface StoredQuery {
  id: string
  sql: string
  elapsedMs: number
  memoryBytes: number
  cancelled: boolean
  sessionId: string | null
}

export interface QueriesList {
  queries: StoredQuery[]
  count: number
}

export interface WatchEvent {
  database: string
  table: string
  /** client 已解码的分区值。 */
  partition: string[]
  generation: number
  /** `Append` / `Overwrite` / `Clear`；`Reset` = 游标重置后的对账事件。 */
  kind: 'Append' | 'Overwrite' | 'Clear' | 'Reset' | 'Error' | string
  /** Reset/Error 的人读说明。 */
  message?: string | null
}

export interface WatchBatch {
  events: WatchEvent[]
  next: number
  more: boolean
}

/** 库名（或 `*`）→ 角色名 / null（显式无权）。 */
export type GrantsMap = Record<string, string | null>

/** 一条 SQL 收藏。 */
export interface Favorite {
  id: string
  name: string
  sql: string
  createdAtMs: number
}

// ---------------------------------------------------------------------------
// M2.6 COPY 导出 / M2.7 CSV 导入
// ---------------------------------------------------------------------------

export type CopyFormat = 'parquet' | 'csv'

export interface CopyInput {
  query: string
  target: string
  format: CopyFormat
  partitionBy: string[]
  header: boolean
}

export interface CopyResult {
  sql: string
  verifySql: string
  message?: string | null
  command?: string | null
  rowsAffected?: number | null
  queryId?: string | null
  elapsedMs: number
}

export interface ImportProgress {
  rows: number
  bytes: number
  totalBytes: number
}

export interface ImportSummary {
  table: string
  rows: number
  batches: number
  warnings: string[]
  elapsedMs: number
}

/** 一列映射：目标表列 → CSV 表头（null = 显式不映射）。 */
export interface CsvMapping {
  column: string
  header: string | null
}

export interface CsvPreviewColumn {
  name: string
  typeName: string
  nullable: boolean
  partition: boolean
  header: string | null
  headerIndex: number | null
  mappingError?: string | null
  inferred: string
  nonNull: number
  nulls: number
  errorCount: number
  samples: string[]
}

export interface CsvPreviewError {
  recordIndex: number
  line: number
  column: string
  value: string
  message: string
}

export interface CsvPreviewRow {
  line: number
  values: (string | null)[]
}

export interface CsvPreview {
  table: string
  headers: string[]
  rowsPreviewed: number
  totalBytes: number
  columns: CsvPreviewColumn[]
  extras: string[]
  missing: string[]
  mappingComplete: boolean
  sampleErrors: CsvPreviewError[]
  rows: CsvPreviewRow[]
}
