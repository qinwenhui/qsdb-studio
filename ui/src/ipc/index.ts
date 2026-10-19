// Tauri IPC 封装：所有网络/文件操作都走 Rust 命令（前端永不直接发 HTTP）。
import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  ConfigPatch,
  ConfigSnapshot,
  ConfigUpdateAck,
  ConnInfo,
  ConnTestResult,
  CopyInput,
  CopyResult,
  CsvMapping,
  CsvPreview,
  Favorite,
  FileDetail,
  FileEntry,
  FileListing,
  FileMount,
  FileSegment,
  GrantsMap,
  HistoryEntry,
  ImportProgress,
  ImportSummary,
  KickResult,
  ParamInput,
  ProfileInput,
  ProfileView,
  QueriesList,
  QueryOptionsInput,
  QueryResult,
  SessionsList,
  SessionView,
  SqlStatement,
  StreamEvent,
  StreamPage,
  StudioError,
  TrashAck,
  WatchEvent,
  WireColumn,
  WireDb,
  WirePartition,
  WireTable,
  WireValue,
} from './types'

export type {
  ConfigPatch,
  ConfigSnapshot,
  ConfigUpdateAck,
  ConnInfo,
  ConnTestResult,
  CsvMapping,
  CsvPreview,
  Favorite,
  FileDetail,
  FileEntry,
  FileListing,
  FileMount,
  FileSegment,
  GrantsMap,
  HistoryEntry,
  KickResult,
  ParamInput,
  ProfileInput,
  ProfileView,
  QueriesList,
  QueryOptionsInput,
  QueryResult,
  SessionsList,
  SessionView,
  SqlStatement,
  StreamEvent,
  StreamPage,
  StudioError,
  TrashAck,
  WatchEvent,
  WireColumn,
  WireDb,
  WirePartition,
  WireTable,
  WireValue,
}

/** 归一化后的命令错误：`info` 是契约形态（带 code）。 */
export class IpcError extends Error {
  readonly info: StudioError

  constructor(info: StudioError) {
    super(info.message)
    this.name = 'IpcError'
    this.info = info
  }
}

export function isIpcError(e: unknown): e is IpcError {
  return e instanceof IpcError
}

function normalize(e: unknown): StudioError {
  if (e && typeof e === 'object') {
    const o = e as Partial<StudioError>
    if (typeof o.message === 'string' && typeof o.kind === 'string') {
      return {
        kind: o.kind,
        code: o.code,
        status: o.status,
        message: o.message,
        retriable: Boolean(o.retriable),
        details: o.details,
      }
    }
    // Tauri 有时把错误序列化成字符串包一层
    if (typeof (e as { error?: unknown }).error === 'string') {
      return normalize((e as { error: string }).error)
    }
  }
  if (typeof e === 'string') {
    try {
      return normalize(JSON.parse(e))
    } catch {
      return { kind: 'internal', message: e, retriable: false }
    }
  }
  return { kind: 'internal', message: String(e), retriable: false }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args)
  } catch (e) {
    throw new IpcError(normalize(e))
  }
}

// ---------------------------------------------------------------------------
// 档案
// ---------------------------------------------------------------------------

export const profilesList = () => call<ProfileView[]>('profiles_list')
export const profileSave = (input: ProfileInput) =>
  call<ProfileView>('profile_save', { input })
export const profileDelete = (id: string) => call<boolean>('profile_delete', { id })

// ---------------------------------------------------------------------------
// 连接 / 会话
// ---------------------------------------------------------------------------

/** 用表单参数测试连接（不保存档案/秘密、不进连接池）。 */
export const connTest = (input: ProfileInput) =>
  call<ConnTestResult>('conn_test', { input })

export const connCreate = (id: string) => call<ConnInfo>('conn_create', { id })
export const connLogin = (id: string, user: string, password: string | null) =>
  call<SessionView>('conn_login', { id, user, password })
export const connHealth = (id: string) => call<string>('conn_health', { id })
export const connSession = (id: string) =>
  call<SessionView | null>('conn_session', { id })
export const connClose = (id: string) => call<boolean>('conn_close', { id })

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

export const metaDatabases = (id: string) => call<WireDb[]>('meta_databases', { id })
export const metaTables = (id: string) => call<WireTable[]>('meta_tables', { id })
export const metaPartitions = (id: string, table: string) =>
  call<WirePartition[]>('meta_partitions', { id, table })
export const metaUse = (id: string, database: string) =>
  call<void>('meta_use', { id, database })

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

export const sqlExecute = (
  id: string,
  sql: string,
  opts: QueryOptionsInput,
) => call<QueryResult>('sql_execute', { id, sql, opts })

export const sqlSplit = (sql: string) => call<SqlStatement[]>('sql_split', { sql })

export const sqlCancel = (id: string, queryId: string) =>
  call<void>('sql_cancel', { id, queryId })

/** 启动流式查询。事件经 `channel.onmessage` 推送。 */
export const sqlStreamStart = (
  id: string,
  sql: string,
  opts: QueryOptionsInput,
  channel: Channel<StreamEvent>,
) => call<string>('sql_stream_start', { id, sql, opts, onEvent: channel })

export const sqlStreamPage = (streamId: string, offset: number, limit: number) =>
  call<StreamPage>('sql_stream_page', { streamId, offset, limit })

/**
 * 停止流式查询（两段式）：
 * - 服务端执行段：cancel 命中则真正取消；
 * - 传输段：服务端已注销（404 是预期），Rust 侧在下一个块边界关闭连接。
 * 不把 404 当失败；结果页由 error 事件（QUERY_CANCELLED）收尾。
 */
export const sqlStreamStop = (id: string, streamId: string) =>
  call<void>('sql_stream_stop', { id, streamId })

export const sqlStreamRelease = (streamId: string) =>
  call<void>('sql_stream_release', { streamId })

export const sqlStreamExportCsv = (streamId: string, path: string, bom: boolean) =>
  call<number>('sql_stream_export_csv', { streamId, path, bom })

// ---------------------------------------------------------------------------
// 本地文件 / 历史
// ---------------------------------------------------------------------------

export const saveTextFile = (path: string, text: string, bom: boolean) =>
  call<void>('save_text_file', { path, text, bom })

export const readTextFile = (path: string) => call<string>('read_text_file', { path })

export const historyList = (limit: number, query: string | null) =>
  call<HistoryEntry[]>('history_list', { limit, query })

// ---------------------------------------------------------------------------
// M2 预留（依赖 qsdb-client 一等方法的内核补全批次）
//
// 命令签名与类型已冻结；当前调用会得到明确的 `pending` 错误——
// 不返回空成功、也不在 core 手搓裸 HTTP。
// ---------------------------------------------------------------------------

export const configGet = (id: string) => call<ConfigSnapshot>('config_get', { id })

export const configPut = (id: string, patch: ConfigPatch) =>
  call<ConfigUpdateAck>('config_put', { id, patch })

export const sessionsList = (id: string) => call<SessionsList>('sessions_list', { id })

export const sessionsKick = (id: string, sessionId: string) =>
  call<KickResult>('sessions_kick', { id, sessionId })

export const queriesList = (id: string) => call<QueriesList>('queries_list', { id })

/** 启动 watch 长轮询；返回当前游标。`CURSOR_TOO_OLD` 需全量对账。 */
export const watchStart = (
  id: string,
  since: number | null,
  channel: Channel<WatchEvent>,
) => call<void>('watch_start', { id, since, onEvent: channel })

export const watchStop = (id: string) => call<void>('watch_stop', { id })

export const grantsPut = (id: string, user: string, grants: GrantsMap) =>
  call<void>('grants_put', { id, user, grants })

// ---------------------------------------------------------------------------
// 收藏
// ---------------------------------------------------------------------------

export const favoritesList = () => call<Favorite[]>('favorites_list')

export const favoriteAdd = (name: string | null, sql: string) =>
  call<Favorite>('favorite_add', { name, sql })

export const favoriteRename = (id: string, name: string) =>
  call<Favorite>('favorite_rename', { id, name })

export const favoriteRemove = (id: string) => call<boolean>('favorite_remove', { id })

/** 读本地图片为 data URL（壁纸；Rust 侧校验格式与 16 MiB 上限）。 */
export const readImageDataUrl = (path: string) =>
  call<string>('read_image_data_url', { path })

// ---------------------------------------------------------------------------
// M2.6 / M2.7
// ---------------------------------------------------------------------------

export const copyBuildSql = (input: CopyInput) =>
  call<string>('copy_build_sql', { input })

export const copyTo = (id: string, input: CopyInput) =>
  call<CopyResult>('copy_to', { id, input })

export const downloadFile = (id: string, serverPath: string, localPath: string) =>
  call<number>('download_file', { id, serverPath, localPath })

// 文件管理面（内核二十批）：目录浏览 / 详情 / 孤儿段回收站。

export const filesList = (id: string, dir: string) =>
  call<FileListing>('files_list', { id, dir })

export const filesDetail = (id: string, path: string) =>
  call<FileDetail>('files_detail', { id, path })

export const filesTrash = (id: string, path: string) =>
  call<TrashAck>('files_trash', { id, path })

export const csvPreview = (
  id: string,
  table: string,
  path: string,
  mapping: CsvMapping[],
) => call<CsvPreview>('csv_preview', { id, table, path, mapping })

export const csvReadRow = (path: string, recordIndex: number) =>
  call<string>('csv_read_row', { path, recordIndex })

export const importCsv = (
  id: string,
  table: string,
  path: string,
  mapping: CsvMapping[],
  onProgress: Channel<ImportProgress>,
) => call<ImportSummary>('import_csv', { id, table, path, mapping, onProgress })
