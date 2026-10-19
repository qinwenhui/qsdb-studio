//! M2 管理面 wire 类型（`qsdb-client` 十八批Ⅲ期一等方法）。
//!
//! 这些类型是 IPC/UI 的**稳定契约**，与 `qsdb_client::{RuntimeConfig,
//! ConfigPatch, WatchPage, AdminSession, QueryInfo, CommitEvent}` 一一对应。
//! 网络语义（401 重登、空补丁拒绝、`CURSOR_TOO_OLD` 纪律）全部在 client 里；
//! Studio 只做形状转换与 UI 需要的包装。

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use qsdb_client::{
    AdminSession, Client, CommitEvent, ConfigPutAck, Error as ClientError, QueryInfo,
};
use serde::{Deserialize, Serialize};

use crate::error::Result;

/// `GET /config` 的 runtime 节（可热更）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    /// 服务端查询超时（ms；0 = 不设）。
    pub query_timeout_ms: u64,
    /// 单查询执行内存上限（bytes；0 = 不限）。
    pub query_memory_limit_bytes: u64,
    /// 结果护栏·行数（0 = 关）。
    pub max_result_rows: u64,
    /// 结果护栏·体量（bytes；0 = 关）。
    pub max_result_bytes: u64,
}

/// `GET /config` 的启动期快照（只读）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupConfig {
    /// 扫描缓存预算（bytes）。
    pub scan_cache_bytes: u64,
    /// 回收站静默期（ms）。
    pub trash_grace_ms: u64,
    /// 溢出目录。
    #[serde(default)]
    pub spill_dir: String,
}

/// `GET /config` 的全局内存账本（实时）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryConfig {
    /// 预算（bytes；0 = 不限）。
    pub budget_bytes: u64,
    /// 执行中占用。
    pub exec_used_bytes: u64,
    /// 缓存占用。
    pub cache_used_bytes: u64,
    /// 已挤出缓存。
    pub cache_evicted_bytes: u64,
    /// 口径说明。
    #[serde(default)]
    pub note: String,
}

/// `GET /config` 的服务器级配置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    /// 并发查询上限（0 = 不限）。
    pub max_concurrent_queries: usize,
    /// 挂载库名。
    #[serde(default)]
    pub mounts: Vec<String>,
}

/// `GET /api/v1/config` 响应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    /// 热更节。
    pub runtime: RuntimeConfig,
    /// 启动期快照。
    #[serde(default)]
    pub startup: Option<StartupConfig>,
    /// 内存账本。
    #[serde(default)]
    pub memory: Option<MemoryConfig>,
    /// 服务器级。
    #[serde(default)]
    pub server: Option<ServerConfig>,
    /// 服务端提示（`_hint`）。
    #[serde(default, rename = "_hint")]
    pub hint: Option<String>,
}

/// `PUT /config` 的 patch（**只发给出的键**；拼错键服务端回 applied:false）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPatch {
    /// 查询超时（ms）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_timeout_ms: Option<u64>,
    /// 单查询内存（bytes）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_memory_limit_bytes: Option<u64>,
    /// 结果行护栏。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_result_rows: Option<u64>,
    /// 结果体量护栏。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_result_bytes: Option<u64>,
}

/// `PUT /config` 回执。`applied=false` 必须显式红（拼错键不许假成功）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigUpdateAck {
    /// 落盘后的实际值。
    pub query_timeout_ms: u64,
    /// 落盘后的实际值。
    pub query_memory_limit_bytes: u64,
    /// 落盘后的实际值。
    pub max_result_rows: u64,
    /// 落盘后的实际值。
    pub max_result_bytes: u64,
    /// 是否确实应用了至少一个已知键。
    pub applied: bool,
}

impl ConfigPatch {
    /// 一个键都没给。client 会拒绝空补丁（发出去注定 applied:false）。
    pub fn is_empty(&self) -> bool {
        self.query_timeout_ms.is_none()
            && self.query_memory_limit_bytes.is_none()
            && self.max_result_rows.is_none()
            && self.max_result_bytes.is_none()
    }
}

/// `GET /sessions` 的一行（admin 专属）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    /// 会话 id。
    pub id: String,
    /// 用户。
    pub user: String,
    /// 默认库当前角色。
    pub role: Option<String>,
    /// 客户端标识。
    #[serde(default)]
    pub client: String,
    /// 创建时间（Unix ms）。
    pub created_at_ms: u64,
    /// 最近活跃（Unix ms）。
    pub last_active_ms: u64,
    /// 空闲毫秒。
    pub idle_ms: u64,
    /// 默认库。
    pub default_db: String,
    /// 在跑查询 id。
    #[serde(default)]
    pub running_queries: Vec<String>,
    /// 累计查询数。
    pub queries_total: u64,
    /// 累计写入行数。
    pub rows_written: u64,
}

/// `GET /sessions` 响应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsList {
    /// 会话。
    pub sessions: Vec<StoredSession>,
    /// 条数。
    pub count: usize,
}

/// `DELETE /sessions/{id}` 回执。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KickResult {
    /// 被踢会话 id（服务端回显，不是计数）。
    pub kicked: String,
    /// 一并取消的查询**数**。
    pub cancelled_queries: u64,
}

/// `GET /queries` 的一行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredQuery {
    /// query id（取消用）。
    pub id: String,
    /// SQL。
    pub sql: String,
    /// 已运行时长（ms）。
    pub elapsed_ms: u64,
    /// 执行内存（bytes）。
    pub memory_bytes: u64,
    /// 是否已请求取消。
    pub cancelled: bool,
    /// 所属会话（匿名/静态凭证 = null）。
    pub session_id: Option<String>,
}

/// `GET /queries` 响应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueriesList {
    /// 运行中的查询。
    pub queries: Vec<StoredQuery>,
    /// 条数。
    pub count: usize,
}

/// `GET /watch` 的一个提交事件（也是推给 UI 的时间线条目）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    /// 库（多挂载；旧服务端可能为空串）。
    #[serde(default)]
    pub database: String,
    /// 表。
    pub table: String,
    /// 分区值（client 已解码；非分区表为空数组）。
    #[serde(default)]
    pub partition: Vec<String>,
    /// 新 generation。
    pub generation: u64,
    /// `Append` / `Overwrite` / `Clear`；**`Reset` 是 Studio 的对账事件**
    /// （400/409 `CURSOR_TOO_OLD` 后全量对账一次 + 从当前游标续订）。
    pub kind: String,
    /// 对账/错误事件的人读说明（正常提交事件为 null）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl WatchEvent {
    /// `CURSOR_TOO_OLD` 后的对账事件。
    pub fn reset(message: impl Into<String>) -> Self {
        Self {
            database: String::new(),
            table: String::new(),
            partition: Vec::new(),
            generation: 0,
            kind: "Reset".into(),
            message: Some(message.into()),
        }
    }

    /// watch 循环自身失败（停止循环，UI 明示）。
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            kind: "Error".into(),
            message: Some(message.into()),
            ..Self::reset("")
        }
    }

    /// 瞬时状态（例如服务端重启导致的连接中断，正在重连）。
    /// **不停止循环**；UI 显示状态条，拿到下一批事件/对账后自动清除。
    pub fn status(message: impl Into<String>) -> Self {
        Self {
            kind: "Status".into(),
            message: Some(message.into()),
            ..Self::reset("")
        }
    }
}

impl From<CommitEvent> for WatchEvent {
    fn from(e: CommitEvent) -> Self {
        Self {
            database: e.database,
            table: e.table,
            partition: e.partition,
            generation: e.generation,
            kind: e.kind,
            message: None,
        }
    }
}

/// `GET /watch` 的一页。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchBatch {
    /// 事件。
    pub events: Vec<WatchEvent>,
    /// 下一游标。
    pub next: u64,
    /// 是否还有积压（立刻用 `next` 再拉）。
    pub more: bool,
}

/// grants 矩阵：库名（或 `*`）→ 角色名 / `null`（显式无权）。
///
/// **整表替换语义**：PUT 时没给出的库 = 被移除；全拒给 `{"*": None}`。
pub type GrantsMap = BTreeMap<String, Option<String>>;

// ---------------------------------------------------------------------------
// client → wire 转换
// ---------------------------------------------------------------------------

impl From<ConfigPutAck> for ConfigUpdateAck {
    fn from(a: ConfigPutAck) -> Self {
        Self {
            query_timeout_ms: a.query_timeout_ms,
            query_memory_limit_bytes: a.query_memory_limit_bytes,
            max_result_rows: a.max_result_rows,
            max_result_bytes: a.max_result_bytes,
            applied: a.applied,
        }
    }
}

impl From<AdminSession> for StoredSession {
    fn from(s: AdminSession) -> Self {
        Self {
            id: s.id,
            user: s.user,
            role: s.role,
            client: s.client,
            created_at_ms: s.created_at_ms,
            last_active_ms: s.last_active_ms,
            idle_ms: s.idle_ms,
            default_db: s.default_db,
            running_queries: s.running_queries,
            queries_total: s.queries_total,
            rows_written: s.rows_written,
        }
    }
}

impl From<QueryInfo> for StoredQuery {
    fn from(q: QueryInfo) -> Self {
        Self {
            id: q.id,
            sql: q.sql,
            elapsed_ms: q.elapsed_ms,
            memory_bytes: q.memory_bytes,
            cancelled: q.cancelled,
            session_id: q.session_id,
        }
    }
}

// ---------------------------------------------------------------------------
// watch 长轮询循环（使用**独立** Client，避免长轮询占住主连接的请求串行锁）
// ---------------------------------------------------------------------------

/// watch 的长轮询等待；不设 25s 是为了 `watch_stop` 能在几秒内收尾。
const WATCH_WAIT: Duration = Duration::from_secs(5);

/// 循环拉取提交事件，直到 stop 置位或遇到非 `CURSOR_TOO_OLD` 错误。
///
/// 两条契约纪律（client rustdoc 写死）：
/// 1. `more == true` ⇒ 立刻用 `next` 再拉；
/// 2. `CURSOR_TOO_OLD` ⇒ **一次全量对账**（库/表/分区），再从**当前**续订；
///    原游标永远不会好。对账后从当前开始（client 的 409 错误不暴露新 next）。
pub(crate) fn run_watch(
    client: Arc<Client>,
    mut since: Option<u64>,
    stop: Arc<AtomicBool>,
    emit: impl Fn(WatchEvent),
) {
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        match client.watch(since, WATCH_WAIT) {
            Ok(page) => {
                for e in page.events {
                    emit(e.into());
                }
                since = Some(page.next);
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                // more=true：还有积压，立刻续拉（下一轮不等待）。
                if page.more {
                    continue;
                }
            }
            Err(ClientError::Api { code, .. }) if code == "CURSOR_TOO_OLD" => {
                match reconcile(&client) {
                    Ok(msg) => {
                        emit(WatchEvent::reset(msg));
                        since = None; // 从当前开始
                    }
                    Err(e) => {
                        emit(WatchEvent::error(format!("游标重置后的全量对账失败: {e}")));
                        return;
                    }
                }
            }
            Err(e) if e.retriable() => {
                // 服务端重启 / 网络瞬断：原 since 可能是**新进程**里的旧游标，
                // 下一轮会得到 CURSOR_TOO_OLD 并走对账；这里先退避重试，
                // 不把可恢复的传输错误当成终止（事件加速器要能自己接上）。
                emit(WatchEvent::status(format!(
                    "watch 连接中断（{e}），正在重连…"
                )));
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
            Err(e) => {
                emit(WatchEvent::error(e.to_string()));
                return;
            }
        }
    }
}

/// 全量对账：库 + 表（含列）+ 每表分区。只读，不改变任何状态。
fn reconcile(client: &Client) -> Result<String> {
    let dbs = client.databases()?;
    let tables = client.tables_with_schema()?;
    let mut parts = 0usize;
    for t in &tables {
        parts += client.partitions(&t.name)?.len();
    }
    Ok(format!(
        "游标已重置：已全量对账（{} 库 / {} 表 / {} 分区），之后从当前游标续订",
        dbs.len(),
        tables.len(),
        parts
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_sample_parses_contract_keys() {
        let raw = r#"{
            "runtime": {
                "queryTimeoutMs": 1000,
                "queryMemoryLimitBytes": 4294967296,
                "maxResultRows": 100000,
                "maxResultBytes": 0
            },
            "startup": {"scanCacheBytes": 1, "trashGraceMs": 2, "spillDir": "x"},
            "memory": {"budgetBytes": 3, "execUsedBytes": 4, "cacheUsedBytes": 5, "cacheEvictedBytes": 6, "note": "n"},
            "server": {"maxConcurrentQueries": 0, "mounts": ["default"]},
            "_hint": "h"
        }"#;
        let c: ConfigSnapshot = serde_json::from_str(raw).unwrap();
        assert_eq!(c.runtime.max_result_rows, 100000);
        assert_eq!(c.startup.unwrap().scan_cache_bytes, 1);
        assert_eq!(c.server.unwrap().mounts, vec!["default"]);
        assert_eq!(c.hint.as_deref(), Some("h"));
    }

    #[test]
    fn sessions_queries_watch_samples_parse() {
        let s: SessionsList = serde_json::from_str(
            r#"{"sessions":[{"id":"s1","user":"admin","role":"admin","client":"studio","createdAtMs":1,"lastActiveMs":2,"idleMs":3,"defaultDb":"default","runningQueries":["q1"],"queriesTotal":4,"rowsWritten":5}],"count":1}"#,
        )
        .unwrap();
        assert_eq!(s.sessions[0].running_queries, vec!["q1"]);

        let q: QueriesList = serde_json::from_str(
            r#"{"queries":[{"id":"q1","sql":"SELECT 1","elapsedMs":10,"memoryBytes":20,"cancelled":false,"sessionId":null}],"count":1}"#,
        )
        .unwrap();
        assert_eq!(q.queries[0].sql, "SELECT 1");

        let w: WatchBatch = serde_json::from_str(
            r#"{"events":[{"database":"default","table":"t","partition":["2026-01-01"],"generation":7,"kind":"Append"}],"next":9,"more":false}"#,
        )
        .unwrap();
        assert_eq!(w.events[0].generation, 7);
        assert_eq!(w.next, 9);
    }

    #[test]
    fn config_patch_omits_none_keys() {
        let p = ConfigPatch {
            max_result_rows: Some(10),
            ..Default::default()
        };
        let j = serde_json::to_string(&p).unwrap();
        assert_eq!(j, r#"{"maxResultRows":10}"#);
    }

    #[test]
    fn reset_and_error_events_are_explicit() {
        let r = WatchEvent::reset("游标已重置");
        assert_eq!(r.kind, "Reset");
        assert_eq!(r.message.as_deref(), Some("游标已重置"));
        let e = WatchEvent::error("boom");
        assert_eq!(e.kind, "Error");
        assert_eq!(e.message.as_deref(), Some("boom"));
    }
}
