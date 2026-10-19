//! CSV 导入（M2 §5.2.7）：`/schema` 是类型真相源 → 逐格严格解析 → bulk append。
//!
//! 纪律：
//! - **空串 = NULL**（设计明文）；其余值按列类型解析，错值报 CSV 行号 + 列名，
//!   **绝不静默换类型**；
//! - 每 10,000 行一批走 `Client::append`（bulk 通道）；append **非幂等**，
//!   失败消息会明确已写入行数；
//! - DECIMAL 用字符串 → 未缩放 i128 的精确转换（不经 f64）；
//! - 表列在 CSV 里缺失 → 显式报错；CSV 多出的列 → warning 后忽略；
//! - 目前 bulk 写侧不支持 INTERVAL（client Column 无该变体）→ 导入前显式拒绝。

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Instant;

use qsdb_client::{Client, Column, ColumnInfo};
use serde::{Deserialize, Serialize};

use crate::error::{CsvErrorDetail, Result, StudioError};

const BATCH_ROWS: usize = 10_000;
/// 预览读取的行数上限（checklist：前 100 行）。
const PREVIEW_ROWS: usize = 100;
/// 预览里列出的错误条数上限（计数仍然完整）。
const PREVIEW_ERRORS: usize = 50;
/// 预览单元格显示上限（不静默截断：超出会带省略号，导入仍用完整值）。
const PREVIEW_CELL_CHARS: usize = 160;

/// 导入进度（IPC 推送）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    /// 已成功 append 的行数。
    pub rows: u64,
    /// 已读取的 CSV 字节数。
    pub bytes: u64,
    /// 文件总字节数（0 = 未知）。
    pub total_bytes: u64,
}

/// 导入回执。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// 目标表。
    pub table: String,
    /// 写入行数。
    pub rows: u64,
    /// append 批数。
    pub batches: u64,
    /// 非致命提示（例如 CSV 多出的列）。
    pub warnings: Vec<String>,
    /// 墙钟耗时（ms）。
    pub elapsed_ms: f64,
}

/// 一条列映射：目标表列 → CSV 表头。`header = None` = 显式不映射。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvMapping {
    /// 目标表列名。
    pub column: String,
    /// CSV 表头（按名匹配，大小写不敏感）；None/空串 = 不映射。
    #[serde(default)]
    pub header: Option<String>,
}

/// 预览里的一列：映射结果、样例类型推断与逐值校验。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreviewColumn {
    /// 目标表列。
    pub name: String,
    /// 服务端类型。
    pub type_name: String,
    pub nullable: bool,
    pub partition: bool,
    /// 已解析的 CSV 表头（未映射时为 None）。
    pub header: Option<String>,
    /// CSV 列下标（未映射/表头不存在/重复时为 None）。
    pub header_index: Option<usize>,
    /// 映射问题的人读说明（未映射 / 表头不存在 / 重复映射）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mapping_error: Option<String>,
    /// 样例值推断出的类型名（BOOLEAN/BIGINT/DOUBLE/TIMESTAMP/DATE/TIME/BINARY/TEXT/空）。
    pub inferred: String,
    /// 样例里的非空值个数。
    pub non_null: usize,
    /// 样例里的空值个数（空串 = NULL）。
    pub nulls: usize,
    /// 样例里无法按目标类型解析的值的个数（完整计数）。
    pub error_count: usize,
    /// 前几个非空原始值（截断显示）。
    pub samples: Vec<String>,
}

/// 预览里的一条解析错误。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreviewError {
    /// 数据区 0 基记录下标（复制该行用）。
    pub record_index: u64,
    /// 人读行号（含表头，1 基）。
    pub line: u64,
    pub column: String,
    pub value: String,
    pub message: String,
}

/// 预览里的一行（按表列顺序；空串已转成 NULL）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreviewRow {
    /// 人读行号（含表头，1 基）。
    pub line: u64,
    /// 目标列顺序的值；`None` = NULL 或该列未映射。
    pub values: Vec<Option<String>>,
}

/// CSV 预览：前 100 行 + 映射 + 类型推断 + 样例校验。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreview {
    pub table: String,
    /// CSV 原始表头（按文件顺序）。
    pub headers: Vec<String>,
    /// 实际读取的数据行数（≤100）。
    pub rows_previewed: usize,
    /// 文件总字节数。
    pub total_bytes: u64,
    /// 按目标表列顺序的映射/推断/校验。
    pub columns: Vec<CsvPreviewColumn>,
    /// CSV 里未参与映射的表头。
    pub extras: Vec<String>,
    /// 未映射的目标列（含表头不存在/重复映射）。
    pub missing: Vec<String>,
    /// 是否所有目标列都有唯一映射。
    pub mapping_complete: bool,
    /// 样例解析错误（最多 50 条；计数见各列）。
    pub sample_errors: Vec<CsvPreviewError>,
    /// 前 100 行（按目标列顺序）。
    pub rows: Vec<CsvPreviewRow>,
}

#[derive(Debug, Clone, Copy)]
enum Kind {
    Bool,
    I8,
    I16,
    I32,
    I64,
    F32,
    F64,
    Utf8,
    Date32,
    Time64Ns,
    TimestampNs,
    Binary,
    Decimal { precision: u8, scale: i8 },
}

struct ColumnMap {
    /// 表 schema 每列在 CSV 里的下标。
    indices: Vec<usize>,
    warnings: Vec<String>,
}

/// 导入一份 CSV。`mappings` 为空时按表头名自动映射；非空时按给定映射
/// （每个目标列都要有且只指向一个 CSV 表头）。`emit` 在每批成功后调用。
pub fn import_csv<F>(
    client: &Client,
    table: &str,
    path: &Path,
    mappings: &[CsvMapping],
    mut emit: F,
) -> Result<ImportSummary>
where
    F: FnMut(ImportProgress),
{
    let started = Instant::now();
    let total_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let schema = client.schema(table)?;
    if schema.is_empty() {
        return Err(StudioError::usage(format!(
            "表 '{table}' 没有列定义（/schema 返回空）"
        )));
    }
    let kinds = kinds_for(&schema)?;

    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(false)
        .from_path(path)
        .map_err(|e| StudioError::storage(format!("打开 CSV {} 失败: {e}", path.display())))?;
    let headers = rdr
        .headers()
        .map_err(|e| csv_err("读取 CSV 表头", e))?
        .clone();
    let map = resolve_mapping(&schema, &headers, mappings)?;
    let mut warnings = map.warnings;

    let mut rows_total = 0u64;
    let mut batches = 0u64;
    let mut batch: Vec<Vec<Option<String>>> = Vec::with_capacity(BATCH_ROWS);
    let mut batch_lines: Vec<u64> = Vec::with_capacity(BATCH_ROWS);
    emit(ImportProgress {
        rows: 0,
        bytes: 0,
        total_bytes,
    });

    let flush = |batch: &mut Vec<Vec<Option<String>>>,
                 batch_lines: &mut Vec<u64>,
                 batches: &mut u64,
                 rows_total: &mut u64|
     -> Result<()> {
        if batch.is_empty() {
            return Ok(());
        }
        let cols = build_columns(&schema, &kinds, batch, batch_lines, *rows_total)?;
        let refs: Vec<(&str, Column)> = schema
            .iter()
            .zip(cols)
            .map(|(c, col)| (c.name.as_str(), col))
            .collect();
        match client.append(table, &refs) {
            Ok(_) => {}
            Err(e) => {
                let mut se = StudioError::from(e);
                se.message = format!(
                    "append 失败（此前已成功写入 {} 行；append 非幂等，失败批不保证未落盘，重试会重复）: {}",
                    *rows_total, se.message
                );
                return Err(se);
            }
        }
        *rows_total += batch.len() as u64;
        *batches += 1;
        batch.clear();
        batch_lines.clear();
        Ok(())
    };

    // 手动 read_record：rdr.records() 的借用会把 rdr.position() 一起借走。
    let mut rec = csv::StringRecord::new();
    let mut record_index = 0u64;
    loop {
        let more = rdr
            .read_record(&mut rec)
            .map_err(|e| csv_err("读取 CSV 记录", e))?;
        if !more {
            break;
        }
        let mut row = Vec::with_capacity(schema.len());
        for &idx in &map.indices {
            let field = rec.get(idx).unwrap_or("");
            row.push(if field.is_empty() {
                None
            } else {
                Some(field.to_string())
            });
        }
        record_index += 1;
        // 行号按记录序号计算（含表头，1 基）；跨行引号记录也稳定。
        batch_lines.push(record_index + 1);
        batch.push(row);
        if batch.len() >= BATCH_ROWS {
            flush(&mut batch, &mut batch_lines, &mut batches, &mut rows_total)?;
            emit(ImportProgress {
                rows: rows_total,
                bytes: rdr.position().byte(),
                total_bytes,
            });
        }
    }
    flush(&mut batch, &mut batch_lines, &mut batches, &mut rows_total)?;
    emit(ImportProgress {
        rows: rows_total,
        bytes: rdr.position().byte(),
        total_bytes,
    });

    if headers.len() > schema.len() {
        warnings.push(format!(
            "CSV 有 {} 列、表有 {} 列：按列名匹配，多出的列已忽略",
            headers.len(),
            schema.len()
        ));
    }
    Ok(ImportSummary {
        table: table.to_string(),
        rows: rows_total,
        batches,
        warnings,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

/// 读取一行原始 CSV（按数据记录下标；含引号转义），供 UI 复制出错行。
pub fn read_csv_row(path: &Path, record_index: u64) -> Result<String> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(false)
        .from_path(path)
        .map_err(|e| StudioError::storage(format!("打开 CSV {} 失败: {e}", path.display())))?;
    let mut rec = csv::StringRecord::new();
    let mut i = 0u64;
    loop {
        let more = rdr
            .read_record(&mut rec)
            .map_err(|e| csv_err("读取 CSV 记录", e))?;
        if !more {
            break;
        }
        if i == record_index {
            let mut wtr = csv::WriterBuilder::new()
                .has_headers(false)
                .from_writer(Vec::new());
            wtr.write_record(&rec)
                .map_err(|e| StudioError::storage(format!("CSV 行序列化失败: {e}")))?;
            let bytes = wtr
                .into_inner()
                .map_err(|e| StudioError::storage(format!("CSV 行序列化失败: {e}")))?;
            return String::from_utf8(bytes)
                .map_err(|e| StudioError::storage(format!("CSV 行不是 UTF-8: {e}")));
        }
        i += 1;
    }
    Err(StudioError::usage(format!(
        "CSV 没有第 {} 条数据记录（文件可能已变更）",
        record_index + 1
    )))
}

/// 预览前 100 行：表头映射、样例类型推断、逐值按目标类型校验。
/// **不写任何数据**；映射不完整/样例值有错都会如实报告，由 UI 决定是否允许导入。
pub fn preview_csv(
    client: &Client,
    table: &str,
    path: &Path,
    mappings: &[CsvMapping],
) -> Result<CsvPreview> {
    let total_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let schema = client.schema(table)?;
    if schema.is_empty() {
        return Err(StudioError::usage(format!(
            "表 '{table}' 没有列定义（/schema 返回空）"
        )));
    }
    let kinds = kinds_for(&schema)?;

    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(false)
        .from_path(path)
        .map_err(|e| StudioError::storage(format!("打开 CSV {} 失败: {e}", path.display())))?;
    let headers = rdr
        .headers()
        .map_err(|e| csv_err("读取 CSV 表头", e))?
        .clone();
    let normalized = normalize_headers(&headers)?;

    let overrides = parse_overrides(&schema, mappings)?;
    let mut resolved: Vec<(Option<String>, Option<usize>, Option<String>)> =
        Vec::with_capacity(schema.len());
    for c in &schema {
        let declared = match &overrides {
            None => normalized
                .iter()
                .position(|h| *h == c.name.to_ascii_lowercase())
                .map(|i| {
                    headers
                        .get(i)
                        .unwrap_or("")
                        .trim_start_matches('\u{feff}')
                        .trim()
                        .to_string()
                }),
            Some(map) => map
                .get(&c.name.to_ascii_lowercase())
                .and_then(|h| h.as_ref())
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty()),
        };
        let idx = declared
            .as_ref()
            .and_then(|h| normalized.iter().position(|n| *n == normalize_header(h)));
        resolved.push((declared, idx, None));
    }
    // 冲突检测：同一 CSV 列被多个目标列占用；后者显式报错，不猜。
    let mut owner: HashMap<usize, usize> = HashMap::new();
    for (ci, (declared, idx, err)) in resolved.iter_mut().enumerate() {
        let Some(i) = *idx else {
            if let Some(h) = declared {
                *err = Some(format!("CSV 里没有表头 '{h}'"));
            } else {
                *err = Some("未映射".into());
            }
            continue;
        };
        if let Some(prev) = owner.insert(i, ci) {
            *idx = None;
            *err = Some(format!(
                "表头 '{}' 已被列 '{}' 映射",
                declared.clone().unwrap_or_default(),
                schema[prev].name
            ));
        }
    }
    let used: HashSet<usize> = resolved.iter().filter_map(|(_, i, _)| *i).collect();
    let extras: Vec<String> = headers
        .iter()
        .enumerate()
        .filter(|(i, _)| !used.contains(i))
        .map(|(_, h)| h.trim().to_string())
        .collect();
    let missing: Vec<String> = schema
        .iter()
        .zip(&resolved)
        .filter(|(_, (_, idx, _))| idx.is_none())
        .map(|(c, _)| c.name.clone())
        .collect();

    let mut stats: Vec<ColStats> = schema
        .iter()
        .zip(&resolved)
        .map(|(_, (header, idx, err))| ColStats {
            header: header.clone(),
            header_index: *idx,
            mapping_error: err.clone(),
            inferred: "空".into(),
            non_null: 0,
            nulls: 0,
            error_count: 0,
            samples: Vec::new(),
            non_empty: Vec::new(),
        })
        .collect();
    let mut sample_errors: Vec<CsvPreviewError> = Vec::new();
    let mut rows: Vec<CsvPreviewRow> = Vec::new();
    let mut rec = csv::StringRecord::new();
    let mut record_index = 0u64;
    while rows.len() < PREVIEW_ROWS {
        let more = rdr
            .read_record(&mut rec)
            .map_err(|e| csv_err("读取 CSV 记录", e))?;
        if !more {
            break;
        }
        let line = record_index + 2;
        let mut values: Vec<Option<String>> = Vec::with_capacity(schema.len());
        for (ci, st) in stats.iter_mut().enumerate() {
            let Some(idx) = st.header_index else {
                values.push(None);
                continue;
            };
            let raw = rec.get(idx).unwrap_or("");
            if raw.is_empty() {
                st.nulls += 1;
                values.push(None);
                continue;
            }
            st.non_null += 1;
            if st.samples.len() < 3 {
                st.samples.push(clip(raw, 48));
            }
            st.non_empty.push(raw.to_string());
            if let Err(msg) = validate_cell(kinds[ci], raw) {
                st.error_count += 1;
                if sample_errors.len() < PREVIEW_ERRORS {
                    sample_errors.push(CsvPreviewError {
                        record_index,
                        line,
                        column: schema[ci].name.clone(),
                        value: clip(raw, 60),
                        message: msg,
                    });
                }
            }
            values.push(Some(clip(raw, PREVIEW_CELL_CHARS)));
        }
        rows.push(CsvPreviewRow { line, values });
        record_index += 1;
    }
    for st in &mut stats {
        st.inferred = infer_type(&st.non_empty).to_string();
    }
    let columns: Vec<CsvPreviewColumn> = schema
        .iter()
        .zip(stats)
        .map(|(c, st)| CsvPreviewColumn {
            name: c.name.clone(),
            type_name: c.type_name.clone(),
            nullable: c.nullable,
            partition: c.partition,
            header: if st.header_index.is_some() {
                st.header
            } else {
                None
            },
            header_index: st.header_index,
            mapping_error: st.mapping_error,
            inferred: st.inferred,
            non_null: st.non_null,
            nulls: st.nulls,
            error_count: st.error_count,
            samples: st.samples,
        })
        .collect();
    Ok(CsvPreview {
        table: table.to_string(),
        headers: headers.iter().map(|h| h.trim().to_string()).collect(),
        rows_previewed: rows.len(),
        total_bytes,
        columns,
        extras,
        mapping_complete: missing.is_empty(),
        missing,
        sample_errors,
        rows,
    })
}

struct ColStats {
    header: Option<String>,
    header_index: Option<usize>,
    mapping_error: Option<String>,
    inferred: String,
    non_null: usize,
    nulls: usize,
    error_count: usize,
    samples: Vec<String>,
    non_empty: Vec<String>,
}

fn clip(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max_chars).collect();
        out.push('…');
        out
    }
}

fn infer_type(values: &[String]) -> &'static str {
    if values.is_empty() {
        return "空";
    }
    let all = |f: fn(&str) -> std::result::Result<(), String>| values.iter().all(|v| f(v).is_ok());
    if all(|v| parse_bool(v).map(|_| ())) {
        return "BOOLEAN";
    }
    if all(|v| {
        v.trim()
            .parse::<i64>()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }) {
        return "BIGINT";
    }
    if all(|v| parse_f64(v).map(|_| ())) {
        return "DOUBLE";
    }
    if all(|v| parse_timestamp(v).map(|_| ())) {
        return "TIMESTAMP";
    }
    if all(|v| parse_date(v).map(|_| ())) {
        return "DATE";
    }
    if all(|v| parse_time(v).map(|_| ())) {
        return "TIME";
    }
    if values
        .iter()
        .all(|v| v.trim().starts_with("0x") || v.trim().starts_with("0X"))
        && all(|v| parse_hex(v).map(|_| ()))
    {
        return "BINARY";
    }
    "TEXT"
}

/// 按目标类型校验一个 CSV 值（语义与导入时逐格解析完全一致）。
fn validate_cell(kind: Kind, s: &str) -> std::result::Result<(), String> {
    match kind {
        Kind::Bool => parse_bool(s).map(|_| ()),
        Kind::I8 => s
            .trim()
            .parse::<i8>()
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Kind::I16 => s
            .trim()
            .parse::<i16>()
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Kind::I32 => s
            .trim()
            .parse::<i32>()
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Kind::I64 => s
            .trim()
            .parse::<i64>()
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Kind::F32 | Kind::F64 => parse_f64(s).map(|_| ()),
        Kind::Utf8 => Ok(()),
        Kind::Date32 => parse_date(s).map(|_| ()),
        Kind::Time64Ns => parse_time(s).map(|_| ()),
        Kind::TimestampNs => parse_timestamp(s).map(|_| ()),
        Kind::Binary => parse_hex(s).map(|_| ()),
        Kind::Decimal { precision, scale } => {
            let v = parse_decimal_unscaled(s, scale)?;
            let digits = v.unsigned_abs().to_string().len() as u32;
            if digits > precision as u32 {
                Err(format!("超出精度 {precision}（缩放后 {v} 有 {digits} 位）"))
            } else {
                Ok(())
            }
        }
    }
}

fn kinds_for(schema: &[ColumnInfo]) -> Result<Vec<Kind>> {
    schema
        .iter()
        .map(|c| {
            kind_for(&c.type_name)
                .map_err(|e| StudioError::usage(format!("列 '{}'（{}）: {e}", c.name, c.type_name)))
        })
        .collect()
}

fn csv_err(what: &str, e: csv::Error) -> StudioError {
    let pos = e
        .position()
        .map(|p| format!("（CSV 第 {} 行）", p.line()))
        .unwrap_or_default();
    StudioError::usage(format!("{what}{pos}失败: {e}"))
}

fn normalize_header(h: &str) -> String {
    h.trim_start_matches('\u{feff}').trim().to_ascii_lowercase()
}

fn normalize_headers(headers: &csv::StringRecord) -> Result<Vec<String>> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(headers.len());
    for (i, h) in headers.iter().enumerate() {
        let n = normalize_header(h);
        if n.is_empty() {
            return Err(StudioError::usage(format!("CSV 第 {} 列表头为空", i + 1)));
        }
        if !seen.insert(n.clone()) {
            return Err(StudioError::usage(format!(
                "CSV 表头重复：'{n}'（列名必须唯一才能按名映射）"
            )));
        }
        normalized.push(n);
    }
    Ok(normalized)
}

/// 用户显式映射：目标列（小写）→ CSV 表头（None = 不映射）。
/// 空列表 = 不使用覆盖（按表头名自动匹配）。
fn parse_overrides(
    schema: &[ColumnInfo],
    mappings: &[CsvMapping],
) -> Result<Option<HashMap<String, Option<String>>>> {
    if mappings.is_empty() {
        return Ok(None);
    }
    let mut map = HashMap::new();
    for m in mappings {
        let key = normalize_header(&m.column);
        if !schema.iter().any(|c| normalize_header(&c.name) == key) {
            return Err(StudioError::usage(format!(
                "列映射里有未知目标列 '{}'；表需要这些列：{}",
                m.column,
                schema
                    .iter()
                    .map(|x| x.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
        if map.insert(key, m.header.clone()).is_some() {
            return Err(StudioError::usage(format!(
                "列映射里目标列 '{}' 重复",
                m.column
            )));
        }
    }
    Ok(Some(map))
}

/// 导入用的严格映射：自动匹配或按用户映射；缺列/未知表头/重复占用都报错。
fn resolve_mapping(
    schema: &[ColumnInfo],
    headers: &csv::StringRecord,
    mappings: &[CsvMapping],
) -> Result<ColumnMap> {
    let normalized = normalize_headers(headers)?;
    let overrides = parse_overrides(schema, mappings)?;
    let mut indices = Vec::with_capacity(schema.len());
    let mut used: HashSet<usize> = HashSet::new();
    for c in schema {
        let idx = match &overrides {
            None => normalized
                .iter()
                .position(|h| *h == normalize_header(&c.name))
                .ok_or_else(|| {
                    StudioError::usage(format!(
                        "CSV 缺少表列 '{}'；表需要这些列：{}",
                        c.name,
                        schema
                            .iter()
                            .map(|x| x.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ))
                })?,
            Some(map) => {
                let header = map
                    .get(&normalize_header(&c.name))
                    .and_then(|h| h.as_deref())
                    .map(str::trim)
                    .filter(|h| !h.is_empty())
                    .ok_or_else(|| {
                        StudioError::usage(format!("目标列 '{}' 没有映射到 CSV 表头", c.name))
                    })?;
                normalized
                    .iter()
                    .position(|h| *h == normalize_header(header))
                    .ok_or_else(|| {
                        StudioError::usage(format!(
                            "CSV 里没有表头 '{header}'（目标列 '{}'）",
                            c.name
                        ))
                    })?
            }
        };
        if !used.insert(idx) {
            return Err(StudioError::usage(format!(
                "CSV 表头 '{}' 被多个目标列映射",
                headers.get(idx).unwrap_or("")
            )));
        }
        indices.push(idx);
    }
    let mut warnings = Vec::new();
    for (i, h) in headers.iter().enumerate() {
        if !used.contains(&i) {
            warnings.push(format!(
                "CSV 多出列 '{}'（第 {} 列）已忽略",
                h.trim(),
                i + 1
            ));
        }
    }
    Ok(ColumnMap { indices, warnings })
}

fn build_columns(
    schema: &[ColumnInfo],
    kinds: &[Kind],
    rows: &[Vec<Option<String>>],
    lines: &[u64],
    rows_before: u64,
) -> Result<Vec<Column>> {
    let mut out = Vec::with_capacity(kinds.len());
    for (ci, kind) in kinds.iter().enumerate() {
        let col = &schema[ci];
        let cell = |i: usize| rows[i].get(ci).and_then(|v| v.as_deref());
        let line = |i: usize| lines.get(i).copied().unwrap_or(rows_before + i as u64 + 2);
        let bad = |i: usize, raw: &str, msg: &str| {
            let shown: String = raw.chars().take(60).collect();
            let suffix = if raw.chars().count() > 60 { "…" } else { "" };
            StudioError::usage_csv(
                format!(
                    "CSV 第 {} 行（含表头）、列 '{}' 的值 {:?}{} 不合法: {msg}",
                    line(i),
                    col.name,
                    shown,
                    suffix
                ),
                CsvErrorDetail {
                    record_index: rows_before + i as u64,
                    line: line(i),
                    column: col.name.clone(),
                    value: Some(shown),
                },
            )
        };
        let column = match *kind {
            Kind::Bool => Column::Bool(
                rows.iter()
                    .enumerate()
                    .map(|(i, _)| match cell(i) {
                        None => Ok(None),
                        Some(s) => parse_bool(s).map(Some).map_err(|e| bad(i, s, &e)),
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
            Kind::I8 => Column::I8(
                rows.iter()
                    .enumerate()
                    .map(|(i, _)| match cell(i) {
                        None => Ok(None),
                        Some(s) => s
                            .trim()
                            .parse::<i8>()
                            .map(Some)
                            .map_err(|e| bad(i, s, &e.to_string())),
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
            Kind::I16 => Column::I16(
                rows.iter()
                    .enumerate()
                    .map(|(i, _)| match cell(i) {
                        None => Ok(None),
                        Some(s) => s
                            .trim()
                            .parse::<i16>()
                            .map(Some)
                            .map_err(|e| bad(i, s, &e.to_string())),
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
            Kind::I32 => Column::I32(
                rows.iter()
                    .enumerate()
                    .map(|(i, _)| match cell(i) {
                        None => Ok(None),
                        Some(s) => s
                            .trim()
                            .parse::<i32>()
                            .map(Some)
                            .map_err(|e| bad(i, s, &e.to_string())),
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
            Kind::I64 => Column::I64(
                rows.iter()
                    .enumerate()
                    .map(|(i, _)| match cell(i) {
                        None => Ok(None),
                        Some(s) => s
                            .trim()
                            .parse::<i64>()
                            .map(Some)
                            .map_err(|e| bad(i, s, &e.to_string())),
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
            Kind::F32 => Column::F32(
                rows.iter()
                    .enumerate()
                    .map(|(i, _)| match cell(i) {
                        None => Ok(None),
                        Some(s) => parse_f64(s)
                            .map(|v| Some(v as f32))
                            .map_err(|e| bad(i, s, &e)),
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
            Kind::F64 => Column::F64(
                rows.iter()
                    .enumerate()
                    .map(|(i, _)| match cell(i) {
                        None => Ok(None),
                        Some(s) => parse_f64(s).map(Some).map_err(|e| bad(i, s, &e)),
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
            Kind::Utf8 => Column::Utf8(rows.iter().map(|r| r[ci].clone()).collect()),
            Kind::Date32 => Column::dates(
                rows.iter()
                    .enumerate()
                    .map(|(i, _)| match cell(i) {
                        None => Ok(None),
                        Some(s) => parse_date(s).map(Some).map_err(|e| bad(i, s, &e)),
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
            Kind::Time64Ns => Column::Time64Ns(
                rows.iter()
                    .enumerate()
                    .map(|(i, _)| match cell(i) {
                        None => Ok(None),
                        Some(s) => parse_time(s).map(Some).map_err(|e| bad(i, s, &e)),
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
            Kind::TimestampNs => Column::timestamps(
                rows.iter()
                    .enumerate()
                    .map(|(i, _)| match cell(i) {
                        None => Ok(None),
                        Some(s) => parse_timestamp(s).map(Some).map_err(|e| bad(i, s, &e)),
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
            Kind::Binary => Column::Binary(
                rows.iter()
                    .enumerate()
                    .map(|(i, _)| match cell(i) {
                        None => Ok(None),
                        Some(s) => parse_hex(s).map(Some).map_err(|e| bad(i, s, &e)),
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
            Kind::Decimal { precision, scale } => {
                let mut unscaled = Vec::with_capacity(rows.len());
                for (i, _) in rows.iter().enumerate() {
                    match cell(i) {
                        None => unscaled.push(None),
                        Some(s) => {
                            let v = parse_decimal_unscaled(s, scale).map_err(|e| bad(i, s, &e))?;
                            let digits = v.unsigned_abs().to_string().len() as u32;
                            if digits > precision as u32 {
                                return Err(bad(
                                    i,
                                    s,
                                    &format!("超出精度 {precision}（缩放后 {v} 有 {digits} 位）"),
                                ));
                            }
                            unscaled.push(Some(v));
                        }
                    }
                }
                Column::Decimal128 {
                    unscaled,
                    precision,
                    scale,
                }
            }
        };
        out.push(column);
    }
    Ok(out)
}

fn kind_for(type_name: &str) -> std::result::Result<Kind, String> {
    let t = type_name.trim().to_ascii_uppercase();
    let has = |s: &str| t.contains(s);
    if has("DECIMAL") || has("NUMERIC") {
        let (precision, scale) = parse_decimal_type(&t)?;
        return Ok(Kind::Decimal { precision, scale });
    }
    if has("INTERVAL") {
        return Err("bulk 写侧暂不支持 INTERVAL（client Column 无该变体）".into());
    }
    if has("TIMESTAMP") || has("DATETIME") {
        return Ok(Kind::TimestampNs);
    }
    if has("TIME") {
        return Ok(Kind::Time64Ns);
    }
    if has("DATE") {
        return Ok(Kind::Date32);
    }
    if has("BIGINT") || has("INT64") {
        return Ok(Kind::I64);
    }
    if has("TINYINT") || has("INT8") {
        return Ok(Kind::I8);
    }
    if has("SMALLINT") || has("INT16") {
        return Ok(Kind::I16);
    }
    if has("INT") {
        return Ok(Kind::I32);
    }
    if has("DOUBLE") || has("FLOAT64") {
        return Ok(Kind::F64);
    }
    if has("REAL") || has("FLOAT32") || has("FLOAT") {
        return Ok(Kind::F32);
    }
    if has("BOOL") {
        return Ok(Kind::Bool);
    }
    if has("BINARY") || has("BLOB") || has("BYTEA") {
        return Ok(Kind::Binary);
    }
    if has("VARCHAR") || has("STRING") || has("UTF8") || has("TEXT") || has("CHAR") {
        return Ok(Kind::Utf8);
    }
    Err(format!("不支持的列类型 {type_name:?}"))
}

fn parse_decimal_type(t: &str) -> std::result::Result<(u8, i8), String> {
    let open = t.find('(').ok_or_else(|| format!("{t} 缺少精度/小数位"))?;
    let close = t.find(')').ok_or_else(|| format!("{t} 缺少 ')'"))?;
    let inner = &t[open + 1..close];
    let (p, s) = inner
        .split_once(',')
        .ok_or_else(|| format!("{t} 应为 DECIMAL(precision, scale)"))?;
    let precision: u8 = p
        .trim()
        .parse()
        .map_err(|_| format!("{t} 的 precision 不合法"))?;
    let scale: i8 = s
        .trim()
        .parse()
        .map_err(|_| format!("{t} 的 scale 不合法"))?;
    Ok((precision, scale))
}

fn parse_bool(s: &str) -> std::result::Result<bool, String> {
    match s.trim().to_ascii_lowercase().as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        other => Err(format!("BOOLEAN 只接受 true/false/1/0，实为 {other:?}")),
    }
}

fn parse_f64(s: &str) -> std::result::Result<f64, String> {
    let t = s.trim();
    match t {
        "NaN" | "nan" => Ok(f64::NAN),
        "Infinity" | "inf" | "+inf" => Ok(f64::INFINITY),
        "-Infinity" | "-inf" => Ok(f64::NEG_INFINITY),
        _ => t.parse::<f64>().map_err(|e| format!("浮点解析失败: {e}")),
    }
}

fn parse_date(s: &str) -> std::result::Result<i32, String> {
    let t = s.trim();
    let mut it = t.split('-');
    let y = it.next().ok_or("DATE 应为 YYYY-MM-DD")?;
    let m = it.next().ok_or("DATE 应为 YYYY-MM-DD")?;
    let d = it.next().ok_or("DATE 应为 YYYY-MM-DD")?;
    if it.next().is_some() {
        return Err("DATE 应为 YYYY-MM-DD".into());
    }
    if y.len() != 4 {
        return Err("DATE 年份应为 4 位".into());
    }
    let y: i64 = y.parse().map_err(|_| "DATE 年份不合法".to_string())?;
    let m: u32 = m.parse().map_err(|_| "DATE 月份不合法".to_string())?;
    let d: u32 = d.parse().map_err(|_| "DATE 日期不合法".to_string())?;
    if !(1..=12).contains(&m) {
        return Err(format!("DATE 月份 {m} 越界"));
    }
    if d == 0 || d > days_in_month(y, m) {
        return Err(format!("DATE {y:04}-{m:02} 没有第 {d} 天"));
    }
    let days = days_from_civil(y, m, d);
    i32::try_from(days).map_err(|_| "DATE 超出 i32 天数范围".into())
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (i64::from(m) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn parse_time(s: &str) -> std::result::Result<i64, String> {
    let t = s.trim();
    if t.contains('+') || t.contains('-') {
        return Err("TIME 不带时区偏移".into());
    }
    let mut it = t.split(':');
    let h: u32 = it
        .next()
        .ok_or("TIME 应为 HH:MM:SS[.f]")?
        .parse()
        .map_err(|_| "TIME 小时不合法".to_string())?;
    let m: u32 = it
        .next()
        .ok_or("TIME 应为 HH:MM:SS[.f]")?
        .parse()
        .map_err(|_| "TIME 分钟不合法".to_string())?;
    let sec = it.next().ok_or("TIME 应为 HH:MM:SS[.f]")?;
    if it.next().is_some() {
        return Err("TIME 应为 HH:MM:SS[.f]".into());
    }
    let (secs, nanos) = split_seconds(sec)?;
    if h > 23 || m > 59 || secs > 59 {
        return Err(format!("TIME {t:?} 越界（小时<24、分/秒<60）"));
    }
    Ok((i64::from(h) * 3600 + i64::from(m) * 60 + i64::from(secs)) * 1_000_000_000 + nanos)
}

fn split_seconds(sec: &str) -> std::result::Result<(u32, i64), String> {
    let (s, frac) = match sec.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (sec, None),
    };
    let secs: u32 = s.trim().parse().map_err(|_| "秒不合法".to_string())?;
    let nanos = match frac {
        None => 0,
        Some(f) => {
            if f.is_empty() || f.len() > 9 || !f.chars().all(|c| c.is_ascii_digit()) {
                return Err("小数秒应为 1..9 位数字".into());
            }
            let mut padded = String::from(f);
            while padded.len() < 9 {
                padded.push('0');
            }
            padded
                .parse::<i64>()
                .map_err(|_| "小数秒不合法".to_string())?
        }
    };
    Ok((secs, nanos))
}

fn parse_timestamp(s: &str) -> std::result::Result<i64, String> {
    let t = s.trim();
    let t = t
        .strip_suffix('Z')
        .or_else(|| t.strip_suffix('z'))
        .unwrap_or(t);
    let sep = t.find('T').or_else(|| t.find(' '));
    let Some(sep) = sep else {
        return Err("TIMESTAMP 应为 YYYY-MM-DD[T ]HH:MM:SS[.f][Z]".into());
    };
    let (date, time) = t.split_at(sep);
    let time = &time[1..];
    if time.contains('+') || time.contains('-') {
        return Err("TIMESTAMP 不支持时区偏移（请用 UTC / Z）".into());
    }
    let days = i64::from(parse_date(date)?);
    let tod = parse_time(time)?;
    days.checked_mul(86_400_000_000_000)
        .and_then(|d| d.checked_add(tod))
        .ok_or_else(|| "TIMESTAMP 超出 i64 纳秒范围".to_string())
}

fn parse_hex(s: &str) -> std::result::Result<Vec<u8>, String> {
    let t = s.trim();
    let t = t
        .strip_prefix("0x")
        .or_else(|| t.strip_prefix("0X"))
        .unwrap_or(t);
    if !t.len().is_multiple_of(2) {
        return Err("BINARY 的 hex 长度必须为偶数".into());
    }
    let mut out = Vec::with_capacity(t.len() / 2);
    let b = t.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let hi = hex_digit(b[i])?;
        let lo = hex_digit(b[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

fn hex_digit(b: u8) -> std::result::Result<u8, String> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        other => Err(format!("BINARY 含非 hex 字符 {:?}", other as char)),
    }
}

/// 与 `qsdb-client` 的 DECIMAL 字符串解析同一套规则（复制一份以保留行/列错误）。
fn parse_decimal_unscaled(t: &str, scale: i8) -> std::result::Result<i128, String> {
    let t = t.trim();
    let (neg, body) = match t.strip_prefix('-') {
        Some(b) => (true, b),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let (int_part, frac_part) = match body.split_once('.') {
        Some((a, b)) => (a, b),
        None => (body, ""),
    };
    if int_part.is_empty() && frac_part.is_empty() {
        return Err("没有数字".into());
    }
    if !int_part.chars().all(|c| c.is_ascii_digit())
        || !frac_part.chars().all(|c| c.is_ascii_digit())
    {
        return Err("含非数字字符".into());
    }
    let scale = scale.max(0);
    if frac_part.len() as i8 > scale {
        return Err(format!(
            "小数位 {} 超出 scale {scale}（多出的位拒绝——四舍五入是编造值）",
            frac_part.len()
        ));
    }
    let digits = format!(
        "{int_part}{frac_part}{}",
        "0".repeat((scale as usize) - frac_part.len())
    );
    let v: i128 = digits.parse().map_err(|_| "超出 i128".to_string())?;
    Ok(if neg { -v } else { v })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_is_exact_and_strict() {
        assert_eq!(parse_decimal_unscaled("30.80", 2).unwrap(), 3080);
        assert_eq!(parse_decimal_unscaled("-0.05", 2).unwrap(), -5);
        assert_eq!(parse_decimal_unscaled(".5", 2).unwrap(), 50);
        assert!(parse_decimal_unscaled("1.234", 2).is_err());
        assert!(parse_decimal_unscaled("1e3", 2).is_err());
    }

    #[test]
    fn dates_times_timestamps() {
        assert_eq!(parse_date("1970-01-01").unwrap(), 0);
        assert_eq!(parse_date("2022-01-08").unwrap(), 19_000);
        assert!(parse_date("2026-02-30").is_err());
        assert_eq!(parse_time("12:00:00").unwrap(), 43_200 * 1_000_000_000);
        assert_eq!(parse_time("00:00:01.5").unwrap(), 1_500_000_000);
        assert!(parse_time("24:00:00").is_err());
        assert_eq!(
            parse_timestamp("2026-01-01T00:00:00Z").unwrap(),
            parse_timestamp("2026-01-01 00:00:00").unwrap()
        );
        assert!(parse_timestamp("2026-01-01T00:00:00+08:00").is_err());
    }

    #[test]
    fn bool_float_hex() {
        assert!(parse_bool(" TRUE ").unwrap());
        assert!(!parse_bool("0").unwrap());
        assert!(parse_bool("yes").is_err());
        assert!(parse_f64("NaN").unwrap().is_nan());
        assert_eq!(parse_f64("-Infinity").unwrap(), f64::NEG_INFINITY);
        assert_eq!(parse_hex("00abFF").unwrap(), vec![0x00, 0xab, 0xff]);
        assert_eq!(parse_hex("0x00ab").unwrap(), vec![0x00, 0xab]);
        assert!(parse_hex("abc").is_err());
    }

    #[test]
    fn types_map_explicitly_and_reject_interval() {
        assert!(matches!(kind_for("BIGINT").unwrap(), Kind::I64));
        assert!(matches!(kind_for("TINYINT").unwrap(), Kind::I8));
        assert!(matches!(kind_for("SMALLINT").unwrap(), Kind::I16));
        assert!(matches!(kind_for("FLOAT").unwrap(), Kind::F32));
        assert!(matches!(kind_for("DOUBLE").unwrap(), Kind::F64));
        assert!(matches!(kind_for("BOOLEAN").unwrap(), Kind::Bool));
        assert!(matches!(kind_for("STRING").unwrap(), Kind::Utf8));
        assert!(matches!(
            kind_for("DECIMAL(10, 2)").unwrap(),
            Kind::Decimal {
                precision: 10,
                scale: 2
            }
        ));
        assert!(kind_for("INTERVAL").is_err());
        assert!(kind_for("GEOMETRY").is_err());
    }

    #[test]
    fn headers_map_case_insensitively_and_report_extras() {
        let schema = vec![
            ColumnInfo {
                name: "id".into(),
                type_name: "BIGINT".into(),
                nullable: true,
                partition: false,
            },
            ColumnInfo {
                name: "Name".into(),
                type_name: "STRING".into(),
                nullable: true,
                partition: false,
            },
        ];
        let headers = csv::StringRecord::from(vec!["ID", "extra", "name"]);
        let map = resolve_mapping(&schema, &headers, &[]).unwrap();
        assert_eq!(map.indices, vec![0, 2]);
        assert_eq!(map.warnings.len(), 1);

        let missing = csv::StringRecord::from(vec!["id"]);
        assert!(resolve_mapping(&schema, &missing, &[]).is_err());
        let dup = csv::StringRecord::from(vec!["id", "ID"]);
        assert!(resolve_mapping(&schema, &dup, &[]).is_err());
    }

    fn schema() -> Vec<ColumnInfo> {
        vec![
            ColumnInfo {
                name: "id".into(),
                type_name: "BIGINT".into(),
                nullable: true,
                partition: false,
            },
            ColumnInfo {
                name: "Name".into(),
                type_name: "STRING".into(),
                nullable: true,
                partition: false,
            },
            ColumnInfo {
                name: "dt".into(),
                type_name: "DATE".into(),
                nullable: true,
                partition: true,
            },
        ]
    }

    #[test]
    fn explicit_mapping_can_remap_and_rejects_incomplete_or_duplicate() {
        let schema = schema();
        let headers = csv::StringRecord::from(vec!["id", "label", "day", "junk"]);

        let ok = resolve_mapping(
            &schema,
            &headers,
            &[
                CsvMapping {
                    column: "id".into(),
                    header: Some("id".into()),
                },
                CsvMapping {
                    column: "name".into(),
                    header: Some("LABEL".into()),
                },
                CsvMapping {
                    column: "dt".into(),
                    header: Some("day".into()),
                },
            ],
        )
        .unwrap();
        assert_eq!(ok.indices, vec![0, 1, 2]);
        assert_eq!(ok.warnings.len(), 1);

        // 缺一列 → 显式拒绝（不会悄悄返回 NULL）。
        assert!(
            resolve_mapping(
                &schema,
                &headers,
                &[
                    CsvMapping {
                        column: "id".into(),
                        header: Some("id".into()),
                    },
                    CsvMapping {
                        column: "name".into(),
                        header: Some("label".into()),
                    },
                ],
            )
            .is_err()
        );

        // 两个目标列抢同一表头 → 拒绝。
        assert!(
            resolve_mapping(
                &schema,
                &headers,
                &[
                    CsvMapping {
                        column: "id".into(),
                        header: Some("id".into()),
                    },
                    CsvMapping {
                        column: "name".into(),
                        header: Some("id".into()),
                    },
                    CsvMapping {
                        column: "dt".into(),
                        header: Some("day".into()),
                    },
                ],
            )
            .is_err()
        );

        // 不存在的表头 → 拒绝。
        assert!(
            resolve_mapping(
                &schema,
                &headers,
                &[
                    CsvMapping {
                        column: "id".into(),
                        header: Some("id".into()),
                    },
                    CsvMapping {
                        column: "name".into(),
                        header: Some("nope".into()),
                    },
                    CsvMapping {
                        column: "dt".into(),
                        header: Some("day".into()),
                    },
                ],
            )
            .is_err()
        );
    }

    #[test]
    fn inference_covers_documented_types() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(infer_type(&s(&["true", "0"])), "BOOLEAN");
        assert_eq!(infer_type(&s(&["1", "-2"])), "BIGINT");
        assert_eq!(infer_type(&s(&["1.5", "2"])), "DOUBLE");
        assert_eq!(infer_type(&s(&["2026-01-02T03:04:05Z"])), "TIMESTAMP");
        assert_eq!(infer_type(&s(&["2026-01-02"])), "DATE");
        assert_eq!(infer_type(&s(&["12:34:56"])), "TIME");
        assert_eq!(infer_type(&s(&["0x00ff"])), "BINARY");
        assert_eq!(infer_type(&s(&["abc"])), "TEXT");
        assert_eq!(infer_type(&[]), "空");
    }

    #[test]
    fn cell_validation_matches_import_semantics() {
        assert!(validate_cell(Kind::I64, "42").is_ok());
        assert!(validate_cell(Kind::I64, "4.2").is_err());
        assert!(validate_cell(Kind::Bool, "TRUE").is_ok());
        assert!(validate_cell(Kind::Bool, "yes").is_err());
        assert!(validate_cell(Kind::Date32, "2026-02-30").is_err());
        assert!(
            validate_cell(
                Kind::Decimal {
                    precision: 4,
                    scale: 2
                },
                "12.34"
            )
            .is_ok()
        );
        assert!(
            validate_cell(
                Kind::Decimal {
                    precision: 3,
                    scale: 2
                },
                "12.34"
            )
            .is_err()
        );
        assert!(validate_cell(Kind::Utf8, "anything").is_ok());
    }

    #[test]
    fn read_csv_row_returns_escaped_record() {
        let dir =
            std::env::temp_dir().join(format!("qsdb-studio-import-row-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rows.csv");
        std::fs::write(&path, "id,name\n1,alice\n2,\"bob, jr.\"\n").unwrap();
        assert_eq!(read_csv_row(&path, 0).unwrap().trim_end(), "1,alice");
        assert_eq!(read_csv_row(&path, 1).unwrap().trim_end(), "2,\"bob, jr.\"");
        assert!(read_csv_row(&path, 2).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
