//! 连接档案（JSON）+ OS 凭据管理器（设计 §二、§六.3）。
//!
//! **档案文件里永远没有密码/Token**：JSON 只存 `auth.kind`（与 Basic 的用户名），
//! 秘密单独进 keyring。档案损坏时**显式报错**，绝不悄悄重建一个空列表。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{Result, StudioError};

/// 认证方式（持久化形态；秘密不在其中）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProfileAuth {
    /// 匿名（服务端未配置凭证时可用）。
    #[default]
    None,
    /// 用户名密码：用户名在档案里，密码在 keyring。
    Basic { user: String },
    /// 静态 Bearer token：token 在 keyring。
    Bearer,
}

impl ProfileAuth {
    /// 人读摘要（**不含任何凭证**）。
    pub fn summary(&self) -> String {
        match self {
            ProfileAuth::None => "匿名".into(),
            ProfileAuth::Basic { user } => format!("Basic · {user}"),
            ProfileAuth::Bearer => "Bearer token".into(),
        }
    }
}

/// 一条连接档案（持久化形态）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// 档案 id（稳定，秘密在 keyring 里用它做 account）。
    pub id: String,
    /// 显示名。
    pub name: String,
    /// 服务端地址（`qsdb://host:port`；兼容 `http://host:port`，端口必填）。
    /// `qsdb://` 是连接串别名，底层仍是明文 HTTP/1.1。
    pub url: String,
    /// 认证方式。
    #[serde(default)]
    pub auth: ProfileAuth,
    /// 登录后的默认库（可选）。
    #[serde(default)]
    pub default_database: Option<String>,
    /// 只读标记：客户端拦截可能写入的语句（**纵深防御，不是服务端授权**）。
    #[serde(default)]
    pub read_only: bool,
    /// 创建时间（Unix ms，仅展示/排序用）。
    pub created_at_ms: u64,
    /// 最近修改时间（Unix ms）。
    pub updated_at_ms: u64,
}

/// 档案 + 是否已在 keyring 里保存秘密（**秘密本身永不返回**）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    /// 档案 id。
    pub id: String,
    /// 显示名。
    pub name: String,
    /// 地址。
    pub url: String,
    /// 认证方式。
    pub auth: ProfileAuth,
    /// 默认库。
    pub default_database: Option<String>,
    /// 只读标记（客户端拦截写语句）。
    pub read_only: bool,
    /// keyring 里是否有密码/Token。
    pub has_secret: bool,
    /// 创建时间。
    pub created_at_ms: u64,
    /// 修改时间。
    pub updated_at_ms: u64,
}

impl Profile {
    /// 转成展示形态。
    pub fn view(&self, has_secret: bool) -> ProfileView {
        ProfileView {
            id: self.id.clone(),
            name: self.name.clone(),
            url: self.url.clone(),
            auth: self.auth.clone(),
            default_database: self.default_database.clone(),
            read_only: self.read_only,
            has_secret,
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
        }
    }
}

/// 保存档案的输入（`secret` 只在提交时出现一次，随后只进 keyring）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProfileInput {
    /// 现有档案 id；缺省 = 新建。
    pub id: Option<String>,
    /// 显示名。
    pub name: String,
    /// 地址。
    pub url: String,
    /// 认证方式。
    pub auth: ProfileAuth,
    /// 默认库。
    pub default_database: Option<String>,
    /// 只读标记（客户端拦截写语句）。
    pub read_only: bool,
    /// 新密码 / 新 Token（`None` 或空串 = 保持不变）。
    pub secret: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfilesFile {
    version: u32,
    #[serde(default)]
    profiles: Vec<Profile>,
}

const FILE_VERSION: u32 = 1;

/// JSON 档案存储（追加/覆盖写 + 原子替换）。
#[derive(Debug)]
pub struct ProfileStore {
    path: PathBuf,
    profiles: Mutex<Vec<Profile>>,
}

impl ProfileStore {
    /// 打开（或初始化）档案文件。文件存在但解析失败 → 报错。
    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        let profiles = if path.exists() {
            let bytes = std::fs::read(&path).map_err(|e| {
                StudioError::storage(format!("读取连接档案 {} 失败: {e}", path.display()))
            })?;
            let f: ProfilesFile = serde_json::from_slice(&bytes).map_err(|e| {
                StudioError::storage(format!(
                    "连接档案 {} 不是合法 JSON（不会自动重建，请修复或移走）: {e}",
                    path.display()
                ))
            })?;
            if f.version != FILE_VERSION {
                return Err(StudioError::storage(format!(
                    "连接档案版本 {} 不认识（本版本支持 {FILE_VERSION}）",
                    f.version
                )));
            }
            f.profiles
        } else {
            Vec::new()
        };
        Ok(Self {
            path,
            profiles: Mutex::new(profiles),
        })
    }

    /// 档案文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 全部档案（按创建时间排序）。
    pub fn list(&self) -> Vec<Profile> {
        let mut v = self
            .profiles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        v.sort_by_key(|p| p.created_at_ms);
        v
    }

    /// 取一条。
    pub fn get(&self, id: &str) -> Option<Profile> {
        self.profiles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    /// 新建或覆盖。返回保存后的档案；新建时 id 由这里生成。
    pub fn upsert(&self, input: ProfileInput) -> Result<Profile> {
        validate_profile(&input)?;
        let now = now_ms();
        let mut guard = self.profiles.lock().unwrap_or_else(|e| e.into_inner());
        let id = match input.id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(id) => id.to_string(),
            None => new_id("p"),
        };
        let created = guard
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.created_at_ms)
            .unwrap_or(now);
        let profile = Profile {
            id: id.clone(),
            name: input.name.trim().to_string(),
            url: input.url.trim().trim_end_matches('/').to_string(),
            auth: input.auth,
            default_database: input
                .default_database
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            read_only: input.read_only,
            created_at_ms: created,
            updated_at_ms: now,
        };
        match guard.iter_mut().find(|p| p.id == id) {
            Some(slot) => *slot = profile.clone(),
            None => guard.push(profile.clone()),
        }
        write_atomic(&self.path, &guard)?;
        Ok(profile)
    }

    /// 删除。返回是否真的删掉了一条。
    pub fn remove(&self, id: &str) -> Result<bool> {
        let mut guard = self.profiles.lock().unwrap_or_else(|e| e.into_inner());
        let before = guard.len();
        guard.retain(|p| p.id != id);
        if guard.len() == before {
            return Ok(false);
        }
        write_atomic(&self.path, &guard)?;
        Ok(true)
    }
}

fn validate_profile(input: &ProfileInput) -> Result<()> {
    if input.name.trim().is_empty() {
        return Err(StudioError::usage("连接名称不能为空"));
    }
    if input.url.trim().is_empty() {
        return Err(StudioError::usage("服务地址不能为空"));
    }
    // 复用客户端同一套 URL 校验（缺端口、https 手搓 TLS 都会显式报错）。
    qsdb_client::Client::connect(input.url.trim(), qsdb_client::Auth::None)
        .map_err(StudioError::from)?;
    if let ProfileAuth::Basic { user } = &input.auth
        && user.trim().is_empty()
    {
        return Err(StudioError::usage("用户名不能为空（Basic 认证）"));
    }
    Ok(())
}

fn write_atomic(path: &Path, profiles: &[Profile]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            StudioError::storage(format!("创建档案目录 {} 失败: {e}", parent.display()))
        })?;
    }
    let body = serde_json::to_vec_pretty(&ProfilesFile {
        version: FILE_VERSION,
        profiles: profiles.to_vec(),
    })?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &body)
        .map_err(|e| StudioError::storage(format!("写临时档案 {} 失败: {e}", tmp.display())))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        StudioError::storage(format!(
            "替换档案 {} 失败（旧文件保留）: {e}",
            path.display()
        ))
    })?;
    Ok(())
}

/// 秘密存储抽象：生产用 keyring，单测用内存实现。
pub trait SecretStore: Send + Sync + std::fmt::Debug {
    /// 读取；不存在 → `Ok(None)`。
    fn get(&self, profile_id: &str) -> Result<Option<String>>;
    /// 写入。
    fn set(&self, profile_id: &str, secret: &str) -> Result<()>;
    /// 删除（不存在不算错）。
    fn delete(&self, profile_id: &str) -> Result<()>;
}

/// OS 凭据管理器（Windows Credential Manager / macOS Keychain / Secret Service）。
#[derive(Debug, Clone)]
pub struct KeyringSecretStore {
    service: String,
}

impl KeyringSecretStore {
    /// `service` 是凭据管理器里的服务名（本项目固定 `qsdb-studio`）。
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, profile_id: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, profile_id)
            .map_err(|e| StudioError::secret(format!("无法打开系统凭据管理器: {e}")))
    }
}

impl SecretStore for KeyringSecretStore {
    fn get(&self, profile_id: &str) -> Result<Option<String>> {
        match self.entry(profile_id)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(StudioError::secret(format!(
                "读取系统凭据失败（档案 {profile_id}）: {e}"
            ))),
        }
    }

    fn set(&self, profile_id: &str, secret: &str) -> Result<()> {
        self.entry(profile_id)?
            .set_password(secret)
            .map_err(|e| StudioError::secret(format!("写入系统凭据失败（档案 {profile_id}）: {e}")))
    }

    fn delete(&self, profile_id: &str) -> Result<()> {
        match self.entry(profile_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(StudioError::secret(format!(
                "删除系统凭据失败（档案 {profile_id}）: {e}"
            ))),
        }
    }
}

/// 内存秘密存储（**仅测试**；不参与任何生产路径）。
#[derive(Debug, Default)]
pub struct MemorySecretStore {
    map: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemorySecretStore {
    fn get(&self, profile_id: &str) -> Result<Option<String>> {
        Ok(self
            .map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(profile_id)
            .cloned())
    }

    fn set(&self, profile_id: &str, secret: &str) -> Result<()> {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(profile_id.to_string(), secret.to_string());
        Ok(())
    }

    fn delete(&self, profile_id: &str) -> Result<()> {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(profile_id);
        Ok(())
    }
}

/// 时间戳（Unix ms）。
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

static ID_SEQ: AtomicU64 = AtomicU64::new(0);

/// 进程内唯一 id（不引 uuid：桌面单实例足够）。
pub fn new_id(prefix: &str) -> String {
    let ms = now_ms();
    let seq = ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{ms}-{seq}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn open(tmp: &TempDir) -> ProfileStore {
        ProfileStore::open(tmp.path().join("connections.json")).unwrap()
    }

    fn input(name: &str) -> ProfileInput {
        ProfileInput {
            id: None,
            name: name.into(),
            url: "http://127.0.0.1:9430".into(),
            auth: ProfileAuth::Basic {
                user: "admin".into(),
            },
            default_database: Some("default".into()),
            read_only: false,
            secret: Some("super-secret".into()),
        }
    }

    #[test]
    fn crud_roundtrip_and_secret_never_written_to_json() {
        let tmp = TempDir::new().unwrap();
        let store = open(&tmp);
        let p = store.upsert(input("本地")).unwrap();
        assert!(p.id.starts_with("p-"));
        let raw = std::fs::read_to_string(store.path()).unwrap();
        assert!(!raw.contains("super-secret"), "档案 JSON 不得含秘密");
        assert!(raw.contains("\"user\": \"admin\""));

        let reopened = open(&tmp);
        assert_eq!(reopened.list().len(), 1);
        assert_eq!(reopened.get(&p.id).unwrap().name, "本地");

        // 更新保留 id / created_at
        let mut upd = input("改名");
        upd.id = Some(p.id.clone());
        upd.secret = None;
        let p2 = reopened.upsert(upd).unwrap();
        assert_eq!(p2.id, p.id);
        assert_eq!(p2.created_at_ms, p.created_at_ms);

        assert!(reopened.remove(&p.id).unwrap());
        assert!(open(&tmp).list().is_empty());
    }

    #[test]
    fn read_only_flag_round_trips() {
        let tmp = TempDir::new().unwrap();
        let store = open(&tmp);
        let mut inp = input("生产只读");
        inp.read_only = true;
        let p = store.upsert(inp).unwrap();
        assert!(p.read_only);
        let reopened = open(&tmp);
        assert!(reopened.get(&p.id).unwrap().read_only);
        let raw = std::fs::read_to_string(store.path()).unwrap();
        assert!(raw.contains("\"readOnly\": true"));
    }

    #[test]
    fn corrupt_file_is_an_error_not_a_silent_reset() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        std::fs::write(&path, "{not json").unwrap();
        let err = ProfileStore::open(&path).unwrap_err();
        assert!(err.message.contains("不会自动重建"));
    }

    #[test]
    fn url_without_port_is_rejected_before_saving() {
        let tmp = TempDir::new().unwrap();
        let store = open(&tmp);
        let mut inp = input("bad");
        inp.url = "http://127.0.0.1".into();
        let err = store.upsert(inp).unwrap_err();
        assert!(err.message.contains("缺端口"));
        assert!(store.list().is_empty());
    }

    #[test]
    fn https_is_rejected_with_guidance() {
        let tmp = TempDir::new().unwrap();
        let store = open(&tmp);
        let mut inp = input("tls");
        inp.url = "https://example.com:443".into();
        let err = store.upsert(inp).unwrap_err();
        assert!(err.message.contains("TLS 终止代理"));
    }

    #[test]
    fn qsdb_scheme_is_accepted_as_alias() {
        let tmp = TempDir::new().unwrap();
        let store = open(&tmp);
        let mut inp = input("qsdb-scheme");
        inp.url = "qsdb://127.0.0.1:9430".into();
        let p = store.upsert(inp).expect("qsdb:// 应作为连接串别名被接受");
        assert_eq!(p.url, "qsdb://127.0.0.1:9430");
    }

    #[test]
    fn memory_secret_store_works() {
        let s = MemorySecretStore::default();
        assert_eq!(s.get("a").unwrap(), None);
        s.set("a", "x").unwrap();
        assert_eq!(s.get("a").unwrap().as_deref(), Some("x"));
        s.delete("a").unwrap();
        assert_eq!(s.get("a").unwrap(), None);
    }
}
