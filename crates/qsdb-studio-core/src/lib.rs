//! # qsdb-studio-core
//!
//! QSDB Studio 的**全部业务逻辑**（不依赖 Tauri，可独立单测）：
//! 连接档案 + OS 凭据、连接池、SQL 执行、流式结果 spool、历史、CSV。
//!
//! 壳层（`src-tauri`）只做参数转发与错误映射；协议语义只在
//! `qsdb-client`（唯一网络出口）与这里消化一次。

pub mod admin;
pub mod copy;
pub mod error;
pub mod favorites;
pub mod files;
pub mod history;
pub mod import;
pub mod io_csv;
pub mod io_image;
pub mod pool;
pub mod profile;
pub mod query;
pub mod stream;
pub mod wire;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use qsdb_client::{AbortHandle, Auth, Client, SessionInfo};

pub use crate::admin::{
    ConfigPatch, ConfigSnapshot, ConfigUpdateAck, GrantsMap, KickResult, QueriesList,
    RuntimeConfig, ServerConfig, SessionsList, StartupConfig, StoredQuery, StoredSession,
    WatchBatch, WatchEvent,
};
pub use crate::copy::{CopyFormat, CopyInput, CopyResult, build_copy_sql, verify_sql};
pub use crate::error::{Result, StudioError};
pub use crate::favorites::{Favorite, FavoritesStore};
pub use crate::files::{
    WireDirSummary, WireFileColumnStat, WireFileDetail, WireFileEntry, WireFileListing,
    WireFileMount, WireFileSegment, WireManifestDetail, WireTrashAck,
};
pub use crate::history::HistoryEntry;
pub use crate::import::{
    CsvMapping, CsvPreview, CsvPreviewColumn, CsvPreviewError, CsvPreviewRow, ImportProgress,
    ImportSummary,
};
pub use crate::io_image::read_image_data_url;
pub use crate::pool::ConnPool;
pub use crate::profile::{
    KeyringSecretStore, MemorySecretStore, Profile, ProfileAuth, ProfileInput, ProfileStore,
    ProfileView, SecretStore,
};
pub use crate::query::{
    ParamInput, QueryOptionsInput, QueryResult, SqlStatement, split_statements,
};
pub use crate::stream::{StreamEvent, StreamPage, StreamStore};
pub use crate::wire::{WireColumn, WireColumnInfo, WireDb, WirePartition, WireTable};

/// keyring 服务名（系统凭据管理器里的命名空间）。
pub const KEYRING_SERVICE: &str = "qsdb-studio";

/// 一次连接的握手信息。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnInfo {
    /// 档案 id（也是连接 id）。
    pub profile_id: String,
    /// 连接名。
    pub profile_name: String,
    /// 服务地址。
    pub url: String,
    /// 服务端版本（`/health`）。
    pub version: String,
    /// 认证方式（**不含任何秘密**）。
    pub auth: ProfileAuth,
}

/// 会话身份（登录后的展示面；**不含 token**）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    /// 会话 id（审计/踢人用）。
    pub session_id: String,
    /// 用户。
    pub user: String,
    /// 登录时默认库的角色快照。
    pub role: Option<String>,
    /// grants 摘要（自查用，不泄密）。
    pub grants: serde_json::Value,
    /// 会话默认库。
    pub default_db: String,
}

impl From<SessionInfo> for SessionView {
    fn from(s: SessionInfo) -> Self {
        Self {
            session_id: s.session_id,
            user: s.user,
            role: s.role,
            grants: s.grants,
            default_db: s.default_db,
        }
    }
}

/// 连接测试结果（**不落盘、不进连接池**）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnTestResult {
    /// `/health` 返回的服务端版本。
    pub version: String,
    /// Basic 登录后的用户；匿名/Token 为 `None`。
    pub user: Option<String>,
    /// Basic 登录后的角色。
    pub role: Option<String>,
    /// 会话默认库（Basic 且填写/登录成功时）。
    pub default_db: Option<String>,
    /// 非致命的测试说明（匿名无身份、Token 无库授权等）。
    pub warnings: Vec<String>,
    /// 整条测试链路耗时（含网络）。
    pub elapsed_ms: f64,
}

/// Studio 业务核心。
pub struct StudioCore {
    /// 连接档案。
    pub profiles: ProfileStore,
    /// 打开的连接。
    pub pool: ConnPool,
    /// 管理面用的**独立连接**（sessions/queries/config/grants）。
    ///
    /// `Client` 内部一条 keep-alive 连接上的请求串行；长查询会占住主连接，
    /// 而 ops 面板要一边跑查询一边轮询 `/queries`。因此管理面用第二条连接，
    /// 与主查询互不阻塞（watch 又另起一条，见 `start_watch`）。
    admin_pool: ConnPool,
    /// 执行历史。
    pub history: history::HistoryStore,
    /// SQL 收藏。
    pub favorites: favorites::FavoritesStore,
    /// 流式结果注册表。
    pub streams: Arc<StreamStore>,
    /// 运行中普通查询的并发中止句柄。
    ///
    /// key = `(profile_id, 请求时生成的 query_id)`。普通查询没有 RowStream，
    /// 传输段只能靠 handle 关 socket；执行段仍走服务端 cancel。
    aborts: Mutex<HashMap<(String, String), AbortHandle>>,
    secrets: Arc<dyn SecretStore>,
    /// watch 循环的停止标志（每个连接至多一条 watch）。
    watches: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl StudioCore {
    /// 打开（数据目录 = Tauri app-data 目录）。
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_secrets(data_dir, Arc::new(KeyringSecretStore::new(KEYRING_SERVICE)))
    }

    /// 打开并注入秘密存储（单测用内存实现）。
    pub fn open_with_secrets(
        data_dir: impl AsRef<Path>,
        secrets: Arc<dyn SecretStore>,
    ) -> Result<Self> {
        let dir = data_dir.as_ref();
        std::fs::create_dir_all(dir).map_err(|e| {
            StudioError::storage(format!("创建应用数据目录 {} 失败: {e}", dir.display()))
        })?;
        Ok(Self {
            profiles: ProfileStore::open(dir.join("connections.json"))?,
            pool: ConnPool::new(),
            admin_pool: ConnPool::new(),
            history: history::HistoryStore::open(dir.join("history.jsonl"))?,
            favorites: favorites::FavoritesStore::open(dir.join("favorites.json"))?,
            streams: Arc::new(StreamStore::new(dir.join("streams"))?),
            aborts: Mutex::new(HashMap::new()),
            secrets,
            watches: Mutex::new(HashMap::new()),
        })
    }

    // ------------------------------------------------------------------
    // 档案
    // ------------------------------------------------------------------

    /// 全部档案（带 `has_secret`；秘密本身永不返回）。
    pub fn list_profiles(&self) -> Result<Vec<ProfileView>> {
        self.profiles
            .list()
            .iter()
            .map(|p| self.profile_view(p))
            .collect()
    }

    /// 保存档案。
    ///
    /// 规则（**不静默**）：
    /// - 认证方式需要秘密时，必须已有或本次提供秘密，否则拒绝保存；
    /// - 认证身份（Basic 用户名 / Bearer）改变时，旧秘密作废——绝不复用旧密码
    ///   当新 Token。
    pub fn save_profile(&self, input: ProfileInput) -> Result<ProfileView> {
        let id = input
            .id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| profile::new_id("p"));
        let old = self.profiles.get(&id);
        // 秘密**不 trim**：首尾空格可能是密码/Token 的一部分。
        let provided = input.secret.as_deref().filter(|s| !s.is_empty());
        let existing = self.secrets.get(&id)?;

        let same_identity = match (&old, &input.auth) {
            (Some(o), a) => match (&o.auth, a) {
                (ProfileAuth::Basic { user: a }, ProfileAuth::Basic { user: b }) => {
                    a.trim() == b.trim()
                }
                (ProfileAuth::Bearer, ProfileAuth::Bearer)
                | (ProfileAuth::None, ProfileAuth::None) => true,
                _ => false,
            },
            (None, _) => false,
        };
        let needs_secret = !matches!(input.auth, ProfileAuth::None);
        let keep_existing = same_identity && existing.is_some();
        if needs_secret && provided.is_none() && !keep_existing {
            let what = if matches!(input.auth, ProfileAuth::Bearer) {
                "Token"
            } else {
                "密码"
            };
            return Err(StudioError::usage(format!(
                "请填写{what}：它只会保存到系统凭据管理器，不会写入档案文件"
            )));
        }
        if !same_identity && existing.is_some() {
            // 身份变了：先删旧秘密，避免复用（例如把旧密码当成 Bearer token）。
            self.secrets.delete(&id)?;
        }
        if let Some(secret) = provided {
            self.secrets.set(&id, secret)?;
        }

        let mut input = input;
        input.id = Some(id);
        let profile = self.profiles.upsert(input)?;
        self.profile_view(&profile)
    }

    /// 删除档案（同时关闭连接、删除 keyring 里的秘密）。
    pub fn delete_profile(&self, id: &str) -> Result<bool> {
        let existed = self.profiles.remove(id)?;
        self.stop_watch(id);
        self.abort_queries_of(id);
        self.admin_pool.remove(id);
        self.pool.remove(id);
        if existed {
            self.secrets.delete(id)?;
        }
        Ok(existed)
    }

    fn profile_view(&self, p: &Profile) -> Result<ProfileView> {
        Ok(p.view(self.secrets.get(&p.id)?.is_some()))
    }

    fn get_profile(&self, id: &str) -> Result<Profile> {
        self.profiles
            .get(id)
            .ok_or_else(|| StudioError::usage(format!("连接档案 '{id}' 不存在")))
    }

    // ------------------------------------------------------------------
    // 连接 / 会话
    // ------------------------------------------------------------------

    /// 惰性建连并探活（`/health`）。失败不会留下半开的连接。
    pub fn connect(&self, profile_id: &str) -> Result<ConnInfo> {
        let profile = self.get_profile(profile_id)?;
        let auth = self.auth_for(&profile)?;
        // 第二条连接只给管理面；惰性建连（第一次 ops 轮询才握手）。
        let admin = Client::connect(&profile.url, auth.clone())?;
        let client = Client::connect(&profile.url, auth)?;
        let version = client.health()?;
        self.pool.insert(profile.id.clone(), Arc::new(client));
        self.admin_pool.insert(profile.id.clone(), Arc::new(admin));
        Ok(ConnInfo {
            profile_id: profile.id,
            profile_name: profile.name,
            url: profile.url,
            version,
            auth: profile.auth,
        })
    }

    /// 档案 → client 认证（secret 只来自 keyring/进程内，不落日志）。
    fn auth_for(&self, profile: &Profile) -> Result<Auth> {
        Ok(match &profile.auth {
            ProfileAuth::None => Auth::None,
            ProfileAuth::Basic { user } => {
                let password = self
                    .secrets
                    .get(&profile.id)?
                    .ok_or_else(|| StudioError::missing_secret("密码"))?;
                Auth::Basic {
                    user: user.clone(),
                    password,
                }
            }
            ProfileAuth::Bearer => {
                let token = self
                    .secrets
                    .get(&profile.id)?
                    .ok_or_else(|| StudioError::missing_secret("Token"))?;
                Auth::Bearer(token)
            }
        })
    }

    /// 健康探针（已连接时的新鲜版本号）。
    pub fn health(&self, profile_id: &str) -> Result<String> {
        self.pool.get(profile_id)?.health().map_err(Into::into)
    }

    /// 用**表单里的临时参数**测试连接（不保存档案/秘密，也不进连接池）。
    ///
    /// - 匿名：`/health` 可达性；
    /// - Basic：`login` 校验用户名/密码（成功即建立一次临时会话），
    ///   默认库若填写则一并 `USE` 验证；
    /// - Bearer：`/health` + `/databases` 校验 Token；403 表示 Token 有效但
    ///   无库授权（成功 + warning），401 原样报错。
    pub fn test_connection(&self, input: &ProfileInput) -> Result<ConnTestResult> {
        let url = input.url.trim();
        if url.is_empty() {
            return Err(StudioError::usage("服务地址不能为空"));
        }
        let started = Instant::now();
        let mut warnings = Vec::new();

        let (version, user, role, default_db) = match &input.auth {
            ProfileAuth::None => {
                let client = Client::connect(url, Auth::None)?;
                let version = client.health()?;
                if input
                    .default_database
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|s| !s.is_empty())
                {
                    warnings
                        .push("匿名连接没有会话，默认库不会生效（请用 db.table 限定名）".into());
                }
                warnings.push("匿名连接：只验证服务可达与版本，没有身份可校验".into());
                (version, None, None, None)
            }
            ProfileAuth::Basic { user } => {
                let user = user.trim();
                if user.is_empty() {
                    return Err(StudioError::usage("Basic 认证需要用户名"));
                }
                let secret = self.test_secret(input, "密码")?;
                let client = Client::connect(
                    url,
                    Auth::Basic {
                        user: user.to_string(),
                        password: secret.clone(),
                    },
                )?;
                let version = client.health()?;
                let session = client.login(user, &secret)?;
                let mut default_db = session.default_db.clone();
                if let Some(db) = input
                    .default_database
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    if db != session.default_db {
                        client.use_database(db)?;
                    }
                    default_db = db.to_string();
                }
                (version, Some(session.user), session.role, Some(default_db))
            }
            ProfileAuth::Bearer => {
                let token = self.test_secret(input, "Token")?;
                let client = Client::connect(url, Auth::Bearer(token))?;
                let version = client.health()?;
                match client.databases() {
                    Ok(_) => {}
                    Err(qsdb_client::Error::Api { status, code, .. })
                        if status == 403 || code == "FORBIDDEN" =>
                    {
                        warnings
                            .push("Token 已通过验证，但当前无权读取库列表（403 FORBIDDEN）".into());
                    }
                    Err(e) => return Err(e.into()),
                }
                if input
                    .default_database
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|s| !s.is_empty())
                {
                    warnings
                        .push("静态 Token 没有会话，默认库不会生效（请用 db.table 限定名）".into());
                }
                (version, None, None, None)
            }
        };

        Ok(ConnTestResult {
            version,
            user,
            role,
            default_db,
            warnings,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// 测试连接用的秘密：表单里填了就用表单值；否则仅当**认证身份未变**时
    /// 才从 keyring 取旧秘密（与保存规则一致，绝不复用旧密码给新身份）。
    fn test_secret(&self, input: &ProfileInput, what: &str) -> Result<String> {
        if let Some(s) = input.secret.as_deref().filter(|s| !s.is_empty()) {
            return Ok(s.to_string());
        }
        if let Some(id) = input.id.as_deref().map(str::trim).filter(|s| !s.is_empty())
            && let Some(old) = self.profiles.get(id)
        {
            let same_identity = match (&old.auth, &input.auth) {
                (ProfileAuth::Basic { user: a }, ProfileAuth::Basic { user: b }) => {
                    a.trim() == b.trim()
                }
                (ProfileAuth::Bearer, ProfileAuth::Bearer) => true,
                _ => false,
            };
            if !same_identity {
                return Err(StudioError::usage(format!(
                    "认证身份已变更：请填写新的{what}后测试（测试不会保存它）"
                )));
            }
            return match self.secrets.get(id)? {
                Some(s) => Ok(s),
                None => Err(StudioError::usage(format!(
                    "档案没有保存{what}：请填写后测试（测试不会保存它）"
                ))),
            };
        }
        Err(StudioError::usage(format!(
            "请填写{what}后测试（测试不会保存它）"
        )))
    }

    /// 登录换会话（Basic 凭证）。`password` 为空时用 keyring 里保存的秘密。
    ///
    /// 登录成功后若档案配了默认库，会显式 `USE`；失败原样报错（不悄悄忽略）。
    pub fn login(
        &self,
        profile_id: &str,
        user: &str,
        password: Option<String>,
    ) -> Result<SessionView> {
        let profile = self.get_profile(profile_id)?;
        let user = user.trim();
        if user.is_empty() {
            return Err(StudioError::usage("登录用户名不能为空"));
        }
        // 秘密**不 trim**：首尾空格可能是密码的一部分。
        let provided = password
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let secret = match provided.clone() {
            Some(p) => p,
            None => self
                .secrets
                .get(&profile.id)?
                .ok_or_else(|| StudioError::missing_secret("密码"))?,
        };
        let client = self.pool.get(profile_id)?;
        client.login(user, &secret)?;
        if let Some(db) = profile.default_database.as_deref() {
            let current = client.session().map(|s| s.default_db).unwrap_or_default();
            if current != db {
                client.use_database(db)?;
            }
        }
        // 用户本次手动输入的密码且身份一致：保存到 keyring（下次免输入）。
        if let Some(p) = provided
            && let ProfileAuth::Basic { user: pu } = &profile.auth
            && pu.trim() == user
        {
            self.secrets.set(&profile.id, &p)?;
        }
        let info = client
            .session()
            .ok_or_else(|| StudioError::internal("登录成功但客户端没有会话态"))?;
        Ok(info.into())
    }

    /// 当前会话（未登录 → `None`）。
    pub fn session(&self, profile_id: &str) -> Result<Option<SessionView>> {
        Ok(self.pool.get(profile_id)?.session().map(Into::into))
    }

    /// 关闭连接（会话随之释放；watch 循环一并停止）。
    pub fn close(&self, profile_id: &str) -> bool {
        self.stop_watch(profile_id);
        self.abort_queries_of(profile_id);
        self.admin_pool.remove(profile_id);
        self.pool.remove(profile_id)
    }

    /// 中止某档案名下所有仍在传输的普通查询（断开连接时调用）。
    fn abort_queries_of(&self, profile_id: &str) {
        let handles: Vec<AbortHandle> = {
            let mut map = self.aborts.lock().unwrap_or_else(|e| e.into_inner());
            let keys: Vec<_> = map
                .keys()
                .filter(|(pid, _)| pid == profile_id)
                .cloned()
                .collect();
            keys.into_iter().filter_map(|k| map.remove(&k)).collect()
        };
        for h in handles {
            h.abort();
        }
    }

    // ------------------------------------------------------------------
    // 元数据
    // ------------------------------------------------------------------

    /// 挂载库（只读库带 `readOnly`）。
    pub fn meta_databases(&self, profile_id: &str) -> Result<Vec<WireDb>> {
        let client = self.pool.get(profile_id)?;
        Ok(client
            .databases()?
            .into_iter()
            .map(|d| WireDb {
                name: d.name,
                read_only: d.read_only,
            })
            .collect())
    }

    /// 表 + 列（一次 withSchema，禁止 N+1）。
    ///
    /// 空实例的 `{"tables":[]}` 歧义由 qsdb-client `a5cc697` 修复
    /// （untagged 的 Detailed 形态优先），这里不再做二次探测。
    pub fn meta_tables(&self, profile_id: &str) -> Result<Vec<WireTable>> {
        let client = self.pool.get(profile_id)?;
        let tables = client.tables_with_schema()?;
        Ok(tables
            .into_iter()
            .map(|t| WireTable {
                name: t.name,
                columns: t
                    .columns
                    .into_iter()
                    .map(|c| WireColumnInfo {
                        name: c.name,
                        type_name: c.type_name,
                        nullable: c.nullable,
                        partition: c.partition,
                    })
                    .collect(),
            })
            .collect())
    }

    /// 分区列表（generation/rows/segments/bytes）。
    pub fn meta_partitions(&self, profile_id: &str, table: &str) -> Result<Vec<WirePartition>> {
        let client = self.pool.get(profile_id)?;
        Ok(client
            .partitions(table)?
            .into_iter()
            .map(|p| WirePartition {
                name: p.name,
                generation: p.generation,
                rows: p.rows,
                segments: p.segments,
                bytes: p.bytes,
            })
            .collect())
    }

    /// 设会话默认库（需要先登录）。
    pub fn meta_use(&self, profile_id: &str, database: &str) -> Result<()> {
        self.pool.get(profile_id)?.use_database(database)?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // 文件管理面（内核二十批）
    // ------------------------------------------------------------------

    /// 浏览存储目录一层（`GET /files/list`）。
    ///
    /// 走**管理面连接**：主连接可能被长查询占住（`Client` 请求串行），
    /// 文件树不该等查询跑完。空目录 = 存储根；非 admin 得到只含自己
    /// 有 grant 的挂载的虚拟视图。段文件带 manifest 摘要（行数/字节/引用）。
    pub fn files_list(&self, profile_id: &str, dir: &str) -> Result<files::WireFileListing> {
        Ok(self.admin_pool.get(profile_id)?.files_list(dir)?.into())
    }

    /// 单文件/目录详情（`GET /files/detail`）：归属库/表/分区、段列统计、
    /// manifest 详情与单文件预览 SQL。**不下载文件**。
    pub fn files_detail(&self, profile_id: &str, path: &str) -> Result<files::WireFileDetail> {
        Ok(self.admin_pool.get(profile_id)?.files_detail(path)?.into())
    }

    /// 把**未引用的段文件**移入回收站（`POST /files/trash`，admin 专属）。
    ///
    /// 只收 `seg_*.parquet`；被存活 manifest 引用的段由服务端以 409
    /// `SEGMENT_REFERENCED` 拒绝（删被引用段 = 毁表）。成功 = 进 `_trash`
    /// （静默期内可用 `admin trash restore` 恢复），不是直接 unlink。
    /// 只读档案在发请求前显式拒绝。
    pub fn file_trash(&self, profile_id: &str, path: &str) -> Result<files::WireTrashAck> {
        let profile = self.get_profile(profile_id)?;
        if profile.read_only {
            return Err(read_only_error(&profile, "移入回收站会删除服务端文件"));
        }
        Ok(self.admin_pool.get(profile_id)?.file_trash(path)?.into())
    }

    // ------------------------------------------------------------------
    // SQL
    // ------------------------------------------------------------------

    /// 执行一条 SQL（bulk 整包；只读语句可显式回退 rows）。
    pub fn execute(
        &self,
        profile_id: &str,
        sql: &str,
        opts: &QueryOptionsInput,
    ) -> Result<QueryResult> {
        let profile = self.get_profile(profile_id)?;
        guard_read_only(&profile, sql)?;
        let client = self.pool.get(profile_id)?;
        let started = Instant::now();
        // 自动分页会在 SQL 末尾补 LIMIT/OFFSET；历史仍记录用户原始语句。
        let history_sql = opts
            .history_sql
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(sql);

        // 普通查询的传输段停止句柄。只对**只读语句**注册：写语句可能已经提交，
        // 传输段断连接会让 UI 误以为“已取消”，写入结果反而未知；写语句仍只
        // 走执行段的服务端 cancel。没有 query id 的内部查询保持原行为。
        let abort_key = opts
            .query_id
            .as_ref()
            .filter(|_| query::is_read_only_sql(sql))
            .map(|q| (profile.id.clone(), q.clone()));
        let abort = abort_key.as_ref().map(|_| AbortHandle::new());
        if let (Some(k), Some(a)) = (abort_key.as_ref(), abort.as_ref()) {
            self.aborts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(k.clone(), a.clone());
        }

        let result = query::execute(&client, sql, opts, abort.as_ref());

        if let Some(k) = abort_key.as_ref() {
            self.aborts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(k);
        }

        // socket 被 cancel 关掉时 client 只会看到 IO 错误；结合句柄状态
        // 归为“用户取消”，不把主动停止显示成查询失败。
        let result = match result {
            Err(_) if abort.as_ref().is_some_and(|a| a.is_aborted()) => Err(
                StudioError::cancelled("已停止接收查询结果（连接已断开）；本次没有完整结果"),
            ),
            other => other,
        };

        match result {
            Ok(mut r) => {
                if !opts.skip_history {
                    let rows = r.rows_affected.unwrap_or(r.row_count);
                    let entry = history::ok_entry(
                        &profile.id,
                        &profile.name,
                        history_sql,
                        r.elapsed_ms,
                        rows,
                        r.query_id.clone(),
                    );
                    if let Err(e) = self.history.append(&entry) {
                        r.warnings
                            .push(format!("执行历史写入失败（不影响本次结果）: {}", e.message));
                    }
                }
                Ok(r)
            }
            Err(e) => {
                if !opts.skip_history {
                    let entry = history::err_entry(
                        &profile.id,
                        &profile.name,
                        history_sql,
                        started.elapsed().as_secs_f64() * 1000.0,
                        e.code.clone(),
                    );
                    // 历史是辅助数据：写失败不覆盖真正的查询错误。
                    let _ = self.history.append(&entry);
                }
                Err(e)
            }
        }
    }

    /// 取消普通查询（用请求时生成的 queryId）。
    ///
    /// 两段语义：
    /// - **执行段**：走管理面连接 `cancel`（主连接被长查询占住，不能自己取消）；
    /// - **传输段**：服务端已注销（cancel 404），这里先取走并 abort 本地
    ///   `AbortHandle`——关 socket，正在读响应的执行线程立即返回。
    ///
    /// 本地句柄存在时，服务端 cancel 的任何失败都不上抛（404 是传输段预期）；
    /// 没有本地句柄（例如取消别的客户端/纯服务端条目）保持原来的错误口径。
    pub fn cancel(&self, profile_id: &str, query_id: &str) -> Result<()> {
        let local = self
            .aborts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&(profile_id.to_string(), query_id.to_string()));
        let had_local = local.is_some();
        if let Some(h) = local {
            h.abort();
        }
        let client = match self.admin_pool.get(profile_id) {
            Ok(c) => c,
            Err(_) if had_local => return Ok(()),
            Err(e) => return Err(e),
        };
        match query::cancel(&client, query_id) {
            Ok(()) => Ok(()),
            Err(_) if had_local => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// 拆分 SQL（批量执行用）。
    pub fn split_sql(&self, sql: &str) -> Vec<SqlStatement> {
        split_statements(sql)
    }

    /// 历史列表。
    pub fn history_list(&self, limit: usize, query: Option<&str>) -> Result<Vec<HistoryEntry>> {
        self.history.list(limit, query)
    }

    /// 收藏列表（新的在前）。
    pub fn favorites_list(&self) -> Vec<Favorite> {
        self.favorites.list()
    }

    /// 收藏一条 SQL（同名 SQL 去重）。
    pub fn favorite_add(&self, name: Option<String>, sql: String) -> Result<Favorite> {
        self.favorites.add(name.as_deref(), &sql)
    }

    /// 重命名收藏（保留 SQL 与收藏时间）。
    pub fn favorite_rename(&self, id: &str, name: &str) -> Result<Favorite> {
        self.favorites.rename(id, name)
    }

    /// 删除收藏。
    pub fn favorite_remove(&self, id: &str) -> Result<bool> {
        self.favorites.remove(id)
    }

    // ------------------------------------------------------------------
    // CSV 导入 / COPY 导出
    // ------------------------------------------------------------------

    /// 预览 CSV 前 100 行（schema 来自 `/schema`；只读，不写数据）。
    pub fn preview_csv(
        &self,
        profile_id: &str,
        table: &str,
        path: &Path,
        mappings: &[CsvMapping],
    ) -> Result<CsvPreview> {
        let client = self.pool.get(profile_id)?;
        import::preview_csv(&client, table, path, mappings)
    }

    /// 导入 CSV（schema 来自 `/schema`；逐格严格解析；bulk append 分批写入）。
    pub fn import_csv<F>(
        &self,
        profile_id: &str,
        table: &str,
        path: &Path,
        mappings: &[CsvMapping],
        emit: F,
    ) -> Result<ImportSummary>
    where
        F: FnMut(ImportProgress),
    {
        let profile = self.get_profile(profile_id)?;
        if profile.read_only {
            return Err(read_only_error(&profile, "导入 CSV 会写入数据"));
        }
        let client = self.pool.get(profile_id)?;
        import::import_csv(&client, table, path, mappings, emit)
    }

    /// 执行 COPY 导出并返回回执 + 读回验证 SQL。
    pub fn copy_to(&self, profile_id: &str, input: &CopyInput) -> Result<CopyResult> {
        let sql = build_copy_sql(input)?;
        let verify = verify_sql(input)?;
        let client = self.pool.get(profile_id)?;
        let started = Instant::now();
        let receipt = client.execute(&sql)?;
        Ok(CopyResult {
            sql,
            verify_sql: verify,
            message: receipt.message,
            command: receipt.command,
            rows_affected: receipt.rows_affected,
            query_id: receipt.query_id,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// 下载服务端文件（二十批起为读授权；流式到本地临时文件，成功后原子替换）。
    ///
    /// `server_path` 是**库根内的相对路径**（服务端拒绝 `..`/绝对路径/内部目录）。
    /// 走管理面连接，避免长查询占住主连接；下载中断不会留下半截正式文件。
    pub fn download_file(
        &self,
        profile_id: &str,
        server_path: &str,
        local_path: &Path,
    ) -> Result<u64> {
        if let Some(parent) = local_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let client = self.admin_pool.get(profile_id)?;
        let tmp = local_path.with_extension(format!(
            "{}.part",
            local_path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("bin")
        ));
        let mut f = std::fs::File::create(&tmp)?;
        let result = client.download_file(server_path, &mut f);
        match result {
            Ok(n) => {
                use std::io::Write;
                f.flush()?;
                drop(f);
                std::fs::rename(&tmp, local_path)?;
                Ok(n)
            }
            Err(e) => {
                drop(f);
                let _ = std::fs::remove_file(&tmp);
                Err(e.into())
            }
        }
    }

    // ------------------------------------------------------------------
    // M2 管理面（qsdb-client 一等方法）
    // ------------------------------------------------------------------

    /// 运行期配置快照（完整响应体，`runtime` 之外的节原样透出）。
    pub fn config_get(&self, profile_id: &str) -> Result<admin::ConfigSnapshot> {
        let raw = self.admin_pool.get(profile_id)?.config_get()?.raw;
        serde_json::from_value(raw)
            .map_err(|e| StudioError::new("decode", format!("config 响应不完整: {e}")))
    }

    /// 热更运行期配置。`applied:false` 原样返回，由 UI 显式红（不许假成功）。
    pub fn config_put(
        &self,
        profile_id: &str,
        patch: &admin::ConfigPatch,
    ) -> Result<admin::ConfigUpdateAck> {
        if patch.is_empty() {
            return Err(StudioError::usage(
                "配置补丁为空——至少给出一个要改的键（空补丁在服务端注定 applied:false）",
            ));
        }
        let p = qsdb_client::ConfigPatch {
            query_timeout_ms: patch.query_timeout_ms,
            query_memory_limit_bytes: patch.query_memory_limit_bytes,
            max_result_rows: patch.max_result_rows,
            max_result_bytes: patch.max_result_bytes,
        };
        Ok(self.admin_pool.get(profile_id)?.config_put(&p)?.into())
    }

    /// 会话清单（admin 专属；非 admin 原样 403）。
    pub fn sessions_list(&self, profile_id: &str) -> Result<admin::SessionsList> {
        let sessions: Vec<_> = self
            .admin_pool
            .get(profile_id)?
            .sessions_list()?
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(admin::SessionsList {
            count: sessions.len(),
            sessions,
        })
    }

    /// 踢会话（admin）：取消其在跑查询并吊销 token。
    pub fn session_kick(&self, profile_id: &str, session_id: &str) -> Result<admin::KickResult> {
        let (kicked, cancelled_queries) =
            self.admin_pool.get(profile_id)?.session_kick(session_id)?;
        Ok(admin::KickResult {
            kicked,
            cancelled_queries,
        })
    }

    /// 运行中查询清单（诊断/取消面板）。
    pub fn queries_list(&self, profile_id: &str) -> Result<admin::QueriesList> {
        let queries: Vec<_> = self
            .admin_pool
            .get(profile_id)?
            .queries_list()?
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(admin::QueriesList {
            count: queries.len(),
            queries,
        })
    }

    /// grants **整表替换**（空表由 client 前置拒绝；全拒请给 `{"*": None}`）。
    pub fn set_grants(
        &self,
        profile_id: &str,
        user: &str,
        grants: &admin::GrantsMap,
    ) -> Result<()> {
        self.admin_pool.get(profile_id)?.set_grants(user, grants)?;
        Ok(())
    }

    /// 启动 watch 长轮询（独立 Client，避免占住主连接的串行锁）。
    ///
    /// 同一连接重复启动 = 先停旧的再起新的。事件经 `emit` 推送；
    /// `CURSOR_TOO_OLD` 由 core 全量对账一次并推 `WatchEvent::reset`。
    pub fn start_watch(
        &self,
        profile_id: &str,
        since: Option<u64>,
        emit: impl Fn(admin::WatchEvent) + Send + 'static,
    ) -> Result<()> {
        let profile = self.get_profile(profile_id)?;
        let auth = self.auth_for(&profile)?;
        let client = Arc::new(Client::connect(&profile.url, auth)?);

        let mut map = self.watches.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(prev) = map.remove(profile_id) {
            prev.store(true, Ordering::Relaxed);
        }
        let stop = Arc::new(AtomicBool::new(false));
        map.insert(profile_id.to_string(), Arc::clone(&stop));
        drop(map);

        let name = format!("qsdb-watch-{profile_id}");
        std::thread::Builder::new()
            .name(name)
            .spawn(move || admin::run_watch(client, since, stop, emit))
            .map_err(|e| StudioError::internal(format!("启动 watch 线程失败: {e}")))?;
        Ok(())
    }

    /// 停止 watch（阻塞中的长轮询最多等一个 `wait` 周期后退出）。
    pub fn stop_watch(&self, profile_id: &str) {
        let flag = self
            .watches
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(profile_id);
        if let Some(f) = flag {
            f.store(true, Ordering::Relaxed);
        }
    }

    // ------------------------------------------------------------------
    // 流式
    // ------------------------------------------------------------------

    /// 启动一条流式查询；返回 `streamId`（同时是 queryId）。
    pub fn start_stream(
        &self,
        profile_id: &str,
        sql: String,
        opts: &QueryOptionsInput,
        emit: impl Fn(StreamEvent) + Send + 'static,
    ) -> Result<String> {
        let profile = self.get_profile(profile_id)?;
        guard_read_only(&profile, &sql)?;
        let client = self.pool.get(profile_id)?;
        self.streams.start(client, sql, opts, emit)
    }

    /// 取一页。
    pub fn stream_page(&self, stream_id: &str, offset: u64, limit: usize) -> Result<StreamPage> {
        self.streams.page(stream_id, offset, limit)
    }

    /// 停止流式查询（两段语义，与内核 client 一致）：
    ///
    /// 1. **执行段**：`cancel(streamId)` 有效——发起时 `StreamStore` 已把
    ///    query id 固定为 streamId；
    /// 2. **传输段**：查询早已执行完并注销，cancel 回 404 是**预期**；这里
    ///    在本地 spool 打停止标记，reader 在下一个分块边界
    ///    `RowStream::abort()`（drop 独占连接）收尾。
    ///
    /// 两段都可能发生，所以先打本地标记再尝试 cancel；cancel 的任何失败都
    /// 不向 UI 报错（传输段 404 不是失败）。已收到的行保留可读。
    pub fn stop_stream(&self, profile_id: &str, stream_id: &str) -> Result<()> {
        self.streams.stop(stream_id);
        if let Ok(client) = self.admin_pool.get(profile_id) {
            // 传输段 404 / 执行段成功后已注销 / 网络瞬断：都交给本地 abort。
            let _ = client.cancel(stream_id);
        }
        Ok(())
    }

    /// 释放流（删除磁盘数据）。
    ///
    /// 关闭一个仍在接收的结果页时，释放必须先打停止标记：否则 reader
    /// 会继续把数据读进一个已经孤立的 spool（白耗网络/磁盘），直到流自然结束。
    pub fn stream_release(&self, stream_id: &str) -> Result<()> {
        self.streams.stop(stream_id);
        self.streams.release(stream_id)
    }

    /// 导出已结束的流为 CSV。
    pub fn stream_export_csv(&self, stream_id: &str, path: &Path, bom: bool) -> Result<u64> {
        self.streams.export_csv(stream_id, path, bom)
    }

    /// 写文本文件（小结果 CSV / SQL 文件的前端落盘）。
    pub fn save_text_file(&self, path: &Path, text: &str, bom: bool) -> Result<()> {
        io_csv::write_text_file(path, text, bom)
    }

    /// 读 UTF-8 文本文件（打开 .sql）。BOM 会被去掉；非 UTF-8 显式报错。
    pub fn read_text_file(&self, path: &Path) -> Result<String> {
        let bytes = std::fs::read(path)
            .map_err(|e| StudioError::storage(format!("读取 {} 失败: {e}", path.display())))?;
        let text = String::from_utf8(bytes).map_err(|_| {
            StudioError::usage(format!(
                "{} 不是 UTF-8 文本（QSDB Studio 只打开 UTF-8 编码的 SQL 文件）",
                path.display()
            ))
        })?;
        Ok(text
            .strip_prefix('\u{feff}')
            .unwrap_or(text.as_str())
            .to_string())
    }
}

/// 只读档案的统一拒绝文案（**不包含 SQL 文本或任何凭证**）。
fn read_only_error(profile: &Profile, why: &str) -> StudioError {
    StudioError::usage(format!(
        "连接「{}」标记为只读，{}。只读连接允许 SELECT / SHOW / EXPLAIN 等读语句；\
         确需写入请在连接设置里取消只读。",
        profile.name, why
    ))
}

/// 客户端侧的只读纵深防御：服务端授权仍是最终边界，但 UI/IPC 误发写语句时
/// 在这里显式拒绝，不把“可能写库”的请求交给服务端碰运气。
fn guard_read_only(profile: &Profile, sql: &str) -> Result<()> {
    if profile.read_only && !query::is_read_only_sql(sql) {
        return Err(read_only_error(profile, "已阻止可能写入的语句"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn core(tmp: &TempDir) -> StudioCore {
        StudioCore::open_with_secrets(tmp.path(), Arc::new(MemorySecretStore::default())).unwrap()
    }

    fn inp(name: &str, auth: ProfileAuth, secret: Option<&str>) -> ProfileInput {
        ProfileInput {
            id: None,
            name: name.into(),
            url: "http://127.0.0.1:9430".into(),
            auth,
            default_database: None,
            read_only: false,
            secret: secret.map(str::to_string),
        }
    }

    #[test]
    fn profile_secret_lifecycle() {
        let tmp = TempDir::new().unwrap();
        let c = core(&tmp);
        let p = c
            .save_profile(inp(
                "本地",
                ProfileAuth::Basic {
                    user: "admin".into(),
                },
                Some("pw"),
            ))
            .unwrap();
        assert!(p.has_secret);
        assert_eq!(c.list_profiles().unwrap().len(), 1);

        // 改名不重填秘密 → 保留
        let mut edit = inp(
            "改名",
            ProfileAuth::Basic {
                user: "admin".into(),
            },
            None,
        );
        edit.id = Some(p.id.clone());
        let v = c.save_profile(edit).unwrap();
        assert!(v.has_secret);
        assert_eq!(v.name, "改名");

        // 换用户名但不给新密码 → 拒绝（不复用旧密码）
        let mut edit = inp(
            "改名",
            ProfileAuth::Basic {
                user: "other".into(),
            },
            None,
        );
        edit.id = Some(p.id.clone());
        let err = c.save_profile(edit).unwrap_err();
        assert!(err.message.contains("请填写密码"));

        // 改成匿名 → 旧秘密作废
        let mut edit = inp("改名", ProfileAuth::None, None);
        edit.id = Some(p.id.clone());
        let v = c.save_profile(edit).unwrap();
        assert!(!v.has_secret);

        assert!(c.delete_profile(&p.id).unwrap());
        assert!(c.list_profiles().unwrap().is_empty());
    }

    #[test]
    fn cancel_aborts_local_transfer_without_admin_connection() {
        let tmp = TempDir::new().unwrap();
        let c = core(&tmp);
        let handle = AbortHandle::new();
        c.aborts
            .lock()
            .unwrap()
            .insert(("missing".into(), "q-1".into()), handle.clone());

        // 管理面连接不存在也不该阻止本地 abort：had_local = true ⇒ cancel 成功。
        c.cancel("missing", "q-1").unwrap();
        assert!(handle.is_aborted());
        assert!(
            c.aborts.lock().unwrap().is_empty(),
            "cancel 必须取走并清理本地句柄"
        );
    }

    #[test]
    fn close_aborts_inflight_query_handles() {
        let tmp = TempDir::new().unwrap();
        let c = core(&tmp);
        let handle = AbortHandle::new();
        c.aborts
            .lock()
            .unwrap()
            .insert(("p1".into(), "q-1".into()), handle.clone());
        let _ = c.close("p1");
        assert!(handle.is_aborted());
        assert!(c.aborts.lock().unwrap().is_empty());
    }

    #[test]
    fn connecting_unknown_profile_is_a_clear_error() {
        let tmp = TempDir::new().unwrap();
        let c = core(&tmp);
        let err = c.connect("nope").unwrap_err();
        assert_eq!(err.kind, "usage");
        assert!(err.message.contains("不存在"));
    }

    #[test]
    fn split_is_exposed_through_core() {
        let tmp = TempDir::new().unwrap();
        let c = core(&tmp);
        assert_eq!(c.split_sql("SELECT 1; SELECT 2").len(), 2);
    }

    #[test]
    fn test_connection_validates_secret_without_persisting() {
        let tmp = TempDir::new().unwrap();
        let c = core(&tmp);

        // 新建 + Basic 未填密码：在发请求前就明确拒绝，且不产生档案。
        let err = c
            .test_connection(&inp("probe", ProfileAuth::Basic { user: "u".into() }, None))
            .unwrap_err();
        assert!(err.message.contains("密码"));
        assert!(c.list_profiles().unwrap().is_empty());

        // 编辑已有档案但改了用户名且留空秘密：拒绝复用旧密码。
        let p = c
            .save_profile(inp(
                "saved",
                ProfileAuth::Basic { user: "u".into() },
                Some("pw"),
            ))
            .unwrap();
        let mut changed = inp(
            "saved",
            ProfileAuth::Basic {
                user: "other".into(),
            },
            None,
        );
        changed.id = Some(p.id.clone());
        let err = c.test_connection(&changed).unwrap_err();
        assert!(err.message.contains("认证身份已变更"));
        assert_eq!(c.list_profiles().unwrap().len(), 1);

        // Bearer 未填 Token：同样是本地用法错误，不触网。
        let err = c
            .test_connection(&inp("probe", ProfileAuth::Bearer, None))
            .unwrap_err();
        assert!(err.message.contains("Token"));
    }

    #[test]
    fn text_file_round_trip_strips_bom_and_rejects_non_utf8() {
        let tmp = TempDir::new().unwrap();
        let c = core(&tmp);
        let path = tmp.path().join("q.sql");

        c.save_text_file(&path, "SELECT '中文';\n", false).unwrap();
        assert_eq!(c.read_text_file(&path).unwrap(), "SELECT '中文';\n");

        // 带 BOM 的文件：读侧去掉 BOM，避免编辑器出现不可见前缀。
        std::fs::write(&path, b"\xEF\xBB\xBFSELECT 1;").unwrap();
        assert_eq!(c.read_text_file(&path).unwrap(), "SELECT 1;");

        // 非 UTF-8：显式 usage 错误，不猜编码。
        std::fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        let err = c.read_text_file(&path).unwrap_err();
        assert_eq!(err.kind, "usage");
        assert!(err.message.contains("UTF-8"));
    }

    #[test]
    fn read_only_profile_blocks_writes_before_any_network_io() {
        let tmp = TempDir::new().unwrap();
        let c = core(&tmp);
        let p = c
            .save_profile(inp("生产只读", ProfileAuth::None, None))
            .unwrap();
        let mut edit = inp("生产只读", ProfileAuth::None, None);
        edit.id = Some(p.id.clone());
        edit.read_only = true;
        c.save_profile(edit).unwrap();

        // 写语句在**建连/发请求之前**被拒绝（本地 usage，不是服务端错误）。
        let err = c
            .execute(&p.id, "DELETE FROM sales", &QueryOptionsInput::default())
            .unwrap_err();
        assert_eq!(err.kind, "usage");
        assert!(err.message.contains("只读"));

        let err = c
            .start_stream(
                &p.id,
                "INSERT INTO sales VALUES (1)".into(),
                &QueryOptionsInput::default(),
                |_| {},
            )
            .unwrap_err();
        assert_eq!(err.kind, "usage");
        assert!(err.message.contains("只读"));

        // 导入同样在读取文件/建连之前拒绝。
        let err = c
            .import_csv(&p.id, "sales", Path::new("missing.csv"), &[], |_| {})
            .unwrap_err();
        assert_eq!(err.kind, "usage");
        assert!(err.message.contains("只读"));
    }
}
