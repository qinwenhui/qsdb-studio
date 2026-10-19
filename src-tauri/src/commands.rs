//! IPC 命令面（设计 §四，M1 部分）。
//!
//! 这里**只有参数转发 + 后台线程调度**。所有语义在 `qsdb-studio-core`；
//! 网络调用一律 `spawn_blocking`，不阻塞 WebView 的 IPC 线程。

use std::path::PathBuf;
use std::sync::Arc;

use qsdb_studio_core::{
    ConfigPatch, ConfigSnapshot, ConfigUpdateAck, ConnInfo, ConnTestResult, CopyInput, CopyResult,
    CsvMapping, CsvPreview, Favorite, GrantsMap, HistoryEntry, ImportProgress, ImportSummary,
    KickResult, ProfileInput, ProfileView, QueriesList, QueryOptionsInput, QueryResult,
    SessionView, SessionsList, SqlStatement, StreamEvent, StreamPage, StudioCore, StudioError,
    WatchEvent, WireDb, WireFileDetail, WireFileListing, WirePartition, WireTable, WireTrashAck,
};
use tauri::State;
use tauri::ipc::Channel;

type Core = Arc<StudioCore>;

/// 在阻塞线程池里跑一段 core 调用。
async fn blocking<T, F>(f: F) -> Result<T, StudioError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, StudioError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| StudioError::internal(format!("后台任务失败: {e}")))?
}

// ---------------------------------------------------------------------------
// 连接档案
// ---------------------------------------------------------------------------

/// 全部连接档案（秘密只回 `hasSecret` 布尔）。
#[tauri::command]
pub async fn profiles_list(state: State<'_, Core>) -> Result<Vec<ProfileView>, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.list_profiles()).await
}

/// 新建/更新档案（密码/Token 只进 OS 凭据管理器）。
#[tauri::command]
pub async fn profile_save(
    state: State<'_, Core>,
    input: ProfileInput,
) -> Result<ProfileView, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.save_profile(input)).await
}

/// 删除档案（同时关闭连接、删除系统凭据）。
#[tauri::command]
pub async fn profile_delete(state: State<'_, Core>, id: String) -> Result<bool, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.delete_profile(&id)).await
}

// ---------------------------------------------------------------------------
// 连接 / 会话
// ---------------------------------------------------------------------------

/// 用表单里的临时参数测试连接（不保存档案/秘密、不进连接池）。
#[tauri::command]
pub async fn conn_test(
    state: State<'_, Core>,
    input: ProfileInput,
) -> Result<ConnTestResult, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.test_connection(&input)).await
}

/// 惰性建连 + `/health` 探活。
#[tauri::command]
pub async fn conn_create(state: State<'_, Core>, id: String) -> Result<ConnInfo, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.connect(&id)).await
}

/// Basic 凭证登录换会话。`password = null` 时使用 keyring 里保存的秘密。
#[tauri::command]
pub async fn conn_login(
    state: State<'_, Core>,
    id: String,
    user: String,
    password: Option<String>,
) -> Result<SessionView, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.login(&id, &user, password)).await
}

/// 新鲜的健康探针（服务端版本）。
#[tauri::command]
pub async fn conn_health(state: State<'_, Core>, id: String) -> Result<String, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.health(&id)).await
}

/// 当前会话（未登录 → null）。
#[tauri::command]
pub fn conn_session(
    state: State<'_, Core>,
    id: String,
) -> Result<Option<SessionView>, StudioError> {
    state.session(&id)
}

/// 关闭连接。
#[tauri::command]
pub fn conn_close(state: State<'_, Core>, id: String) -> bool {
    state.close(&id)
}

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

/// 挂载库。
#[tauri::command]
pub async fn meta_databases(
    state: State<'_, Core>,
    id: String,
) -> Result<Vec<WireDb>, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.meta_databases(&id)).await
}

/// 表 + 列（一次 withSchema）。
#[tauri::command]
pub async fn meta_tables(
    state: State<'_, Core>,
    id: String,
) -> Result<Vec<WireTable>, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.meta_tables(&id)).await
}

/// 分区列表。
#[tauri::command]
pub async fn meta_partitions(
    state: State<'_, Core>,
    id: String,
    table: String,
) -> Result<Vec<WirePartition>, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.meta_partitions(&id, &table)).await
}

/// 设会话默认库。
#[tauri::command]
pub async fn meta_use(
    state: State<'_, Core>,
    id: String,
    database: String,
) -> Result<(), StudioError> {
    let core = state.inner().clone();
    blocking(move || core.meta_use(&id, &database)).await
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/// 执行一条 SQL（小结果整包）。
#[tauri::command]
pub async fn sql_execute(
    state: State<'_, Core>,
    id: String,
    sql: String,
    opts: QueryOptionsInput,
) -> Result<QueryResult, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.execute(&id, &sql, &opts)).await
}

/// 拆分语句（批量执行前）。
#[tauri::command]
pub fn sql_split(state: State<'_, Core>, sql: String) -> Vec<SqlStatement> {
    state.split_sql(&sql)
}

/// 取消查询（用响应回显的 queryId）。
#[tauri::command]
pub async fn sql_cancel(
    state: State<'_, Core>,
    id: String,
    query_id: String,
) -> Result<(), StudioError> {
    let core = state.inner().clone();
    blocking(move || core.cancel(&id, &query_id)).await
}

/// 流式执行：立即返回 streamId，数据走 Channel。
#[tauri::command]
pub async fn sql_stream_start(
    state: State<'_, Core>,
    id: String,
    sql: String,
    opts: QueryOptionsInput,
    on_event: Channel<StreamEvent>,
) -> Result<String, StudioError> {
    let core = state.inner().clone();
    blocking(move || {
        core.start_stream(&id, sql, &opts, move |ev| {
            // 发送失败 = 窗口关闭/结果页已释放；查询本身无需中断。
            let _ = on_event.send(ev);
        })
    })
    .await
}

/// 流式分页（按需取可视区）。
#[tauri::command]
pub async fn sql_stream_page(
    state: State<'_, Core>,
    stream_id: String,
    offset: u64,
    limit: u32,
) -> Result<StreamPage, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.stream_page(&stream_id, offset, limit as usize)).await
}

/// 停止流式查询：先 cancel（执行段），再打本地停止标记（传输段由 reader
/// 在块边界 abort 关连接）。cancel 的 404 是传输段的预期结果，不当失败。
#[tauri::command]
pub async fn sql_stream_stop(
    state: State<'_, Core>,
    id: String,
    stream_id: String,
) -> Result<(), StudioError> {
    let core = state.inner().clone();
    blocking(move || core.stop_stream(&id, &stream_id)).await
}

/// 释放流（删除磁盘 spool）。
#[tauri::command]
pub async fn sql_stream_release(
    state: State<'_, Core>,
    stream_id: String,
) -> Result<(), StudioError> {
    let core = state.inner().clone();
    blocking(move || core.stream_release(&stream_id)).await
}

/// 流式结果导出 CSV（只允许已结束的流）。
#[tauri::command]
pub async fn sql_stream_export_csv(
    state: State<'_, Core>,
    stream_id: String,
    path: String,
    bom: bool,
) -> Result<u64, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.stream_export_csv(&stream_id, &PathBuf::from(path), bom)).await
}

// ---------------------------------------------------------------------------
// 本地文件 / 历史
// ---------------------------------------------------------------------------

/// 小结果 CSV 落盘（前端拼好文本；Rust 原子写 + 可选 BOM）。
#[tauri::command]
pub async fn save_text_file(
    state: State<'_, Core>,
    path: String,
    text: String,
    bom: bool,
) -> Result<(), StudioError> {
    let core = state.inner().clone();
    blocking(move || core.save_text_file(&PathBuf::from(path), &text, bom)).await
}

/// 读取 UTF-8 文本文件（打开 .sql）。
#[tauri::command]
pub async fn read_text_file(state: State<'_, Core>, path: String) -> Result<String, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.read_text_file(&PathBuf::from(path))).await
}

/// 执行历史（新的在前，可搜索）。
#[tauri::command]
pub async fn history_list(
    state: State<'_, Core>,
    limit: u32,
    query: Option<String>,
) -> Result<Vec<HistoryEntry>, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.history_list(limit as usize, query.as_deref())).await
}

// ---------------------------------------------------------------------------
// M2 管理面（qsdb-client 十八批Ⅲ期一等方法；无裸 HTTP）
// ---------------------------------------------------------------------------

/// 运行期配置（三闸热更面板的数据源）。
#[tauri::command]
pub async fn config_get(state: State<'_, Core>, id: String) -> Result<ConfigSnapshot, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.config_get(&id)).await
}

/// 热更 runtime 配置；`applied:false` / 回显不一致必须由 UI 显式红。
#[tauri::command]
pub async fn config_put(
    state: State<'_, Core>,
    id: String,
    patch: ConfigPatch,
) -> Result<ConfigUpdateAck, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.config_put(&id, &patch)).await
}

/// 会话列表（admin）。
#[tauri::command]
pub async fn sessions_list(
    state: State<'_, Core>,
    id: String,
) -> Result<SessionsList, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.sessions_list(&id)).await
}

/// 踢会话（admin；服务端会取消其在跑查询）。
#[tauri::command]
pub async fn sessions_kick(
    state: State<'_, Core>,
    id: String,
    session_id: String,
) -> Result<KickResult, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.session_kick(&id, &session_id)).await
}

/// 运行中查询列表。
#[tauri::command]
pub async fn queries_list(state: State<'_, Core>, id: String) -> Result<QueriesList, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.queries_list(&id)).await
}

/// 提交事件长轮询；事件经 Channel 推送（`CURSOR_TOO_OLD` 由 core 对账并推 Reset）。
#[tauri::command]
pub async fn watch_start(
    state: State<'_, Core>,
    id: String,
    since: Option<u64>,
    on_event: Channel<WatchEvent>,
) -> Result<(), StudioError> {
    let core = state.inner().clone();
    blocking(move || {
        core.start_watch(&id, since, move |ev| {
            let _ = on_event.send(ev);
        })
    })
    .await
}

/// 停止 watch 循环（阻塞中的长轮询最多等一个 wait 周期）。
#[tauri::command]
pub fn watch_stop(state: State<'_, Core>, id: String) -> Result<(), StudioError> {
    state.stop_watch(&id);
    Ok(())
}

/// grants 矩阵保存（**整表替换**；全拒给 `{"*": null}`）。
#[tauri::command]
pub async fn grants_put(
    state: State<'_, Core>,
    id: String,
    user: String,
    grants: GrantsMap,
) -> Result<(), StudioError> {
    let core = state.inner().clone();
    blocking(move || core.set_grants(&id, &user, &grants)).await
}

// ---------------------------------------------------------------------------
// 收藏
// ---------------------------------------------------------------------------

/// 收藏列表（新的在前）。
#[tauri::command]
pub fn favorites_list(state: State<'_, Core>) -> Vec<Favorite> {
    state.favorites_list()
}

/// 收藏一条 SQL（同一 SQL 去重；`name = null` 取摘要）。
#[tauri::command]
pub async fn favorite_add(
    state: State<'_, Core>,
    name: Option<String>,
    sql: String,
) -> Result<Favorite, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.favorite_add(name, sql)).await
}

/// 重命名收藏。
#[tauri::command]
pub async fn favorite_rename(
    state: State<'_, Core>,
    id: String,
    name: String,
) -> Result<Favorite, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.favorite_rename(&id, &name)).await
}

/// 删除收藏。
#[tauri::command]
pub async fn favorite_remove(state: State<'_, Core>, id: String) -> Result<bool, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.favorite_remove(&id)).await
}

// ---------------------------------------------------------------------------
// 外观：背景图
// ---------------------------------------------------------------------------

/// 读本地图片为 data URL（前端用作壁纸；上限 16 MiB，格式显式校验）。
#[tauri::command]
pub async fn read_image_data_url(path: String) -> Result<String, StudioError> {
    blocking(move || qsdb_studio_core::read_image_data_url(std::path::Path::new(&path))).await
}

// ---------------------------------------------------------------------------
// M2.6 COPY 导出 / M2.7 CSV 导入 / 服务端文件下载
// ---------------------------------------------------------------------------

/// 预览 COPY SQL（纯函数；不连服务端）。
#[tauri::command]
pub fn copy_build_sql(input: CopyInput) -> Result<String, StudioError> {
    qsdb_studio_core::build_copy_sql(&input)
}

/// 执行 COPY 导出，返回回执 + 读回验证 SQL。
#[tauri::command]
pub async fn copy_to(
    state: State<'_, Core>,
    id: String,
    input: CopyInput,
) -> Result<CopyResult, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.copy_to(&id, &input)).await
}

/// 文件管理面：列目录一层（空 `dir` = 存储根；非 admin 为虚拟视图）。
#[tauri::command]
pub async fn files_list(
    state: State<'_, Core>,
    id: String,
    dir: String,
) -> Result<WireFileListing, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.files_list(&id, &dir)).await
}

/// 文件管理面：单文件/目录详情（段带列统计/归属，不读 parquet）。
#[tauri::command]
pub async fn files_detail(
    state: State<'_, Core>,
    id: String,
    path: String,
) -> Result<WireFileDetail, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.files_detail(&id, &path)).await
}

/// 文件管理面：孤儿段移入回收站（admin；被引用段服务端 409 拒绝）。
#[tauri::command]
pub async fn files_trash(
    state: State<'_, Core>,
    id: String,
    path: String,
) -> Result<WireTrashAck, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.file_trash(&id, &path)).await
}

/// 下载服务端文件（读授权；`server_path` 为库根内相对路径）。
#[tauri::command]
pub async fn download_file(
    state: State<'_, Core>,
    id: String,
    server_path: String,
    local_path: String,
) -> Result<u64, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.download_file(&id, &server_path, &PathBuf::from(local_path))).await
}

/// 预览 CSV 前 100 行（只读；返回映射/类型推断/样例校验）。
#[tauri::command]
pub async fn csv_preview(
    state: State<'_, Core>,
    id: String,
    table: String,
    path: String,
    mapping: Vec<CsvMapping>,
) -> Result<CsvPreview, StudioError> {
    let core = state.inner().clone();
    blocking(move || core.preview_csv(&id, &table, &PathBuf::from(path), &mapping)).await
}

/// 读取一条 CSV 原始记录（复制出错行；不写任何数据）。
#[tauri::command]
pub async fn csv_read_row(path: String, record_index: u64) -> Result<String, StudioError> {
    blocking(move || qsdb_studio_core::import::read_csv_row(&PathBuf::from(path), record_index))
        .await
}

/// 导入 CSV：进度经 Channel 推送，返回最终回执。
#[tauri::command]
pub async fn import_csv(
    state: State<'_, Core>,
    id: String,
    table: String,
    path: String,
    mapping: Vec<CsvMapping>,
    on_progress: Channel<ImportProgress>,
) -> Result<ImportSummary, StudioError> {
    let core = state.inner().clone();
    blocking(move || {
        core.import_csv(&id, &table, &PathBuf::from(path), &mapping, move |p| {
            let _ = on_progress.send(p);
        })
    })
    .await
}
