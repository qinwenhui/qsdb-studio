# Third-party notices

QSDB Studio is built on open-source software. Each dependency remains under its
own license; the project's PolyForm Noncommercial license does not replace or
restrict the rights granted by those licenses.

This file lists the direct dependencies and their license families. Complete
license texts are shipped with the dependency sources and should be preserved
when redistributing binaries. Regenerate the full inventory before a release
with the tools of your choice (`cargo metadata`, `cargo-about`, and
`npm ls --all` / `license-checker`).

## Rust

| Package | License |
|---|---|
| tauri | MIT OR Apache-2.0 |
| tauri-plugin-dialog | MIT OR Apache-2.0 |
| tauri-plugin-opener | MIT OR Apache-2.0 |
| serde, serde_json | MIT OR Apache-2.0 |
| keyring | MIT OR Apache-2.0 |
| csv | Unlicense OR MIT |
| tempfile | MIT OR Apache-2.0 |
| qsdb-client | See the QSDB repository |

## JavaScript / TypeScript

| Package | License |
|---|---|
| vue | MIT |
| naive-ui | MIT |
| monaco-editor | MIT |
| sql-formatter | MIT |
| @tanstack/vue-virtual | MIT |
| @tauri-apps/api | MIT OR Apache-2.0 |
| @tauri-apps/plugin-dialog | MIT OR Apache-2.0 |
| @tauri-apps/plugin-opener | MIT OR Apache-2.0 |
| @tauri-apps/cli | MIT OR Apache-2.0 |

## QSDB

The QSDB database kernel and `qsdb-client` are separate projects. Their license
terms are defined in the [QSDB repository](https://github.com/qinwenhui/qsdb).
