# Changelog

All notable changes to QSDB Studio are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-09-05

Initial public preview.

### Added

- Multi-tab SQL workbench with per-tab connection binding, completion, hover,
  formatting, SQL file open/save/drag-drop, and persisted drafts.
- Execute current statement, selection, all statements, or cursor-to-end, with
  dangerous-SQL confirmation and read-only profiles.
- Bulk auto-pagination (500 rows/page) and streaming results, with full-result
  row count and server-side filters.
- Two-phase stop for streaming and ordinary queries: server-side cancel during
  execution and an explicit transfer abort after the server has unregistered
  the query. Streaming closes the dedicated stream connection; bulk requests
  use a concurrency-safe socket abort handle. Received rows remain readable and
  partial results are marked as incomplete.
- Query timing split into server execution and transfer/decoding when the server
  exposes `X-QSDB-Elapsed-Ms`.
- Database/table/column explorer with partition generation, row counts, segment
  counts, and on-disk bytes; table size from partition segment bytes.
- File manager for the QSDB storage tree: directory browsing, segment ownership
  and manifest column statistics, `readSql` preview, file download, and safe
  `_trash` handling for unreferenced segments only.
- Sessions and running-query views with cancellation; admin-only session kick.
- Commit-stream watch with cursor-expiry reconciliation.
- Runtime guardrail hot-update and database-level grants matrix.
- CSV import with preview, type inference, mapping, and per-value validation;
  COPY export with read-back verification.
- Bilingual Chinese / English UI with a persisted language preference
  (follows the system language on first launch) and localized Naive UI
  components, dates, and numbers.
- History, favorites, notifications, command palette, activity rail, keyboard
  shortcuts, connection colors, light/dark/system themes, wallpaper and glass
  customization, and window/layout persistence.
- Windows NSIS and MSI installers.
- Unsigned macOS universal `.dmg` (Apple Silicon + Intel); signing and
  notarization are not configured yet.

### Security

- Passwords and tokens are stored only in the OS keyring.
- No telemetry or crash upload.
- File deletion is restricted to unreferenced `seg_*.parquet` files and moves
  them to `_trash` instead of unlinking them.

[0.1.0]: https://github.com/qinwenhui/qsdb-studio/releases/tag/v0.1.0
