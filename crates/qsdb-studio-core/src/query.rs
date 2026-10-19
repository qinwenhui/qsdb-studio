//! SQL 执行 + 语句拆分。
//!
//! 两条通道的分工（设计 §三.2）：
//! - 小结果：`bulk` 整包（≤ 10 万行）；
//! - 大结果：`rows` 流式（`stream.rs`，内存恒定）。
//!
//! **bulk 不支持的类型**（I8/I16/F32/Binary/Decimal/Time/Interval）会让服务端
//! 回 `UNSUPPORTED`；对**只读语句**这里会改走 `rows` 通道，并在结果上带
//! `channelNote` 明示——不是静默兜底。写语句绝不自动重跑（副作用不可赌）。

use std::time::Instant;

use qsdb_client::{AbortHandle, Client, Format, Param, QueryOptions, ResultData};
use serde::{Deserialize, Serialize};

use crate::error::{Result, StudioError};
use crate::profile::new_id;
use crate::wire::{WireColumn, bulk_to_wire, column_from_info, rows_data_to_wire};

/// 一次查询的参数（IPC 形态）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QueryOptionsInput {
    /// 结果护栏的本请求覆盖（`0` = 不限；**UI 必须显式标注**）。
    pub max_rows: Option<u64>,
    /// 服务端查询超时（ms）。
    pub timeout_ms: Option<u64>,
    /// 目标库（优先级高于会话默认库）。
    pub database: Option<String>,
    /// 期望的 query id（服务端冲突时回退，以响应回显为准）。
    pub query_id: Option<String>,
    /// 参数化查询的值。
    pub params: Vec<ParamInput>,
    /// 仅用于本地执行历史的展示 SQL（自动分页时传未包装的原始 SQL）。
    /// **不会发给服务端**；缺省时历史记录实际执行的 SQL。
    pub history_sql: Option<String>,
    /// 仅内部 SQL（如结果总行数统计）使用：不写本地执行历史。
    /// **不会发给服务端**。
    pub skip_history: bool,
}

/// 一个参数值（IPC 形态）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamInput {
    /// 值（JSON 形态；`ty` 缺省时服务端按 JSON 类型推断）。
    #[serde(default)]
    pub value: serde_json::Value,
    /// 显式类型（`DATE` / `BIGINT` / `DECIMAL(10,2)` …）；拼错服务端显式拒绝。
    #[serde(default)]
    pub ty: Option<String>,
}

impl ParamInput {
    fn to_param(&self) -> Param {
        match self.ty.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(ty) => Param::typed(ty, self.value.clone()),
            None => Param::infer(self.value.clone()),
        }
    }
}

/// 构造客户端查询参数。
pub fn build_options(format: Format, input: &QueryOptionsInput) -> QueryOptions {
    QueryOptions {
        format,
        timeout_ms: input.timeout_ms,
        query_id: input.query_id.clone(),
        params: input.params.iter().map(ParamInput::to_param).collect(),
        max_rows: input.max_rows,
        database: input.database.clone(),
    }
}

/// 一次执行的结果（IPC 形态）。
///
/// `kind = "rows"`：有结果集；`kind = "exec"`：DDL/DML 回执。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    /// `rows` / `exec`。
    pub kind: String,
    /// 列。
    pub columns: Vec<WireColumn>,
    /// 行（值与 `columns[].tag` 配套解读）。
    pub rows: Vec<Vec<serde_json::Value>>,
    /// 行数。
    pub row_count: u64,
    /// Studio 侧墙钟耗时（ms，含网络与客户端解码）。
    pub elapsed_ms: f64,
    /// 服务端执行耗时（ms，不含结果序列化/网络/客户端解码）。
    /// 旧服务端没有统一耗时头、或流式通道不提供时为 `None`。
    pub server_elapsed_ms: Option<f64>,
    /// 服务端实际使用的 query id（取消/审计用）。
    pub query_id: Option<String>,
    /// DDL/DML 结构化命令名。
    pub command: Option<String>,
    /// 人读回执（不做兼容承诺）。
    pub message: Option<String>,
    /// DML 影响行数。
    pub rows_affected: Option<u64>,
    /// 是否被截断（恒 `false`：护栏是**抛错不返部分数据**，不静默截断）。
    pub truncated: bool,
    /// 通道说明（例如 bulk 不支持该类型、已改用 rows）。
    pub channel_note: Option<String>,
    /// 非致命的本地警告（例如历史写入失败）。
    pub warnings: Vec<String>,
}

impl QueryResult {
    /// 空回执（错误路径之外的兜底不用；DDL 走这里）。
    pub fn exec(
        query_id: Option<String>,
        elapsed_ms: f64,
        server_elapsed_ms: Option<f64>,
        command: Option<String>,
        message: Option<String>,
        rows_affected: Option<u64>,
    ) -> Self {
        Self {
            kind: "exec".into(),
            columns: Vec::new(),
            rows: Vec::new(),
            row_count: 0,
            elapsed_ms,
            server_elapsed_ms,
            query_id,
            command,
            message,
            rows_affected,
            truncated: false,
            channel_note: None,
            warnings: Vec::new(),
        }
    }
}

/// 执行一条 SQL（`bulk` 优先；只读语句可显式回退 `rows`）。
///
/// `abort = Some(handle)` 时走可并发中止的普通请求：执行段仍由服务端
/// cancel 负责；传输段由 handle 关闭连接（见 `qsdb_client::AbortHandle`）。
pub fn execute(
    client: &Client,
    sql: &str,
    input: &QueryOptionsInput,
    abort: Option<&AbortHandle>,
) -> Result<QueryResult> {
    let started = Instant::now();
    let mut channel_note = None;

    let bulk_opts = build_options(Format::Bulk, input);
    let rs = match run_query(client, sql, &bulk_opts, abort) {
        Ok(rs) => rs,
        Err(e) if is_bulk_unsupported(&e) && is_read_only_sql(sql) => {
            // 明确标注：这是通道能力差异，不是结果被换了。
            channel_note =
                Some("服务端的 bulk 通道不支持结果中的列类型，已改用 rows 通道（数据完整）".into());
            let rows_opts = build_options(Format::Rows, input);
            run_query(client, sql, &rows_opts, abort)?
        }
        Err(e) => return Err(e.into()),
    };
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    let query_id = rs.query_id().map(str::to_string);
    let server_elapsed_ms = rs.server_elapsed_ms();

    let mut out = match rs.into_data() {
        ResultData::Bulk(t) => {
            let (columns, rows) = bulk_to_wire(&t)?;
            QueryResult {
                kind: "rows".into(),
                columns,
                row_count: rows.len() as u64,
                rows,
                elapsed_ms,
                server_elapsed_ms,
                query_id,
                command: None,
                message: None,
                rows_affected: None,
                truncated: false,
                channel_note: channel_note.clone(),
                warnings: Vec::new(),
            }
        }
        ResultData::Rows(d) => {
            let (columns, rows) = rows_data_to_wire(&d)?;
            QueryResult {
                kind: "rows".into(),
                columns,
                row_count: rows.len() as u64,
                rows,
                elapsed_ms,
                server_elapsed_ms,
                query_id,
                command: None,
                message: None,
                rows_affected: None,
                truncated: false,
                channel_note: channel_note.clone(),
                warnings: Vec::new(),
            }
        }
        ResultData::Json(j) => {
            if j.is_exec() {
                QueryResult::exec(
                    query_id,
                    elapsed_ms,
                    server_elapsed_ms,
                    j.command.clone(),
                    j.message.clone(),
                    j.rows_affected,
                )
            } else {
                // 非默认路径（本 UI 不主动请求 JSON），仍然把数据如实交回。
                let columns: Vec<WireColumn> = j.schema.iter().map(column_from_info).collect();
                let row_count = j.row_count.unwrap_or(j.rows.len()) as u64;
                QueryResult {
                    kind: "rows".into(),
                    columns,
                    rows: j.rows,
                    row_count,
                    elapsed_ms,
                    server_elapsed_ms,
                    query_id,
                    command: j.command,
                    message: j.message,
                    rows_affected: j.rows_affected,
                    truncated: false,
                    channel_note: channel_note.clone(),
                    warnings: Vec::new(),
                }
            }
        }
    };
    if out.channel_note.is_none() {
        out.channel_note = channel_note;
    }
    Ok(out)
}

/// 普通查询的统一入口；有 abort 句柄时使用可并发中止的请求。
fn run_query(
    client: &Client,
    sql: &str,
    opts: &QueryOptions,
    abort: Option<&AbortHandle>,
) -> qsdb_client::Result<qsdb_client::ResultSet> {
    match abort {
        Some(a) => client.query_with_abort(sql, opts, a),
        None => client.query_with(sql, opts),
    }
}

/// 取消一条查询（用**响应回显的** queryId）。
pub fn cancel(client: &Client, query_id: &str) -> Result<()> {
    client.cancel(query_id).map_err(StudioError::from)
}

fn is_bulk_unsupported(e: &qsdb_client::Error) -> bool {
    matches!(
        e,
        qsdb_client::Error::Api { code, message, .. }
            if code == "UNSUPPORTED" && message.to_ascii_lowercase().contains("bulk")
    )
}

/// 粗略判断只读语句（用于**是否允许**通道回退重跑）。
///
/// 判据宁可保守：只有明确的查询类关键字才允许自动重跑，其余原样报错。
pub fn is_read_only_sql(sql: &str) -> bool {
    let head = leading_keyword(sql);
    matches!(
        head.as_deref(),
        Some("SELECT" | "WITH" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "VALUES")
    )
}

/// 第一个非空白、非注释的词（大写）。
fn leading_keyword(sql: &str) -> Option<String> {
    let trimmed = strip_leading_trivia(sql);
    let word: String = trimmed
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect();
    if word.is_empty() {
        None
    } else {
        Some(word.to_ascii_uppercase())
    }
}

fn strip_leading_trivia(sql: &str) -> &str {
    let mut s = sql;
    loop {
        s = s.trim_start();
        if let Some(rest) = s.strip_prefix("--") {
            s = match rest.find('\n') {
                Some(i) => &rest[i + 1..],
                None => "",
            };
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = match rest.find("*/") {
                Some(i) => &rest[i + 2..],
                None => "",
            };
        } else {
            return s;
        }
    }
}

/// 拆分出来的一条语句。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlStatement {
    /// 语句文本（去掉结尾分号与首尾空白）。
    pub sql: String,
    /// 起始行（1 基）。
    pub start_line: u32,
    /// 结束行（1 基）。
    pub end_line: u32,
}

/// 按分号拆分 SQL（尊重字符串、标识符引号、行注释、块注释）。
///
/// - **纯注释片段不产生语句**；
/// - 单引号里的 `''`、双引号里的 `""`、反引号里的 ` `` ` 都按转义处理；
/// - 不做任何语义改写（文本原样，只去首尾空白和结尾分号）。
pub fn split_statements(sql: &str) -> Vec<SqlStatement> {
    #[derive(Clone, Copy, PartialEq)]
    enum St {
        Normal,
        Single,
        Double,
        Backtick,
        LineComment,
        BlockComment,
    }

    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    let mut start_line = 1u32;
    let mut line = 1u32;
    let mut st = St::Normal;
    let mut i = 0usize;

    while i < bytes.len() {
        let b = bytes[i];
        let next = bytes.get(i + 1).copied();

        match st {
            St::Normal => {
                if b.is_ascii_whitespace() {
                    // 语句之间的空白不开启语句
                } else {
                    if start.is_none() {
                        start = Some(i);
                        start_line = line;
                    }
                    match b {
                        b'\'' => st = St::Single,
                        b'"' => st = St::Double,
                        b'`' => st = St::Backtick,
                        b'-' if next == Some(b'-') => {
                            st = St::LineComment;
                            i += 1; // 吃掉第二个 '-'
                        }
                        b'/' if next == Some(b'*') => {
                            st = St::BlockComment;
                            i += 1;
                        }
                        b';' => {
                            if let Some(s) = start.take() {
                                push_statement(&mut out, sql, s, i, start_line, line);
                            }
                        }
                        _ => {}
                    }
                }
            }
            St::Single => {
                if b == b'\'' {
                    if next == Some(b'\'') {
                        i += 1;
                    } else {
                        st = St::Normal;
                    }
                }
            }
            St::Double => {
                if b == b'"' {
                    if next == Some(b'"') {
                        i += 1;
                    } else {
                        st = St::Normal;
                    }
                }
            }
            St::Backtick => {
                if b == b'`' {
                    if next == Some(b'`') {
                        i += 1;
                    } else {
                        st = St::Normal;
                    }
                }
            }
            St::LineComment => {
                if b == b'\n' {
                    st = St::Normal;
                }
            }
            St::BlockComment => {
                if b == b'*' && next == Some(b'/') {
                    st = St::Normal;
                    i += 1;
                }
            }
        }

        if b == b'\n' {
            line = line.saturating_add(1);
        }
        i += 1;
    }

    if let Some(s) = start {
        push_statement(&mut out, sql, s, sql.len(), start_line, line);
    }
    out
}

fn push_statement(
    out: &mut Vec<SqlStatement>,
    sql: &str,
    start: usize,
    end: usize,
    start_line: u32,
    end_line: u32,
) {
    let text = sql[start..end].trim();
    if text.is_empty() {
        return;
    }
    if !has_code(text) {
        return;
    }
    out.push(SqlStatement {
        sql: text.to_string(),
        start_line,
        end_line: start_line.max(end_line),
    });
}

/// 语句里是否有"真代码"（非空白、非注释）。
fn has_code(s: &str) -> bool {
    let mut rest = s;
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("--") {
            rest = match after.find('\n') {
                Some(i) => &after[i + 1..],
                None => "",
            };
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = match after.find("*/") {
                Some(i) => &after[i + 2..],
                None => "",
            };
        } else {
            return !rest.is_empty();
        }
    }
}

/// 生成一条流式查询的稳定 query id（同时用作 streamId）。
pub fn stream_query_id() -> String {
    new_id("studio")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_semicolons_and_tracks_lines() {
        let s = split_statements("SELECT 1;\nSELECT 2\n;\n\n SELECT 3");
        assert_eq!(s.len(), 3);
        assert_eq!(s[0].sql, "SELECT 1");
        assert_eq!(s[0].start_line, 1);
        assert_eq!(s[1].sql, "SELECT 2");
        assert_eq!(s[1].start_line, 2);
        assert_eq!(s[2].sql, "SELECT 3");
        assert_eq!(s[2].start_line, 5);
    }

    #[test]
    fn semicolons_inside_strings_and_identifiers_do_not_split() {
        let s = split_statements("SELECT ';' AS a; SELECT \"a;b\" FROM t; SELECT `x;y`");
        assert_eq!(s.len(), 3);
        assert!(s[0].sql.contains("';'"));
        assert!(s[1].sql.contains("\"a;b\""));
        assert!(s[2].sql.contains("`x;y`"));
    }

    #[test]
    fn escaped_quotes_are_respected() {
        let s = split_statements("SELECT 'it''s; fine'; SELECT 'x'");
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].sql, "SELECT 'it''s; fine'");
    }

    #[test]
    fn comments_do_not_split_or_produce_statements() {
        let s = split_statements(
            "-- a; comment\nSELECT 1 -- tail;\n;\n/* block; */ SELECT 2;\n/* only comment */",
        );
        assert_eq!(s.len(), 2);
        // 行注释里的分号属于注释文本本身，原样保留。
        assert_eq!(s[0].sql, "-- a; comment\nSELECT 1 -- tail;");
        assert_eq!(s[1].sql, "/* block; */ SELECT 2");
    }

    #[test]
    fn trailing_text_without_semicolon_is_a_statement() {
        let s = split_statements("SELECT 1");
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].sql, "SELECT 1");
    }

    #[test]
    fn read_only_detection_is_conservative() {
        assert!(is_read_only_sql("-- hi\nSELECT 1"));
        assert!(is_read_only_sql(
            "/* x */ WITH a AS (SELECT 1) SELECT * FROM a"
        ));
        assert!(is_read_only_sql("EXPLAIN SELECT 1"));
        assert!(!is_read_only_sql("INSERT INTO t VALUES (1)"));
        assert!(!is_read_only_sql("DELETE FROM t"));
        assert!(!is_read_only_sql("CREATE TABLE x (a INT)"));
    }
}
