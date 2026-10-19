//! Studio 错误：**按 code 分档，不解析文案**（设计 §六.4）。
//!
//! 这一层把 `qsdb_client::Error` 的传输/语义分档原样保留，再加两档 Studio
//! 自己的错误（档案/凭据/流存储）。前端据此渲染 `code` 徽章与建议动作；
//! 文案（`message`）只给人看，**不做兼容承诺**。

use serde::Serialize;
use std::fmt;

/// CSV 导入时某个值解析失败的定位信息（可选；不承诺文案兼容）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CsvErrorDetail {
    /// 数据区 0 基记录下标（不含表头；跨多行引号记录也稳定）。
    pub record_index: u64,
    /// 人读行号（含表头，1 基；按记录序号计算）。
    pub line: u64,
    /// 表列名。
    pub column: String,
    /// 原始值（最多 60 字符）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// 面向 IPC/UI 的错误。可序列化 —— Tauri 命令直接返回它。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StudioError {
    /// 分档：`api` / `io` / `http` / `decode` / `usage` / `secret` / `storage` / `internal`。
    pub kind: String,
    /// 服务端机器码（仅 `kind = api` 时有；契约级稳定）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// HTTP 状态码（仅 `kind = api` 时有）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// 人读文案（**不做兼容承诺**）。
    pub message: String,
    /// 是否值得重试。传输层错误与三个容量/存储码为真；语义错误一律为假。
    pub retriable: bool,
    /// CSV 解析失败的定位（仅 CSV 相关 usage 错误有）。
    /// Box 一下，避免把整个 StudioError 撑过 clippy 的 large-err 阈值。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Box<CsvErrorDetail>>,
}

impl StudioError {
    /// 通用构造。`retriable` 默认按 kind 推断。
    pub fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        let kind = kind.into();
        let retriable = matches!(kind.as_str(), "io" | "http");
        Self {
            kind,
            code: None,
            status: None,
            message: message.into(),
            retriable,
            details: None,
        }
    }

    /// 服务端语义错误。
    pub fn api(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        let code = code.into();
        // 码表（`docs/error-codes.md` §三）标注为可重试的三个。
        // 客户端默认把 API 错误视为不可重试，这里是 Studio 的**码级**覆盖。
        let retriable = matches!(
            code.as_str(),
            "TOO_MANY_QUERIES" | "MEMORY_PRESSURE" | "IO_ERROR"
        );
        Self {
            kind: "api".into(),
            code: Some(code),
            status: Some(status),
            message: message.into(),
            retriable,
            details: None,
        }
    }

    /// 客户端用法错误（请求未发出）。
    pub fn usage(message: impl Into<String>) -> Self {
        Self::new("usage", message)
    }

    /// 用户停止流式接收：与内核 `QUERY_CANCELLED` 同码，但可能没有 HTTP
    /// 状态（传输段是客户端主动关 socket，服务端不会回错误体）。
    /// UI 按 code 渲染“已取消 / 保留已收行”，不把它当查询失败。
    pub fn cancelled(message: impl Into<String>) -> Self {
        let mut e = Self::new("api", message);
        e.code = Some("QUERY_CANCELLED".into());
        e
    }

    /// CSV 值解析失败：保留结构化定位，UI 可据此复制出错行。
    pub fn usage_csv(message: impl Into<String>, details: CsvErrorDetail) -> Self {
        let mut e = Self::usage(message);
        e.details = Some(Box::new(details));
        e
    }

    /// 凭据管理器错误。**绝不在 message 里回显 secret**。
    pub fn secret(message: impl Into<String>) -> Self {
        Self::new("secret", message)
    }

    /// 本地存储（档案/历史/spool）错误。
    pub fn storage(message: impl Into<String>) -> Self {
        Self::new("storage", message)
    }

    /// 内部错误（不该发生的分支、线程 panic 等）。
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message)
    }

    /// 档案缺少密码/Token时的统一文案与码。
    pub fn missing_secret(what: &str) -> Self {
        Self::secret(format!(
            "档案没有保存{what}——请编辑连接，把{what}保存到系统凭据管理器后重试"
        ))
    }
}

impl fmt::Display for StudioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (&self.code, self.status) {
            (Some(code), Some(status)) => {
                write!(f, "[{code}] {status}: {}", self.message)
            }
            (Some(code), None) => write!(f, "[{code}]: {}", self.message),
            _ => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for StudioError {}

impl From<qsdb_client::Error> for StudioError {
    fn from(e: qsdb_client::Error) -> Self {
        match e {
            qsdb_client::Error::Io(io) => Self::new("io", io.to_string()),
            qsdb_client::Error::Http(m) => Self::new("http", m),
            qsdb_client::Error::Api {
                status,
                code,
                message,
            } => Self::api(status, code, message),
            qsdb_client::Error::Decode(m) => Self::new("decode", m),
            qsdb_client::Error::Usage(m) => Self::usage(m),
        }
    }
}

impl From<std::io::Error> for StudioError {
    fn from(e: std::io::Error) -> Self {
        Self::new("io", e.to_string())
    }
}

impl From<serde_json::Error> for StudioError {
    fn from(e: serde_json::Error) -> Self {
        Self::new("decode", format!("JSON: {e}"))
    }
}

impl From<csv::Error> for StudioError {
    fn from(e: csv::Error) -> Self {
        Self::storage(format!("CSV: {e}"))
    }
}

/// 结果别名。
pub type Result<T> = std::result::Result<T, StudioError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_code_survives_and_capacity_codes_are_retriable() {
        let e = StudioError::from(qsdb_client::Error::Api {
            status: 503,
            code: "TOO_MANY_QUERIES".into(),
            message: "busy".into(),
        });
        assert_eq!(e.kind, "api");
        assert_eq!(e.code.as_deref(), Some("TOO_MANY_QUERIES"));
        assert_eq!(e.status, Some(503));
        assert!(e.retriable, "容量类错误应按码可重试");

        let e = StudioError::from(qsdb_client::Error::Api {
            status: 400,
            code: "PARSE_ERROR".into(),
            message: "bad sql".into(),
        });
        assert!(!e.retriable);
    }

    #[test]
    fn io_is_retriable_semantic_is_not() {
        let io = StudioError::from(std::io::Error::other("broken pipe"));
        assert_eq!(io.kind, "io");
        assert!(io.retriable);

        let usage = StudioError::usage("bad url");
        assert!(!usage.retriable);
        assert_eq!(usage.kind, "usage");
    }

    #[test]
    fn read_only_is_never_retried() {
        let e = StudioError::api(503, "READ_ONLY", "read only");
        assert!(!e.retriable);
    }

    #[test]
    fn cancelled_uses_query_cancelled_code_without_http_status() {
        let e = StudioError::cancelled("stopped by user");
        assert_eq!(e.code.as_deref(), Some("QUERY_CANCELLED"));
        assert_eq!(e.status, None);
        assert!(!e.retriable);
    }
}
