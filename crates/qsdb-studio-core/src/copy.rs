//! COPY 导出向导的 SQL 生成（M2 §5.2.6）。
//!
//! 服务端原语：`COPY (<SELECT>) TO '<目录>' (FORMAT PARQUET[, PARTITION_BY (…)])`
//! 或 `(FORMAT CSV[, HEADER])`。**Parquet 目标是目录**（可出多个 part）；
//! **CSV 目标是单文件**，且不支持 `PARTITION_BY`（内核的 read_csv 没有 hive
//! 目录语义，写得出读不回——内核在 translate 层就拒）。
//!
//! 导出完成后：
//! - `verify_sql` 用 `read_parquet('<dir>/**/*.parquet')` / `read_csv('<file>')`
//!   在服务端读回一小页，验证往返；
//! - 下载走 client 的 `download_file`（admin）。

use serde::{Deserialize, Serialize};

use crate::error::{Result, StudioError};

/// 导出格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CopyFormat {
    /// Parquet 数据集（目录 + hive 布局）。
    #[default]
    Parquet,
    /// CSV 单文件。
    Csv,
}

/// COPY 向导输入（IPC 形态）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CopyInput {
    /// 源查询 SQL（末尾分号会被去掉）。
    pub query: String,
    /// 服务端目标（Parquet = 目录；CSV = 文件）。
    pub target: String,
    /// 格式。
    pub format: CopyFormat,
    /// PARTITION_BY 列（Parquet 专用；CSV 必须为空）。
    pub partition_by: Vec<String>,
    /// CSV 是否写表头（默认 true）。
    pub header: bool,
}

/// 执行回执（IPC 形态）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    /// 实际执行的 COPY SQL（可展示/复制）。
    pub sql: String,
    /// 读回验证 SQL（用户点“验证读回”时执行）。
    pub verify_sql: String,
    /// 服务端回执（人读，不做兼容承诺）。
    pub message: Option<String>,
    /// 结构化命令名（COPY）。
    pub command: Option<String>,
    /// 导出行数（服务端回执）。
    pub rows_affected: Option<u64>,
    /// query id。
    pub query_id: Option<String>,
    /// 墙钟耗时（ms）。
    pub elapsed_ms: f64,
}

fn sql_string(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn valid_ident(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 生成 COPY SQL；所有校验在发请求前完成，错误文案明确。
pub fn build_copy_sql(input: &CopyInput) -> Result<String> {
    let query = input.query.trim().trim_end_matches(';').trim();
    if query.is_empty() {
        return Err(StudioError::usage("COPY 的源查询不能为空"));
    }
    let target = input.target.trim();
    if target.is_empty() {
        return Err(StudioError::usage("COPY 的目标路径不能为空"));
    }
    let mut parts: Vec<String> = Vec::new();
    match input.format {
        CopyFormat::Parquet => {
            if target.to_ascii_lowercase().ends_with(".parquet") {
                return Err(StudioError::usage(
                    "Parquet 的 COPY 目标是**目录**不是文件——去掉 .parquet 后缀（会产出 part-*.parquet）",
                ));
            }
            parts.push("FORMAT PARQUET".into());
            if !input.partition_by.is_empty() {
                let mut seen = std::collections::HashSet::new();
                for c in &input.partition_by {
                    let c = c.trim();
                    if !valid_ident(c) {
                        return Err(StudioError::usage(format!(
                            "PARTITION_BY 列名 {c:?} 不是合法标识符（[A-Za-z_][A-Za-z0-9_]*）"
                        )));
                    }
                    if !seen.insert(c.to_ascii_lowercase()) {
                        return Err(StudioError::usage(format!("PARTITION_BY 列重复: {c}")));
                    }
                }
                parts.push(format!(
                    "PARTITION_BY ({})",
                    input
                        .partition_by
                        .iter()
                        .map(|c| c.trim())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
        }
        CopyFormat::Csv => {
            if !input.partition_by.is_empty() {
                return Err(StudioError::usage(
                    "CSV 导出不支持 PARTITION_BY（read_csv 没有 hive 目录语义，写得出读不回）",
                ));
            }
            parts.push("FORMAT CSV".into());
            if input.header {
                parts.push("HEADER".into());
            }
        }
    }
    Ok(format!(
        "COPY ({query}) TO {} ({})",
        sql_string(target),
        parts.join(", ")
    ))
}

/// 服务端读回验证 SQL（Parquet 用目录 glob；CSV 单文件）。
pub fn verify_sql(input: &CopyInput) -> Result<String> {
    let target = input.target.trim();
    if target.is_empty() {
        return Err(StudioError::usage("COPY 的目标路径不能为空"));
    }
    Ok(match input.format {
        CopyFormat::Parquet => format!(
            "SELECT * FROM read_parquet({}) LIMIT 200",
            sql_string(&format!("{}/**/*.parquet", target.trim_end_matches('/')))
        ),
        CopyFormat::Csv => format!("SELECT * FROM read_csv({}) LIMIT 200", sql_string(target)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(format: CopyFormat) -> CopyInput {
        CopyInput {
            query: "SELECT * FROM sales WHERE dt = DATE '2026-01-01';".into(),
            target: "exports/sales".into(),
            format,
            partition_by: vec![],
            header: true,
        }
    }

    #[test]
    fn parquet_sql_strips_semicolon_and_quotes_target() {
        let mut i = input(CopyFormat::Parquet);
        i.target = "exports/o'brien".into();
        i.partition_by = vec!["dt".into(), "region".into()];
        let sql = build_copy_sql(&i).unwrap();
        assert_eq!(
            sql,
            "COPY (SELECT * FROM sales WHERE dt = DATE '2026-01-01') TO 'exports/o''brien' (FORMAT PARQUET, PARTITION_BY (dt, region))"
        );
        assert_eq!(
            verify_sql(&i).unwrap(),
            "SELECT * FROM read_parquet('exports/o''brien/**/*.parquet') LIMIT 200"
        );
    }

    #[test]
    fn csv_is_single_file_and_rejects_partition_by() {
        let i = input(CopyFormat::Csv);
        assert_eq!(
            build_copy_sql(&i).unwrap(),
            "COPY (SELECT * FROM sales WHERE dt = DATE '2026-01-01') TO 'exports/sales' (FORMAT CSV, HEADER)"
        );
        let mut no_header = input(CopyFormat::Csv);
        no_header.header = false;
        assert!(
            build_copy_sql(&no_header)
                .unwrap()
                .ends_with("(FORMAT CSV)")
        );

        let mut partitioned = input(CopyFormat::Csv);
        partitioned.partition_by = vec!["dt".into()];
        assert!(build_copy_sql(&partitioned).is_err());
    }

    #[test]
    fn rejects_bad_inputs() {
        let mut i = input(CopyFormat::Parquet);
        i.query = " ;; ".into();
        assert!(build_copy_sql(&i).is_err());

        let mut i = input(CopyFormat::Parquet);
        i.target = "x.parquet".into();
        assert!(build_copy_sql(&i).is_err());

        let mut i = input(CopyFormat::Parquet);
        i.partition_by = vec!["dt; DROP".into()];
        assert!(build_copy_sql(&i).is_err());
    }
}
