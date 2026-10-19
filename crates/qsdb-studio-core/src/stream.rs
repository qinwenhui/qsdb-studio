//! 大结果流式通道（设计 §三.2 / §五.1.5）。
//!
//! 两条内存有界的路径：
//! 1. 服务端 `query_stream` 逐块返回（`rows` 通道，客户端内存 O(一块)）；
//! 2. core 把每一行立刻**追加到磁盘 spool**，内存只留行偏移（8 字节/行）与
//!    最近一小段预览；前端要哪一页就按偏移读哪一页。
//!
//! 所以 100 万行浏览时：Rust 侧内存 ≈ 一块 + 偏移表；前端只缓存可视区附近
//! 的页。**绝不静默截断**：断流会把已收行保留为只读数据，并明确报错。

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use qsdb_client::{Client, Format};
use serde::Serialize;

use crate::error::{Result, StudioError};
use crate::io_csv::csv_cell;
use crate::query::{QueryOptionsInput, build_options, stream_query_id};
use crate::wire::{WireColumn, chunk_to_wire, columns_from_descs};

/// 每个块推给前端的预览行数（**不是**该块总行数）。
///
/// 全量数据在 core 的 spool 里；预览只服务"边收边看"的尾部。这样即使服务端
/// 每块 64K 行，IPC 也不会把整块搬进 WebView。
const PREVIEW_ROWS: usize = 200;

/// 单页最大行数（IPC 背压保护；前端按 500 行一页取）。
const MAX_PAGE_ROWS: usize = 2_000;

/// 流式事件（经 Tauri Channel 推给前端）。
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StreamEvent {
    /// 列描述就绪（此时还没有数据）。
    Started {
        /// 流 id（同时是服务端 query id，可用于取消）。
        stream_id: String,
        /// 列。
        columns: Vec<WireColumn>,
        /// 服务端执行耗时（ms；旧服务端 / 无统一耗时头时为 None）。
        server_elapsed_ms: Option<f64>,
    },
    /// 收到一块。`rows` 是**尾部预览**；完整块已落 spool。
    Chunk {
        /// 流 id。
        stream_id: String,
        /// `rows` 第一行的全局行号。
        start: u64,
        /// 本块总行数（含未放进预览的部分）。
        row_count: u64,
        /// 截至目前累计行数。
        total_rows: u64,
        /// 预览行（最多 `PREVIEW_ROWS`）。
        rows: Vec<Vec<serde_json::Value>>,
    },
    /// 干净结束。
    End {
        /// 流 id。
        stream_id: String,
        /// 总行数。
        total_rows: u64,
        /// 墙钟耗时（ms，含网络与落盘）。
        elapsed_ms: f64,
    },
    /// 中断（**已收到的行仍可从 spool 分页读取**）。
    Error {
        /// 流 id。
        stream_id: String,
        /// 错误。
        error: StudioError,
        /// 中断前已收到的行数。
        rows_received: u64,
    },
}

/// 一页行（前端按可视区取）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamPage {
    /// 起始行号。
    pub offset: u64,
    /// 行。
    pub rows: Vec<Vec<serde_json::Value>>,
    /// 当前已知总行数（仍在增长）。
    pub total_rows: u64,
    /// 流是否已干净结束。
    pub done: bool,
}

struct SpoolInner {
    columns: Vec<WireColumn>,
    writer: Option<BufWriter<File>>,
    /// `offsets[i]` = 第 i 行的起始字节；`offsets[rows]` = 文件尾。
    offsets: Vec<u64>,
    done: bool,
    error: Option<StudioError>,
    orphaned: bool,
}

/// 单条流的磁盘存储。
pub struct Spool {
    dir: PathBuf,
    path: PathBuf,
    inner: Mutex<SpoolInner>,
    /// 用户已请求停止。执行段由服务端 cancel 收尾；传输段由 reader 在
    /// 分块边界 `RowStream::abort()`（drop 关 socket）收尾。
    stop: AtomicBool,
}

impl Spool {
    fn new(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&dir)
            .map_err(|e| StudioError::storage(format!("创建流目录 {} 失败: {e}", dir.display())))?;
        let path = dir.join("rows.jsonl");
        let file = File::create(&path).map_err(|e| {
            StudioError::storage(format!("创建流文件 {} 失败: {e}", path.display()))
        })?;
        Ok(Self {
            dir,
            path,
            inner: Mutex::new(SpoolInner {
                columns: Vec::new(),
                writer: Some(BufWriter::new(file)),
                offsets: vec![0],
                done: false,
                error: None,
                orphaned: false,
            }),
            stop: AtomicBool::new(false),
        })
    }

    /// 请求停止（幂等）。真正的收尾由 reader 线程完成：
    /// 执行段依赖服务端 cancel；传输段下一个分块边界 `RowStream::abort()`。
    fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    fn stop_requested(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn set_columns(&self, columns: Vec<WireColumn>) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).columns = columns;
    }

    /// 追加若干行（JSON Lines；每行一个数组）。调用方随后应 `flush`。
    fn append_rows(&self, rows: &[Vec<serde_json::Value>]) -> Result<()> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let SpoolInner {
            writer, offsets, ..
        } = &mut *g;
        let writer = writer
            .as_mut()
            .ok_or_else(|| StudioError::internal("流向已关闭仍然写入"))?;
        for row in rows {
            let line = serde_json::to_vec(row)?;
            writer.write_all(&line)?;
            writer.write_all(b"\n")?;
            let last = *offsets.last().unwrap_or(&0);
            offsets.push(last + line.len() as u64 + 1);
        }
        Ok(())
    }

    /// 把已写的字节刷到磁盘（分页读取前必须可见）。
    fn flush(&self) -> Result<()> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(w) = g.writer.as_mut() {
            w.flush()?;
        }
        Ok(())
    }

    fn total_rows(&self) -> u64 {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        (g.offsets.len().saturating_sub(1)) as u64
    }

    fn finish(&self) -> Result<()> {
        let cleanup = {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(mut w) = g.writer.take() {
                w.flush()?;
            }
            g.done = true;
            g.orphaned
        };
        if cleanup {
            self.remove_dir();
        }
        Ok(())
    }

    fn fail(&self, error: StudioError) {
        let cleanup = {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(mut w) = g.writer.take() {
                let _ = w.flush();
            }
            g.done = true;
            g.error = Some(error);
            g.orphaned
        };
        if cleanup {
            self.remove_dir();
        }
    }

    fn orphan(&self) {
        let cleanup = {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.orphaned = true;
            g.done || g.error.is_some()
        };
        if cleanup {
            self.remove_dir();
        }
    }

    fn remove_dir(&self) {
        // 临时目录清理失败不影响用户数据；下次启动会统一清空。
        let _ = std::fs::remove_dir_all(&self.dir);
    }

    fn page(&self, offset: u64, limit: usize) -> Result<StreamPage> {
        let limit = limit.clamp(1, MAX_PAGE_ROWS);
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(w) = g.writer.as_mut() {
            w.flush()?;
        }
        let total = g.offsets.len().saturating_sub(1);
        let start_row = (offset as usize).min(total);
        let end_row = (start_row + limit).min(total);
        let done = g.done;
        let start_byte = g.offsets[start_row];
        let end_byte = g.offsets[end_row];
        let mut rows = Vec::with_capacity(end_row - start_row);
        if end_byte > start_byte {
            let mut f = File::open(&self.path).map_err(|e| {
                StudioError::storage(format!("读取流文件 {} 失败: {e}", self.path.display()))
            })?;
            f.seek(SeekFrom::Start(start_byte))?;
            let len = (end_byte - start_byte) as usize;
            let mut buf = vec![0u8; len];
            f.read_exact(&mut buf)?;
            for line in buf.split(|b| *b == b'\n') {
                if line.is_empty() {
                    continue;
                }
                rows.push(serde_json::from_slice::<Vec<serde_json::Value>>(line)?);
            }
        }
        Ok(StreamPage {
            offset: start_row as u64,
            rows,
            total_rows: total as u64,
            done,
        })
    }

    /// 导出 CSV（**只允许已结束的流**，避免用户拿到静默的半截文件）。
    fn export_csv(&self, path: &Path, bom: bool) -> Result<u64> {
        let (columns, total) = {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if !g.done {
                return Err(StudioError::usage(
                    "结果仍在接收中——请等流式读取完成后再导出（不做半截导出）",
                ));
            }
            (g.columns.clone(), g.offsets.len().saturating_sub(1) as u64)
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                StudioError::storage(format!("创建目录 {} 失败: {e}", parent.display()))
            })?;
        }
        let mut file = File::create(path)
            .map_err(|e| StudioError::storage(format!("创建 {} 失败: {e}", path.display())))?;
        if bom {
            file.write_all(b"\xEF\xBB\xBF")?;
        }
        let mut wtr = csv::WriterBuilder::new().from_writer(file);
        wtr.write_record(columns.iter().map(|c| c.name.as_str()))?;

        let mut reader = BufReader::new(File::open(&self.path).map_err(|e| {
            StudioError::storage(format!("读取流文件 {} 失败: {e}", self.path.display()))
        })?);
        let mut buf = Vec::new();
        let mut written = 0u64;
        while written < total {
            buf.clear();
            if reader.read_until(b'\n', &mut buf)? == 0 {
                break;
            }
            while buf.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
                buf.pop();
            }
            if buf.is_empty() {
                continue;
            }
            let row: Vec<serde_json::Value> = serde_json::from_slice(&buf)?;
            wtr.write_record(row.iter().map(csv_cell))?;
            written += 1;
        }
        wtr.flush()?;
        if written != total {
            return Err(StudioError::storage(format!(
                "流文件行数不一致：应为 {total}，实读 {written}"
            )));
        }
        Ok(written)
    }
}

/// 流注册表：`streamId → Spool`。
pub struct StreamStore {
    root: PathBuf,
    map: Mutex<HashMap<String, Arc<Spool>>>,
}

impl StreamStore {
    /// 新建。启动时清空上一次运行遗留的流目录（临时数据，不需要跨会话）。
    pub fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        if root.exists() {
            let _ = std::fs::remove_dir_all(&root);
        }
        std::fs::create_dir_all(&root).map_err(|e| {
            StudioError::storage(format!("创建流根目录 {} 失败: {e}", root.display()))
        })?;
        Ok(Self {
            root,
            map: Mutex::new(HashMap::new()),
        })
    }

    /// 启动一条后台流。立即返回 `streamId`；数据经 `emit` 推送。
    ///
    /// `input.query_id` 会被覆盖为 streamId —— 这样取消命令可以直接用同一个 id
    /// （服务端 id 冲突回退时取消可能落空，但不会误伤——id 含进程号+时间戳）。
    pub fn start(
        self: &Arc<Self>,
        client: Arc<Client>,
        sql: String,
        input: &QueryOptionsInput,
        emit: impl Fn(StreamEvent) + Send + 'static,
    ) -> Result<String> {
        let stream_id = stream_query_id();
        let mut input = input.clone();
        input.query_id = Some(stream_id.clone());
        let opts = build_options(Format::Rows, &input);

        let spool = Arc::new(Spool::new(self.root.join(&stream_id))?);
        {
            let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
            map.insert(stream_id.clone(), Arc::clone(&spool));
        }

        let thread_spool = Arc::clone(&spool);
        let event_spool = Arc::clone(&spool);
        let sid = stream_id.clone();
        let started = Instant::now();
        let spawned = std::thread::Builder::new()
            .name(format!("qsdb-stream-{stream_id}"))
            .spawn(move || {
                let res = run_stream(&client, &sql, &opts, &thread_spool, &sid, &emit);
                match res {
                    Ok(StreamOutcome::Done(total)) => {
                        if let Err(e) = thread_spool.finish() {
                            thread_spool.fail(e.clone());
                            emit(StreamEvent::Error {
                                stream_id: sid.clone(),
                                error: e,
                                rows_received: total,
                            });
                            return;
                        }
                        emit(StreamEvent::End {
                            stream_id: sid,
                            total_rows: total,
                            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
                        });
                    }
                    Ok(StreamOutcome::Aborted(total)) => {
                        let error = StudioError::cancelled(
                            "已停止接收流式结果（连接已断开）；已收到的行保留为只读数据",
                        );
                        event_spool.fail(error.clone());
                        emit(StreamEvent::Error {
                            stream_id: sid,
                            error,
                            rows_received: total,
                        });
                    }
                    Err(e) => {
                        let received = event_spool.total_rows();
                        // 用户停止时，服务端 cancel / 关 socket 可能以 IO/API
                        // 错误的形式回来——统一归为“已取消”，不误报查询失败。
                        let error = if thread_spool.stop_requested() {
                            StudioError::cancelled(
                                "已停止接收流式结果（连接已断开）；已收到的行保留为只读数据",
                            )
                        } else {
                            e
                        };
                        event_spool.fail(error.clone());
                        emit(StreamEvent::Error {
                            stream_id: sid,
                            error,
                            rows_received: received,
                        });
                    }
                }
            });
        if let Err(e) = spawned {
            self.map
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .remove(&stream_id);
            spool.orphan();
            return Err(StudioError::internal(format!("启动流线程失败: {e}")));
        }
        Ok(stream_id)
    }

    /// 取一页（流未结束时也能取已落盘部分）。
    pub fn page(&self, id: &str, offset: u64, limit: usize) -> Result<StreamPage> {
        let spool = self.get(id)?;
        spool.page(offset, limit)
    }

    /// 请求停止一条流（幂等）。返回是否找到仍在注册表中的流。
    ///
    /// **只设置本地停止标记**；服务端执行段的 cancel 由 `StudioCore::stop_stream`
    /// 同步发出（传输段 404 是预期）。reader 线程在下一个分块边界
    /// `RowStream::abort()`，已接收的行仍保留在 spool 中可读。
    pub fn stop(&self, id: &str) -> bool {
        let spool = self
            .map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned();
        if let Some(s) = spool {
            s.request_stop();
            true
        } else {
            false
        }
    }

    /// 释放：删除磁盘文件。仍在接收的流会被标记为孤儿，结束后自动清理。
    pub fn release(&self, id: &str) -> Result<()> {
        let spool = self
            .map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        if let Some(s) = spool {
            s.orphan();
        }
        Ok(())
    }

    /// 导出已结束的流为 CSV；返回写入行数。
    pub fn export_csv(&self, id: &str, path: &Path, bom: bool) -> Result<u64> {
        self.get(id)?.export_csv(path, bom)
    }

    /// 已知行数（诊断用）。
    pub fn total_rows(&self, id: &str) -> Result<u64> {
        Ok(self.get(id)?.total_rows())
    }

    fn get(&self, id: &str) -> Result<Arc<Spool>> {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| StudioError::usage(format!("流 '{id}' 不存在或已释放")))
    }
}

/// reader 线程的结束方式：干净读完，或用户停止。
enum StreamOutcome {
    Done(u64),
    Aborted(u64),
}

fn run_stream(
    client: &Client,
    sql: &str,
    opts: &qsdb_client::QueryOptions,
    spool: &Spool,
    stream_id: &str,
    emit: &impl Fn(StreamEvent),
) -> Result<StreamOutcome> {
    let mut rs = client.query_stream(sql, opts)?;
    // 执行段就点了停止；cancel 可能让 query_stream 正常返回，这时也不要
    // 再发 Started/读块——直接 abort 关连接。
    if spool.stop_requested() {
        rs.abort();
        return Ok(StreamOutcome::Aborted(0));
    }
    let columns = columns_from_descs(rs.schema());
    spool.set_columns(columns.clone());
    let server_elapsed_ms = rs.server_elapsed_ms();
    emit(StreamEvent::Started {
        stream_id: stream_id.to_string(),
        columns,
        server_elapsed_ms,
    });

    let mut total = 0u64;
    loop {
        // 传输段：停止标记在每个块边界检查一次。RowStream::abort() 消费
        // self 并 drop 独占连接 → socket 关闭，服务端下一块写失败自动收尾。
        if spool.stop_requested() {
            rs.abort();
            return Ok(StreamOutcome::Aborted(total));
        }
        let Some(chunk) = rs.next_chunk()? else {
            break;
        };
        if spool.stop_requested() {
            rs.abort();
            return Ok(StreamOutcome::Aborted(total));
        }
        let rows = chunk_to_wire(&chunk)?;
        if rows.is_empty() {
            continue;
        }
        spool.append_rows(&rows)?;
        spool.flush()?;

        let chunk_rows = rows.len() as u64;
        total += chunk_rows;
        let preview_len = rows.len().min(PREVIEW_ROWS);
        let preview = rows[rows.len() - preview_len..].to_vec();
        let start = total - preview_len as u64;
        emit(StreamEvent::Chunk {
            stream_id: stream_id.to_string(),
            start,
            row_count: chunk_rows,
            total_rows: total,
            rows: preview,
        });
    }
    Ok(StreamOutcome::Done(total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn col(name: &str) -> WireColumn {
        WireColumn {
            name: name.into(),
            tag: "i64".into(),
            type_name: "BIGINT".into(),
            nullable: true,
            decimal: None,
            tz: None,
        }
    }

    #[test]
    fn spool_pages_and_exports() {
        let tmp = TempDir::new().unwrap();
        let spool = Spool::new(tmp.path().join("s1")).unwrap();
        spool.set_columns(vec![col("id"), col("name")]);
        let rows: Vec<Vec<serde_json::Value>> = (0..10)
            .map(|i| vec![serde_json::json!(i), serde_json::json!(format!("行{i}"))])
            .collect();
        spool.append_rows(&rows).unwrap();
        spool.flush().unwrap();

        let p = spool.page(0, 3).unwrap();
        assert_eq!(p.total_rows, 10);
        assert_eq!(p.rows.len(), 3);
        assert_eq!(p.rows[1][0], serde_json::json!(1));

        let p = spool.page(8, 5).unwrap();
        assert_eq!(p.rows.len(), 2);
        assert_eq!(p.rows[1][1], serde_json::json!("行9"));

        let p = spool.page(100, 5).unwrap();
        assert!(p.rows.is_empty());

        // 未结束不能导出
        let out = tmp.path().join("out.csv");
        assert!(spool.export_csv(&out, true).is_err());

        spool.finish().unwrap();
        let n = spool.export_csv(&out, true).unwrap();
        assert_eq!(n, 10);
        let bytes = std::fs::read(&out).unwrap();
        assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
        assert!(text.contains("id,name"));
        assert!(text.contains("9,行9"));
    }

    #[test]
    fn release_cleans_completed_stream() {
        let tmp = TempDir::new().unwrap();
        let store = Arc::new(StreamStore::new(tmp.path().join("streams")).unwrap());
        let spool = Spool::new(tmp.path().join("manual")).unwrap();
        spool.finish().unwrap();
        {
            store
                .map
                .lock()
                .unwrap()
                .insert("manual".into(), Arc::new(spool));
        }
        assert!(store.page("manual", 0, 1).is_ok());
        store.release("manual").unwrap();
        assert!(store.page("manual", 0, 1).is_err());
    }

    #[test]
    fn stop_marks_stream_and_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let store = Arc::new(StreamStore::new(tmp.path().join("streams")).unwrap());
        let spool = Arc::new(Spool::new(tmp.path().join("manual")).unwrap());
        {
            store
                .map
                .lock()
                .unwrap()
                .insert("manual".into(), Arc::clone(&spool));
        }
        assert!(!spool.stop_requested());
        assert!(store.stop("manual"));
        assert!(spool.stop_requested());
        assert!(store.stop("manual"), "重复停止必须幂等");
        assert!(!store.stop("missing"));
    }
}
