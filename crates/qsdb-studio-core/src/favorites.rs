//! SQL 收藏（本地 JSON，设计 §5.3 的"收藏"）。
//!
//! 与历史分开：历史是自动追加的流水，收藏是用户显式挑出来的少量条目。
//! 同一份 SQL 精确重复时**不新增**（更新名称/时间），避免收藏夹被重复项污染。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{Result, StudioError};
use crate::profile::{new_id, now_ms};

/// 一条收藏。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Favorite {
    /// id。
    pub id: String,
    /// 显示名（缺省取 SQL 摘要）。
    pub name: String,
    /// SQL 原文。
    pub sql: String,
    /// 收藏时间（Unix ms）。
    pub created_at_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FavoritesFile {
    version: u32,
    #[serde(default)]
    favorites: Vec<Favorite>,
}

const FILE_VERSION: u32 = 1;

/// JSON 收藏存储（原子替换写）。
#[derive(Debug)]
pub struct FavoritesStore {
    path: PathBuf,
    favorites: Mutex<Vec<Favorite>>,
}

impl FavoritesStore {
    /// 打开（或初始化）收藏文件；损坏 → 显式报错，不悄悄重建。
    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        let favorites = if path.exists() {
            let bytes = std::fs::read(&path).map_err(|e| {
                StudioError::storage(format!("读取收藏文件 {} 失败: {e}", path.display()))
            })?;
            let f: FavoritesFile = serde_json::from_slice(&bytes).map_err(|e| {
                StudioError::storage(format!(
                    "收藏文件 {} 不是合法 JSON（不会自动重建）: {e}",
                    path.display()
                ))
            })?;
            if f.version != FILE_VERSION {
                return Err(StudioError::storage(format!(
                    "收藏文件版本 {} 不认识（本版本支持 {FILE_VERSION}）",
                    f.version
                )));
            }
            f.favorites
        } else {
            Vec::new()
        };
        Ok(Self {
            path,
            favorites: Mutex::new(favorites),
        })
    }

    /// 文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 全部收藏（新的在前）。
    pub fn list(&self) -> Vec<Favorite> {
        let mut v = self
            .favorites
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        v.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms).then(a.id.cmp(&b.id)));
        v
    }

    /// 添加；同一 SQL 已存在时更新名称/时间并返回原条目（不重复）。
    pub fn add(&self, name: Option<&str>, sql: &str) -> Result<Favorite> {
        let sql = sql.trim();
        if sql.is_empty() {
            return Err(StudioError::usage("不能收藏空 SQL"));
        }
        let name = name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| default_name(sql));
        let now = now_ms();
        let mut guard = self.favorites.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = guard.iter_mut().find(|f| f.sql == sql) {
            existing.name = name;
            existing.created_at_ms = now;
            let out = existing.clone();
            write_atomic(&self.path, &guard)?;
            return Ok(out);
        }
        let fav = Favorite {
            id: new_id("fav"),
            name,
            sql: sql.to_string(),
            created_at_ms: now,
        };
        guard.push(fav.clone());
        write_atomic(&self.path, &guard)?;
        Ok(fav)
    }

    /// 重命名（保留 id / SQL / 收藏时间；空名称显式拒绝）。
    pub fn rename(&self, id: &str, name: &str) -> Result<Favorite> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StudioError::usage("收藏名称不能为空"));
        }
        let mut guard = self.favorites.lock().unwrap_or_else(|e| e.into_inner());
        let Some(existing) = guard.iter_mut().find(|f| f.id == id) else {
            return Err(StudioError::usage(format!("收藏 '{id}' 不存在")));
        };
        existing.name = name.to_string();
        let out = existing.clone();
        write_atomic(&self.path, &guard)?;
        Ok(out)
    }

    /// 删除；返回是否真的删掉。
    pub fn remove(&self, id: &str) -> Result<bool> {
        let mut guard = self.favorites.lock().unwrap_or_else(|e| e.into_inner());
        let before = guard.len();
        guard.retain(|f| f.id != id);
        if guard.len() == before {
            return Ok(false);
        }
        write_atomic(&self.path, &guard)?;
        Ok(true)
    }
}

fn default_name(sql: &str) -> String {
    let one: String = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= 60 {
        one
    } else {
        let truncated: String = one.chars().take(59).collect();
        format!("{truncated}…")
    }
}

fn write_atomic(path: &Path, favorites: &[Favorite]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            StudioError::storage(format!("创建收藏目录 {} 失败: {e}", parent.display()))
        })?;
    }
    let body = serde_json::to_vec_pretty(&FavoritesFile {
        version: FILE_VERSION,
        favorites: favorites.to_vec(),
    })?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &body)
        .map_err(|e| StudioError::storage(format!("写临时收藏 {} 失败: {e}", tmp.display())))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| StudioError::storage(format!("替换收藏 {} 失败: {e}", path.display())))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn add_list_dedup_remove_and_persist() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("favorites.json");
        let store = FavoritesStore::open(&path).unwrap();

        let a = store.add(None, "SELECT 1").unwrap();
        assert_eq!(a.name, "SELECT 1");
        let b = store.add(Some("计数"), "SELECT count(*) FROM t").unwrap();
        assert_eq!(b.name, "计数");
        assert_eq!(store.list().len(), 2);

        // 同一 SQL 精确重复：不新增，更新名称
        let a2 = store.add(Some("常量"), "SELECT 1").unwrap();
        assert_eq!(a2.id, a.id);
        assert_eq!(store.list().len(), 2);
        assert_eq!(
            store.list().iter().find(|f| f.id == a.id).unwrap().name,
            "常量"
        );

        // 持久化
        let reopened = FavoritesStore::open(&path).unwrap();
        assert_eq!(reopened.list().len(), 2);

        assert!(store.remove(&a.id).unwrap());
        assert_eq!(FavoritesStore::open(&path).unwrap().list().len(), 1);
        assert!(!store.remove("nope").unwrap());
    }

    #[test]
    fn rename_persists_and_rejects_empty_or_unknown() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("favorites.json");
        let store = FavoritesStore::open(&path).unwrap();
        let fav = store.add(None, "SELECT 1").unwrap();

        let renamed = store.rename(&fav.id, "  常量  ").unwrap();
        assert_eq!(renamed.name, "常量");
        assert_eq!(renamed.created_at_ms, fav.created_at_ms);
        assert_eq!(FavoritesStore::open(&path).unwrap().list()[0].name, "常量");

        assert!(store.rename(&fav.id, "   ").is_err());
        assert!(store.rename("nope", "x").is_err());
    }

    #[test]
    fn empty_sql_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let store = FavoritesStore::open(tmp.path().join("favorites.json")).unwrap();
        assert!(store.add(None, "   ").is_err());
    }

    #[test]
    fn corrupt_file_is_explicit() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("favorites.json");
        std::fs::write(&path, "{oops").unwrap();
        let e = FavoritesStore::open(&path).unwrap_err();
        assert!(e.message.contains("不会自动重建"));
    }

    #[test]
    fn default_name_is_bounded() {
        let long = "SELECT ".to_string() + &"x".repeat(200);
        let n = default_name(&long);
        assert!(n.chars().count() == 60);
        assert!(n.ends_with('…'));
    }
}
