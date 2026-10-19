# QSDB Studio

<p align="center">
  <img src="ui/src/assets/qsdb-mark.png" width="96" height="96" alt="QSDB Studio">
</p>

[![CI](https://github.com/qinwenhui/qsdb-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/qinwenhui/qsdb-studio/actions/workflows/ci.yml)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-2f6fed.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/qinwenhui/qsdb-studio?include_prereleases)](https://github.com/qinwenhui/qsdb-studio/releases)

**QSDB Studio** is the native desktop workbench for [QSDB](https://github.com/qinwenhui/qsdb),
a high-performance columnar analytics database built for large analytical
workloads, with Arrow-native execution and Parquet storage. Studio makes QSDB's
first-class ideas — partitions and generations, commit streams, runtime
guardrails, sessions, grants, and raw segment files — directly operable in one
window.

Built with **Tauri 2**, **Rust**, **Vue 3**, **Naive UI**, and **Monaco Editor**.

> **Status:** v0.1.0 preview. Windows x64 installers and an **unsigned macOS
> universal** `.dmg` are produced from this repository. Apple signing and
> notarization are not configured yet, so macOS Gatekeeper may warn on first
> launch. The UI is bilingual (Chinese / English) and follows the system
> language by default; the language can be changed in Settings → Appearance.

## Highlights

### Query workbench

- Multi-tab SQL editor with connection-per-tab, syntax highlighting, completion,
  hover, and formatting.
- Execute selection, statement, all statements, or cursor-to-end. Dangerous SQL
  is confirmed before execution.
- Streaming results for large outputs; bulk results auto-paginate at 500
  rows/page without rewriting the SQL you authored.
- **Two-phase stop for streaming and ordinary read queries:** cancel the
  server-side execution by query id while it is still running; once the server
  has unregistered the query, abort the transfer by closing the dedicated
  stream connection (streaming) or the request socket (bulk). Writes remain
  execution-phase-cancel only, so a committed write is never mislabelled as
  cancelled. Already received rows stay browsable — a partial result is never
  presented as complete.
- Compute the **total row count** across the full filtered result, not just the
  current page.
- Server-side filters compose with auto-pagination and apply to the complete
  result.
- Query timing is split into **server execution** and **transfer/decoding** when
  the server exposes `X-QSDB-Elapsed-Ms`.
- Open, save, and drag-and-drop `.sql` files; drafts, tabs, cursor positions,
  and layout survive restarts.

### Catalog and storage

- Browse databases, tables, columns, and partitions; see partition generation,
  row counts, segment counts, and on-disk bytes.
- Inspect table size as the sum of partition segment bytes.
- **File manager:** browse the storage tree (`<root>/<db>/<table>/<partition>/seg_*.parquet`),
  inspect segment ownership and manifest column statistics (min/max/NULL)
  without downloading the file, preview a segment with the server-generated
  `readSql`, download files, and move only **unreferenced** segments to `_trash`.
  Referenced segments are explicitly rejected (`SEGMENT_REFERENCED`); metadata
  files are never deletable from the UI.

### Operations

- Running queries and sessions, with cancellation and admin-only session kick.
- Live commit stream (`/watch`) with cursor-expiry reconciliation.
- Runtime guardrail hot-update (timeout, memory, result rows/bytes).
- Database-level grants matrix with per-user whole-row replacement.
- CSV import with preview, type inference, column mapping, and per-value
  validation; COPY export with read-back verification and server file download.
- Notifications for background results, imports, and watch events.

### Desktop UX

- **Chinese / English UI** with a persisted language preference; the first
  launch follows the operating system language.
- VS Code-style activity rail; command palette (`Ctrl/Cmd+K`); keyboard-first
  navigation.
- Light/dark/system themes, multiple accents, wallpaper and glass controls,
  custom background images.
- Read-only connection profiles that block writes before any network request.
- Credentials are stored only in the operating system keyring.

## Install

Download the latest build from
[GitHub Releases](https://github.com/qinwenhui/qsdb-studio/releases):

- Windows: `QSDB Studio_<version>_x64-setup.exe` (NSIS, per-user install) or
  `QSDB Studio_<version>_x64_zh-CN.msi`.
- macOS: `QSDB Studio_<version>_universal.dmg` — unsigned universal build
  (Apple Silicon + Intel). Gatekeeper may block the first launch; use
  **System Settings → Privacy & Security → Open Anyway**, or right-click the
  app and choose Open. Signed/notarized builds are planned separately.

Studio connects to a QSDB server. Download and run the database from the
[QSDB repository](https://github.com/qinwenhui/qsdb). Connection addresses use
`qsdb://host:port` (for example `qsdb://127.0.0.1:9430`);
`http://host:port` remains accepted. `qsdb://` is a client connection-string
alias for plain HTTP/1.1 — it is **not** a TLS or encryption guarantee. A port
is always required. Instances with a user system (for example
`bootstrap_admin`) reject anonymous requests; use a Basic or Bearer profile.
Passwords and tokens are stored in Windows Credential Manager, macOS Keychain,
or Linux Secret Service — never in profile JSON.

## Build from source

### Prerequisites

- Rust **1.88+**
- Node.js **22+**
- Windows 10/11 with WebView2, or the platform WebView required by Tauri
- The `qsdb-client` crate, published from the QSDB repository, is resolved from
  crates.io in the public release.

### Development

```bash
git clone https://github.com/qinwenhui/qsdb-studio.git
cd qsdb-studio

npm ci
npm --prefix ui ci
npm run tauri dev
```

`npm run tauri dev` starts Vite on `127.0.0.1:1420` and opens the Tauri window.

### Release build

```bash
npm run tauri build
```

Installers are written to:

```text
target/release/bundle/nsis/
target/release/bundle/msi/
```

### Tests

```bash
npm --prefix ui run typecheck
npm --prefix ui run lint
npm --prefix ui run test
cargo test -p qsdb-studio-core
cargo clippy --workspace --all-targets -- -D warnings
```

The real-server end-to-end tests are opt-in:

```bash
QSDB_STUDIO_E2E_SERVER=http://127.0.0.1:9430 \
  cargo test -p qsdb-studio-core --test e2e_real_server
```

## Architecture

```text
ui/                     Vue 3 + TypeScript + Naive UI + Monaco
crates/qsdb-studio-core Rust business logic, no Tauri dependency
src-tauri/              Thin Tauri shell: command forwarding + OS dialogs
```

- The frontend never performs network I/O itself. All traffic goes through
  `qsdb-client`, the single protocol implementation shared with the QSDB
  ecosystem. Studio does not hand-roll HTTP for server features.
- `qsdb-studio-core` owns profiles, keyring-backed secrets, connection pools,
  query execution, streaming spool files, history, favorites, CSV, COPY, and
  the admin/observability surfaces. It is independently unit-testable.
- The Tauri shell only forwards IPC parameters and maps errors.

## Security and privacy

- Passwords and tokens are written to the OS keyring only. Profile JSON contains
  authentication kind and username, never the secret.
- No telemetry, analytics, crash uploads, or remote logging are built in.
- Studio talks only to the QSDB URL configured in each connection profile.
- File deletion is deliberately narrow: only `seg_*.parquet`, only when the
  server confirms the segment is unreferenced, under the partition lock, and
  the file is moved to `_trash` rather than unlinked. Referenced segments are
  rejected with `SEGMENT_REFERENCED` (HTTP 409 / SQLState 55006).
- Do not include credentials, connection strings, or production data in issues.

To report a security issue privately, email **1510365643@qq.com**. Please do not
open a public issue for vulnerabilities.

## Compatibility

| Studio | QSDB kernel | Notes |
|---|---|---|
| 0.1.0 | 0.1.0 (files surface, commit `72cacfb`) | Full feature set, including file manager and timing split |
| 0.1.0 | older 0.1.x previews | File manager and timing split degrade explicitly; no silent fallback |

Older servers may omit `X-QSDB-Elapsed-Ms`, partition `bytes`, session
visibility for non-admin users, or the `/files/list|detail|trash` endpoints.
Studio shows the available information and never invents missing values.

## License

**QSDB Studio is source-available, not OSI-approved open source.**

It is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE).
Personal, research, educational, and noncommercial use is permitted. **Any
commercial use requires a separate commercial license** — contact
**1510365643@qq.com**.

The QSDB database kernel is a separate project and is licensed separately in its
repository. Third-party dependencies retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing

Issues and pull requests are welcome. By submitting a contribution, you agree
that it may be distributed under the project's license. Before opening a PR:

1. Run the checks listed under **Tests**.
2. Keep changes focused and include a short rationale.
3. Never commit credentials, internal hostnames, customer data, or local
   environment files.

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Author

**qinwh** — [@qinwenhui](https://github.com/qinwenhui) ·
[1510365643@qq.com](mailto:1510365643@qq.com)

## 中文简介

QSDB Studio 是 QSDB 数据库的原生桌面客户端（Tauri 2 + Rust + Vue 3），
提供多标签 SQL 工作台、流式结果、自动分页与完整结果总行数、服务端字段筛选、
查询/传输耗时拆分、分区与表大小、原始 parquet 段文件管理、运行中查询与会话、
提交事件流、运行期配置热更、库级授权、CSV 导入与 COPY 导出。

客户端只连接你配置的 QSDB 地址；密码/Token 只写入操作系统凭据管理器，不写
档案 JSON、不落日志。**许可证为 PolyForm Noncommercial 1.0.0（源码开放，
非 OSI 开源）**：个人、研究、教育与非营利使用免费；商业用途需单独授权，
联系 1510365643@qq.com。QSDB 数据库内核按其仓库中的许可证独立发布。

作者：qinwh · <https://github.com/qinwenhui/qsdb-studio>
