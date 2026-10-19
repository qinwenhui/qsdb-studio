//! 执行历史（JSONL 追加写，设计 §二 的"减法"）。
//!
//! 不引 SQLite：历史只是追加、搜索、回填。`sql` 原样保存——**绝不记录密码/
//! Token**；调用方只传 SQL 文本与结构化结果。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{Result, StudioError};
use crate::profile::now_ms;

/// 一条执行历史。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// 时间（Unix ms）。
    pub ts_ms: u64,
    /// 连接档案 id。
    pub profile_id: String,
    /// 连接名（归档后仍可读）。
    pub connection_name: String,
    /// 执行的 SQL（原样）。
    pub sql: String,
    /// 墙钟耗时（ms）。
    pub elapsed_ms: f64,
    /// 行数（成功时）。
    pub row_count: u64,
    /// `ok` / `error`。
    pub status: String,
    /// 失败时的机器码（判分支用）。
    pub error_code: Option<String>,
    /// 服务端 query id（成功时）。
    pub query_id: Option<String>,
}

/// JSONL 历史存储。
#[derive(Debug)]
pub struct HistoryStore {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl HistoryStore {
    /// 打开（文件不存在 = 空历史）。
    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                StudioError::storage(format!("创建历史目录 {} 失败: {e}", parent.display()))
            })?;
        }
        Ok(Self {
            path,
            write_lock: Mutex::new(()),
        })
    }

    /// 历史文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 追加一条。**写失败不吞**（调用方决定是否作为 warning 呈现）。
    pub fn append(&self, entry: &HistoryEntry) -> Result<()> {
        let _g = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut line = serde_json::to_vec(entry)?;
        line.push(b'\n');
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| {
                StudioError::storage(format!("打开历史文件 {} 失败: {e}", self.path.display()))
            })?;
        f.write_all(&line)?;
        f.flush()?;
        Ok(())
    }

    /// 最近 `limit` 条（新的在前），可按 SQL/连接名做不区分大小写的包含搜索。
    ///
    /// 损坏的行会被跳过（历史是辅助数据；**不影响查询结果**）。
    pub fn list(&self, limit: usize, query: Option<&str>) -> Result<Vec<HistoryEntry>> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let text = std::fs::read_to_string(&self.path).map_err(|e| {
            StudioError::storage(format!("读取历史文件 {} 失败: {e}", self.path.display()))
        })?;
        let needle = query
            .map(|q| q.trim().to_lowercase())
            .filter(|q| !q.is_empty());
        let mut out = Vec::new();
        for line in text.lines().rev() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<HistoryEntry>(line) else {
                continue;
            };
            if let Some(n) = &needle {
                let hit = entry.sql.to_lowercase().contains(n)
                    || entry.connection_name.to_lowercase().contains(n);
                if !hit {
                    continue;
                }
            }
            out.push(entry);
            if out.len() >= limit.max(1) {
                break;
            }
        }
        Ok(out)
    }
}

/// 构造一条成功历史。
pub fn ok_entry(
    profile_id: &str,
    connection_name: &str,
    sql: &str,
    elapsed_ms: f64,
    row_count: u64,
    query_id: Option<String>,
) -> HistoryEntry {
    HistoryEntry {
        ts_ms: now_ms(),
        profile_id: profile_id.into(),
        connection_name: connection_name.into(),
        sql: sql.into(),
        elapsed_ms,
        row_count,
        status: "ok".into(),
        error_code: None,
        query_id,
    }
}

/// 构造一条失败历史。
pub fn err_entry(
    profile_id: &str,
    connection_name: &str,
    sql: &str,
    elapsed_ms: f64,
    error_code: Option<String>,
) -> HistoryEntry {
    HistoryEntry {
        ts_ms: now_ms(),
        profile_id: profile_id.into(),
        connection_name: connection_name.into(),
        sql: sql.into(),
        elapsed_ms,
        row_count: 0,
        status: "error".into(),
        error_code,
        query_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn append_list_search_newest_first() {
        let tmp = TempDir::new().unwrap();
        let store = HistoryStore::open(tmp.path().join("history.jsonl")).unwrap();
        store
            .append(&ok_entry("p1", "本地", "SELECT 1", 1.5, 1, None))
            .unwrap();
        store
            .append(&ok_entry("p1", "本地", "SELECT * FROM 销售", 9.0, 10, None))
            .unwrap();
        store
            .append(&err_entry(
                "p1",
                "本地",
                "BAD SQL",
                0.1,
                Some("PARSE_ERROR".into()),
            ))
            .unwrap();

        let all = store.list(10, None).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].sql, "BAD SQL");
        assert_eq!(all[0].status, "error");

        let hit = store.list(10, Some("销售")).unwrap();
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].row_count, 10);

        let limited = store.list(2, None).unwrap();
        assert_eq!(limited.len(), 2);
    }

    #[test]
    fn corrupt_lines_are_skipped_without_breaking_history() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("history.jsonl");
        let store = HistoryStore::open(&path).unwrap();
        store
            .append(&ok_entry("p1", "本地", "SELECT 1", 1.0, 1, None))
            .unwrap();
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(f, "{{broken").unwrap();
        assert_eq!(store.list(10, None).unwrap().len(), 1);
    }
}
