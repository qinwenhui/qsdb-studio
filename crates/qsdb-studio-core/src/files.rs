//! 文件管理面（内核二十批，`72cacfb`）的线上形状。
//!
//! 存储布局 `<根>/<库名>/<表>/<分区>/seg_*.parquet`——路径本身就是语义。
//! 这里只把 `qsdb-client` 的文件 DTO 翻成 Studio 的 camelCase IPC 契约，
//! 不在本地做任何权限/引用推断：`referenced` 三态（`true` / `false` / `null`）
//! 原样透出，**未知绝不按未引用处理**。

use qsdb_client::{
    DirSummary, FileColumnStat, FileDetail, FileEntry, FileListing, FileMount, FileSegment,
    ManifestDetail, TrashAck,
};

/// 调用方可见的挂载（文件浏览器侧栏起点）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFileMount {
    /// 挂载名（路径寻址的第一段）。
    pub name: String,
    /// 是否默认库。
    pub is_default: bool,
}

/// 段的列统计（manifest 内嵌，**不读 parquet** 就有）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFileColumnStat {
    /// 列名。
    pub name: String,
    /// 最小值（`Literal` 的 Display 形态；全 NULL 列为 `None`）。
    pub min: Option<String>,
    /// 最大值（同上）。
    pub max: Option<String>,
    /// NULL 计数。
    pub null_count: u64,
}

/// 段摘要。`referenced` 三态：
/// `true` = 被存活 manifest 引用（不可删）；`false` = 孤儿（可进回收站）；
/// `null` = 未知（manifest 缺失/损坏，**未知 ≠ 未引用**）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFileSegment {
    /// 三态引用标记。
    pub referenced: Option<bool>,
    /// 行数。
    pub rows: Option<u64>,
    /// 落盘字节。
    pub bytes: Option<u64>,
    /// 段创建时间（毫秒 epoch）。
    pub created_at_ms: Option<i64>,
    /// 所在分区的提交计数器。
    pub generation: Option<u64>,
    /// 列统计（仅详情有；列表为空）。
    pub columns: Vec<WireFileColumnStat>,
}

/// 目录清单里的一条（服务端已按目录优先、名字序排好）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFileEntry {
    /// 条目名（不含路径）。
    pub name: String,
    /// 目录还是文件。
    pub is_dir: bool,
    /// 仅文件有。
    pub size: Option<u64>,
    /// 最后修改（毫秒 epoch）。
    pub modified_ms: Option<u64>,
    /// 仅段文件有。
    pub segment: Option<WireFileSegment>,
}

/// 目录浏览一页。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFileListing {
    /// 归一化后的目录（空串 = 存储根顶层）。
    pub dir: String,
    /// 调用方可见的挂载。
    pub mounts: Vec<WireFileMount>,
    /// 目录条目。
    pub entries: Vec<WireFileEntry>,
}

/// 目录浅层汇总。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireDirSummary {
    /// 子目录数。
    pub dirs: u64,
    /// 文件数。
    pub files: u64,
    /// 文件字节合计（不含子目录内部）。
    pub bytes: u64,
}

/// manifest 文件本身的详情。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireManifestDetail {
    /// 分区提交计数器。
    pub generation: u64,
    /// 分区总行数。
    pub rows: u64,
    /// 段数。
    pub segments: u64,
    /// manifest 磁盘格式版本。
    pub version: u32,
    /// 分区键值（Display 形态）。
    pub partition_values: Vec<(String, String)>,
}

/// 单文件/目录详情。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFileDetail {
    /// 寻址路径（`<挂载>/<相对路径>` 原样回显）。
    pub path: String,
    /// 最后一节名字。
    pub name: String,
    /// 目录还是文件。
    pub is_dir: bool,
    /// `segment` | `manifest` | `index` | `tabledef` | `other` | `dir`。
    pub kind: String,
    /// 字节。
    pub size: u64,
    /// 最后修改（毫秒 epoch）。
    pub modified_ms: u64,
    /// 归属库（grants 判定键）。
    pub db: String,
    /// 归属表（路径形状推断，尽力而为）。
    pub table: Option<String>,
    /// 归属分区（`dt=2026-01-01` 形态）。
    pub partition: Option<String>,
    /// 目录时的浅层汇总。
    pub summary: Option<WireDirSummary>,
    /// 段详情。
    pub segment: Option<WireFileSegment>,
    /// manifest 文件详情。
    pub manifest: Option<WireManifestDetail>,
    /// table.json 原样 JSON。
    pub table_def: Option<serde_json::Value>,
    /// 单文件预览 SQL（本地库才有）。
    pub read_sql: Option<String>,
}

/// 进回收站回执。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireTrashAck {
    /// 恒 `true`（失败走结构化错误）。
    pub trashed: bool,
    /// 寻址路径回显。
    pub path: String,
}

impl From<FileMount> for WireFileMount {
    fn from(m: FileMount) -> Self {
        Self {
            name: m.name,
            is_default: m.is_default,
        }
    }
}

impl From<FileColumnStat> for WireFileColumnStat {
    fn from(c: FileColumnStat) -> Self {
        Self {
            name: c.name,
            min: c.min,
            max: c.max,
            null_count: c.null_count,
        }
    }
}

impl From<FileSegment> for WireFileSegment {
    fn from(s: FileSegment) -> Self {
        Self {
            referenced: s.referenced,
            rows: s.rows,
            bytes: s.bytes,
            created_at_ms: s.created_at_ms,
            generation: s.generation,
            columns: s.columns.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<FileEntry> for WireFileEntry {
    fn from(e: FileEntry) -> Self {
        Self {
            name: e.name,
            is_dir: e.is_dir,
            size: e.size,
            modified_ms: e.modified_ms,
            segment: e.segment.map(Into::into),
        }
    }
}

impl From<FileListing> for WireFileListing {
    fn from(l: FileListing) -> Self {
        Self {
            dir: l.dir,
            mounts: l.mounts.into_iter().map(Into::into).collect(),
            entries: l.entries.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<DirSummary> for WireDirSummary {
    fn from(s: DirSummary) -> Self {
        Self {
            dirs: s.dirs,
            files: s.files,
            bytes: s.bytes,
        }
    }
}

impl From<ManifestDetail> for WireManifestDetail {
    fn from(m: ManifestDetail) -> Self {
        Self {
            generation: m.generation,
            rows: m.rows,
            segments: m.segments,
            version: m.version,
            partition_values: m.partition_values,
        }
    }
}

impl From<FileDetail> for WireFileDetail {
    fn from(d: FileDetail) -> Self {
        Self {
            path: d.path,
            name: d.name,
            is_dir: d.is_dir,
            kind: d.kind,
            size: d.size,
            modified_ms: d.modified_ms,
            db: d.db,
            table: d.table,
            partition: d.partition,
            summary: d.summary.map(Into::into),
            segment: d.segment.map(Into::into),
            manifest: d.manifest.map(Into::into),
            table_def: d.table_def,
            read_sql: d.read_sql,
        }
    }
}

impl From<TrashAck> for WireTrashAck {
    fn from(a: TrashAck) -> Self {
        Self {
            trashed: a.trashed,
            path: a.path,
        }
    }
}
