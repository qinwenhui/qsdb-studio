//! `connId → Client` 注册表。
//!
//! 每个档案一条连接（`Client` 内部 keep-alive；同一条连接上的请求串行）。
//! 关闭连接 = 从表里移除并 drop，会话随之释放。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use qsdb_client::Client;

use crate::error::{Result, StudioError};

/// 连接池。`Client` 自身 `Send + Sync`，用 `Arc` 共享给后台流任务。
#[derive(Debug, Default)]
pub struct ConnPool {
    map: Mutex<HashMap<String, Arc<Client>>>,
}

impl ConnPool {
    /// 空池。
    pub fn new() -> Self {
        Self::default()
    }

    /// 放入（同 id 覆盖 = 先 drop 旧连接）。
    pub fn insert(&self, id: impl Into<String>, client: Arc<Client>) {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.into(), client);
    }

    /// 取连接；未连接 → 明确报错（不自动重连：那是 UI 的显式动作）。
    pub fn get(&self, id: &str) -> Result<Arc<Client>> {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| {
                StudioError::usage(format!("连接 '{id}' 未打开（请先连接，再执行操作）"))
            })
    }

    /// 关闭一条连接；返回是否存在过。
    pub fn remove(&self, id: &str) -> bool {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
            .is_some()
    }

    /// 已打开的连接 id（诊断/测试用）。
    pub fn ids(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        v.sort();
        v
    }
}
