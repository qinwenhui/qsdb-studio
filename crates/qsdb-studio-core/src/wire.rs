//! 网格的线上值形态（设计 §七，冻结）。
//!
//! **不做数值启发**：JSON 通道里 `"123"` 恒是字符串、Decimal 恒是字符串、
//! Binary 恒是小写 hex。本模块只负责把 `qsdb-client` 的标签化值翻译成
//! 「列类型 + 可 JSON 化的单元格」，渲染对齐/徽章由前端按列类型决定。
//!
//! 两个通道的差异：
//! - `bulk` 只有 1..7 标签（Bool/I32/I64/F64/Utf8/Date32/TimestampNs）；
//! - `rows` 另带 I8/I16/F32/Binary/Decimal128/Time64Ns/Interval 与列级元数据
//!   （`decimal = (precision, scale)`、`tz`）。
//!
//! 服务端在 `bulk` 遇到不支持的类型会回 `UNSUPPORTED`（不静默降级）——
//! 执行层会在**明确标注**的前提下改走 `rows` 通道（见 `query.rs`）。

use qsdb_client::{BulkTable, Chunk, ColumnDesc, ColumnInfo, RowsData, Tag, ValueRef};
use serde::{Deserialize, Serialize};

use crate::error::Result;

/// 网格列描述。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireColumn {
    /// 列名。
    pub name: String,
    /// 类型标签（`bool` / `i8` … `timestampns` / `decimal128` / `interval`）。
    pub tag: String,
    /// 人读类型名（元数据面原样透出；渲染只判 `tag`）。
    pub type_name: String,
    /// 是否可空（`bulk` 没有列级可空性，恒 `false`；NULL 以值形态表达）。
    pub nullable: bool,
    /// Decimal128 的 `(precision, scale)`（`rows` 才有）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decimal: Option<(u8, i8)>,
    /// TimestampNs 的时区名（`rows` 才有；显示统一按 UTC `Z`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tz: Option<String>,
}

/// 挂载库（元数据树根）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireDb {
    /// 库名。
    pub name: String,
    /// 只读挂载（写 → `READ_ONLY`，UI 标锁）。
    pub read_only: bool,
}

/// 表的列（元数据面）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireColumnInfo {
    /// 列名。
    pub name: String,
    /// 服务端类型名（原样透出）。
    pub type_name: String,
    /// 是否可空。
    pub nullable: bool,
    /// 是否分区列。
    pub partition: bool,
}

/// 表 + 列集（`/tables?withSchema=1`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireTable {
    /// 表名（多挂载时可能是 `db.table`）。
    pub name: String,
    /// 列。
    pub columns: Vec<WireColumnInfo>,
}

/// 分区（generation/rows/segments/bytes）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WirePartition {
    /// 分区名（目录名形态）。
    pub name: String,
    /// 提交计数器。
    pub generation: u64,
    /// 行数。
    pub rows: u64,
    /// 段数。
    pub segments: u64,
    /// 段文件字节总量（压缩后落盘体积；单表大小 = 各分区求和）。
    pub bytes: u64,
}

/// 标签的线上名（前端按它分支渲染）。
pub fn tag_name(tag: Tag) -> &'static str {
    match tag {
        Tag::Bool => "bool",
        Tag::I8 => "i8",
        Tag::I16 => "i16",
        Tag::I32 => "i32",
        Tag::I64 => "i64",
        Tag::F32 => "f32",
        Tag::F64 => "f64",
        Tag::Utf8 => "utf8",
        Tag::Binary => "binary",
        Tag::Date32 => "date32",
        Tag::Time64Ns => "time64ns",
        Tag::TimestampNs => "timestampns",
        Tag::Decimal128 => "decimal128",
        Tag::Interval => "interval",
    }
}

/// 元数据面的类型名（服务端原样给的 Arrow/逻辑类型名）→ 渲染标签。
///
/// **未知类型回退 `utf8`**：宁可按文本渲染，也不把它猜成数字（值形态契约的
/// 事故根因就是"看着像数字就当数字"）。
pub fn tag_from_type_name(type_name: &str) -> &'static str {
    let t = type_name.trim().to_ascii_uppercase();
    let has = |needle: &str| t.contains(needle);
    if has("DECIMAL") || has("NUMERIC") {
        "decimal128"
    } else if has("TIMESTAMP") || has("DATETIME") {
        "timestampns"
    } else if has("TIME") {
        "time64ns"
    } else if has("DATE") {
        "date32"
    } else if has("INTERVAL") {
        // 必须在泛化的 `INT` 之前：INTERVAL 里含有子串 "INT"。
        "interval"
    } else if has("BIGINT") || has("INT64") {
        "i64"
    } else if has("TINYINT") || has("INT8") {
        "i8"
    } else if has("SMALLINT") || has("INT16") {
        "i16"
    } else if has("INT") {
        "i32"
    } else if has("DOUBLE") || has("FLOAT64") {
        "f64"
    } else if has("REAL") || has("FLOAT32") || has("FLOAT") {
        "f32"
    } else if has("BOOL") {
        "bool"
    } else if has("BINARY") || has("BLOB") || has("BYTEA") {
        "binary"
    } else {
        "utf8"
    }
}

fn column_from_desc(d: &ColumnDesc) -> WireColumn {
    WireColumn {
        name: d.name.clone(),
        tag: tag_name(d.tag).to_string(),
        type_name: d.tag.name().to_string(),
        nullable: d.nullable,
        decimal: d.decimal,
        tz: d.tz.clone(),
    }
}

/// 列描述 → 网格列。
pub fn columns_from_descs(descs: &[ColumnDesc]) -> Vec<WireColumn> {
    descs.iter().map(column_from_desc).collect()
}

/// 元数据列 → 网格列（JSON 通道的 schema）。
pub fn column_from_info(info: &ColumnInfo) -> WireColumn {
    WireColumn {
        name: info.name.clone(),
        tag: tag_from_type_name(&info.type_name).to_string(),
        type_name: info.type_name.clone(),
        nullable: info.nullable,
        decimal: None,
        tz: None,
    }
}

/// 单个值 → 线上单元格。
///
/// 规则（§七）：
/// - NULL → JSON null；
/// - 整数 → number（超出 JS 安全整数用十进制字符串，**不丢精度**）；
/// - 浮点 → number；NaN/±Inf → `"NaN"` / `"Infinity"` / `"-Infinity"`；
/// - Decimal → 按 scale 插小数点的字符串；
/// - Binary → 小写 hex；
/// - DATE / TIME / TIMESTAMP → 契约形态字符串（UTC，`Z` 结尾）。
pub fn value_to_wire(v: ValueRef<'_>, decimal: Option<(u8, i8)>) -> serde_json::Value {
    use serde_json::Value;
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Bool(b) => Value::Bool(b),
        ValueRef::I8(v) => Value::from(i64::from(v)),
        ValueRef::I16(v) => Value::from(i64::from(v)),
        ValueRef::I32(v) => Value::from(i64::from(v)),
        ValueRef::I64(v) => {
            // JS Number 的安全整数上限 2^53-1；越界时用字符串保精度。
            if (-(1i64 << 53) + 1..=(1i64 << 53) - 1).contains(&v) {
                Value::from(v)
            } else {
                Value::String(v.to_string())
            }
        }
        ValueRef::F32(v) => float_to_wire(f64::from(v), Some(&v.to_string())),
        ValueRef::F64(v) => float_to_wire(v, None),
        ValueRef::Utf8(s) => Value::String(s.to_string()),
        ValueRef::Binary(b) => Value::String(hex_lower(b)),
        ValueRef::Date32(days) => Value::String(format_date(days)),
        ValueRef::Time64Ns(ns) => Value::String(format_time_ns(ns)),
        ValueRef::TimestampNs(ns) => Value::String(format_timestamp_ns(ns)),
        ValueRef::Decimal128(unscaled) => Value::String(match decimal {
            Some((_, scale)) => format_decimal(unscaled, scale),
            None => unscaled.to_string(),
        }),
        ValueRef::Interval {
            months,
            days,
            nanos,
        } => Value::String(format!("{months}mo {days}d {nanos}ns")),
    }
}

/// 浮点：非有限值用固定拼写（J7：生态惯用 `Infinity`，不是 Rust 的 `inf`）。
fn float_to_wire(v: f64, shortest: Option<&str>) -> serde_json::Value {
    use serde_json::Value;
    if v.is_nan() {
        return Value::String("NaN".into());
    }
    if v.is_infinite() {
        return Value::String(if v.is_sign_positive() {
            "Infinity".into()
        } else {
            "-Infinity".into()
        });
    }
    // f32 用自身的最短往返表示，避免转 f64 后出现 0.10000000149011612。
    if let Some(s) = shortest
        && let Ok(Value::Number(n)) = serde_json::from_str::<Value>(s)
    {
        return Value::Number(n);
    }
    serde_json::json!(v)
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// `bulk` 整表 → (列, 行)。
pub fn bulk_to_wire(table: &BulkTable) -> Result<(Vec<WireColumn>, Vec<Vec<serde_json::Value>>)> {
    let columns = columns_from_descs(table.schema());
    let n_cols = table.num_columns();
    let mut views = Vec::with_capacity(n_cols);
    for i in 0..n_cols {
        views.push(table.column(i)?);
    }
    let n_rows = table.num_rows();
    let mut rows = Vec::with_capacity(n_rows);
    for r in 0..n_rows {
        let mut row = Vec::with_capacity(n_cols);
        for (c, view) in views.iter().enumerate() {
            let v = view.get(r)?;
            row.push(value_to_wire(v, table.schema()[c].decimal));
        }
        rows.push(row);
    }
    Ok((columns, rows))
}

/// `rows` 一次性结果 → (列, 行)。
pub fn rows_data_to_wire(
    data: &RowsData,
) -> Result<(Vec<WireColumn>, Vec<Vec<serde_json::Value>>)> {
    let columns = columns_from_descs(data.schema());
    let mut rows = Vec::with_capacity(data.num_rows());
    for (_chunk_no, row) in data.iter_rows() {
        let mut out = Vec::with_capacity(row.len());
        for c in 0..row.len() {
            let v = row.get(c)?;
            out.push(value_to_wire(v, data.schema()[c].decimal));
        }
        rows.push(out);
    }
    Ok((columns, rows))
}

/// `rows` 单块 → 行（流式用）。
pub fn chunk_to_wire(chunk: &Chunk) -> Result<Vec<Vec<serde_json::Value>>> {
    let n_cols = chunk.num_columns();
    let mut rows = Vec::with_capacity(chunk.num_rows());
    for row in chunk.rows() {
        let mut out = Vec::with_capacity(n_cols);
        for c in 0..n_cols {
            let v = row.get(c)?;
            out.push(value_to_wire(v, chunk.schema()[c].decimal));
        }
        rows.push(out);
    }
    Ok(rows)
}

// ---------------------------------------------------------------------------
// 时间/十进制格式化（不引 chrono：只做契约要求的三个形态）
// ---------------------------------------------------------------------------

/// `DATE`：自 1970-01-01 的天数 → `YYYY-MM-DD`。
pub fn format_date(days: i32) -> String {
    let (y, m, d) = civil_from_days(i64::from(days));
    format!("{y:04}-{m:02}-{d:02}")
}

/// `TIME`：自午夜的纳秒 → `HH:MM:SS[.f]`。
pub fn format_time_ns(ns: i64) -> String {
    let dur = ns.rem_euclid(86_400_000_000_000);
    format_time_of_day(dur as u64)
}

/// `TIMESTAMP`：自 epoch 的纳秒 → `YYYY-MM-DDTHH:MM:SS[.f]Z`（UTC）。
pub fn format_timestamp_ns(ns: i64) -> String {
    const DAY: i64 = 86_400_000_000_000;
    let days = ns.div_euclid(DAY);
    let tod = ns.rem_euclid(DAY) as u64;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{}Z", format_time_of_day(tod))
}

fn format_time_of_day(ns: u64) -> String {
    let total_secs = ns / 1_000_000_000;
    let sub = ns % 1_000_000_000;
    let h = total_secs / 3600;
    let mi = (total_secs % 3600) / 60;
    let s = total_secs % 60;
    if sub == 0 {
        format!("{h:02}:{mi:02}:{s:02}")
    } else {
        // 最多 9 位，去掉尾随 0；契约形态 `[.f]`。
        let frac = format!("{sub:09}");
        let frac = frac.trim_end_matches('0');
        format!("{h:02}:{mi:02}:{s:02}.{frac}")
    }
}

/// Howard Hinnant 的 `civil_from_days`（对负天数用欧几里得除法）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

/// Decimal128：未缩放的 i128 + scale → 精确十进制字符串。
pub fn format_decimal(unscaled: i128, scale: i8) -> String {
    let neg = unscaled < 0;
    let digits = unscaled.unsigned_abs().to_string();
    let mut s = if scale > 0 {
        let scale = scale as usize;
        if digits.len() <= scale {
            format!("0.{}{digits}", "0".repeat(scale - digits.len()))
        } else {
            let split = digits.len() - scale;
            format!("{}.{}", &digits[..split], &digits[split..])
        }
    } else if scale < 0 {
        format!("{digits}{}", "0".repeat((-scale) as usize))
    } else {
        digits
    };
    if neg {
        s.insert(0, '-');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_contract_shaped() {
        assert_eq!(format_date(0), "1970-01-01");
        assert_eq!(format_date(19_000), "2022-01-08");
        assert_eq!(format_date(-1), "1969-12-31");
    }

    #[test]
    fn times_trim_fraction_and_handle_negative() {
        assert_eq!(format_time_ns(0), "00:00:00");
        assert_eq!(format_time_ns(12 * 3600 * 1_000_000_000), "12:00:00");
        assert_eq!(format_time_ns(1_500_000_000), "00:00:01.5");
        assert_eq!(format_time_ns(123_456_789), "00:00:00.123456789");
        assert_eq!(format_time_ns(-1_000_000_000), "23:59:59");
    }

    #[test]
    fn timestamps_are_iso_utc() {
        assert_eq!(format_timestamp_ns(0), "1970-01-01T00:00:00Z");
        assert_eq!(
            format_timestamp_ns(1_640_995_200_123_456_789),
            "2022-01-01T00:00:00.123456789Z"
        );
        assert_eq!(format_timestamp_ns(-1), "1969-12-31T23:59:59.999999999Z");
    }

    #[test]
    fn decimals_keep_scale_exactly() {
        assert_eq!(format_decimal(15, 1), "1.5");
        assert_eq!(format_decimal(-15, 1), "-1.5");
        assert_eq!(format_decimal(5, 3), "0.005");
        assert_eq!(format_decimal(123, 0), "123");
        assert_eq!(format_decimal(123, -2), "12300");
        assert_eq!(format_decimal(0, 2), "0.00");
    }

    #[test]
    fn numeric_tags_never_guess_from_content() {
        assert_eq!(tag_from_type_name("VARCHAR"), "utf8");
        assert_eq!(tag_from_type_name("BIGINT"), "i64");
        assert_eq!(tag_from_type_name("DECIMAL(10,2)"), "decimal128");
        assert_eq!(
            tag_from_type_name("Timestamp(Nanosecond, None)"),
            "timestampns"
        );
        assert_eq!(tag_from_type_name("Time64(Nanosecond)"), "time64ns");
        assert_eq!(tag_from_type_name("Date32"), "date32");
        assert_eq!(tag_from_type_name("Binary"), "binary");
        assert_eq!(tag_from_type_name("INTERVAL"), "interval");
        assert_eq!(tag_from_type_name("something-weird"), "utf8");
    }

    #[test]
    fn i64_beyond_js_safe_integer_is_string() {
        let v = value_to_wire(ValueRef::I64(9_007_199_254_740_992), None);
        assert_eq!(v, serde_json::json!("9007199254740992"));
        let v = value_to_wire(ValueRef::I64(42), None);
        assert_eq!(v, serde_json::json!(42));
    }

    #[test]
    fn float_specials_use_ecosystem_spelling() {
        assert_eq!(
            value_to_wire(ValueRef::F64(f64::NAN), None),
            serde_json::json!("NaN")
        );
        assert_eq!(
            value_to_wire(ValueRef::F64(f64::INFINITY), None),
            serde_json::json!("Infinity")
        );
        assert_eq!(
            value_to_wire(ValueRef::F64(f64::NEG_INFINITY), None),
            serde_json::json!("-Infinity")
        );
    }

    #[test]
    fn binary_is_lowercase_hex() {
        assert_eq!(
            value_to_wire(ValueRef::Binary(&[0x00, 0xab, 0xff]), None),
            serde_json::json!("00abff")
        );
    }
}
