//! CSV 导出/落盘的公共部分。
//!
//! 网格数据 → CSV 在前端拼（小结果，≤10 万行）；流式结果在 core 里边读 spool
//! 边写（行数无上限）。两边共用同一套单元格规则：**NULL = 空串**，
//! 其余按线上值原样；引号/逗号/换行由 RFC 4180 转义。

use std::path::Path;

use serde_json::Value;

use crate::error::{Result, StudioError};

/// 一个线上单元格 → CSV 文本。
pub fn csv_cell(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        // 线上值只有标量；真出现嵌套结构就如实序列化，不丢信息。
        other => other.to_string(),
    }
}

/// 原子写一个文本文件（可选 UTF-8 BOM，Excel 友好）。
pub fn write_text_file(path: &Path, text: &str, bom: bool) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            StudioError::storage(format!("创建目录 {} 失败: {e}", parent.display()))
        })?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|s| s.to_str()).unwrap_or("csv")
    ));
    let mut body = String::with_capacity(text.len() + 3);
    if bom {
        body.push('\u{feff}');
    }
    body.push_str(text);
    std::fs::write(&tmp, body.as_bytes())
        .map_err(|e| StudioError::storage(format!("写入 {} 失败: {e}", tmp.display())))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| StudioError::storage(format!("替换 {} 失败: {e}", path.display())))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_cell_never_invents_values() {
        assert_eq!(csv_cell(&Value::Null), "");
        assert_eq!(csv_cell(&serde_json::json!("123")), "123");
        assert_eq!(csv_cell(&serde_json::json!(123)), "123");
        assert_eq!(csv_cell(&serde_json::json!("NaN")), "NaN");
        assert_eq!(csv_cell(&serde_json::json!(true)), "true");
    }

    #[test]
    fn writes_bom_and_keeps_utf8() {
        let tmp = tempfile::TempDir::new().unwrap();
        let p = tmp.path().join("out.csv");
        write_text_file(&p, "名称,值\n中文,1\n", true).unwrap();
        let bytes = std::fs::read(&p).unwrap();
        assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("中文,1"));
    }
}
