# Contributing to QSDB Studio

Thanks for taking the time to contribute. This document describes the local
workflow and the project's contribution terms.

## Before you start

- Search existing issues before opening a new one.
- For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a
  public issue.
- For large changes, open an issue first so the approach can be discussed.

## Development setup

Prerequisites:

- Rust 1.88+
- Node.js 22+
- Platform WebView prerequisites for Tauri 2
- The `qsdb-client` crate from crates.io (public builds). To develop against a
  local QSDB checkout, point the workspace dependency at your local
  `../QSDB/crates/qsdb-client` path.

```bash
git clone https://github.com/qinwenhui/qsdb-studio.git
cd qsdb-studio
npm ci
npm --prefix ui ci
npm run tauri dev
```

## Checks

Run these before opening a pull request:

```bash
npm --prefix ui run typecheck
npm --prefix ui run lint
npm --prefix ui run test
npm run build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p qsdb-studio-core
```

The real-server tests are opt-in via `QSDB_STUDIO_E2E_SERVER`; they are not
required for a normal pull request.

## Pull requests

- Keep changes focused and explain the problem and the chosen approach.
- Add tests for behavior changes where practical.
- Update documentation when the public behavior changes.
- Do not commit credentials, internal hostnames, customer data, local
  environment files, agent state directories, or generated build output.
- Do not reformat unrelated files.

## Commit messages

Use a short imperative subject and include a body when the change is not
obvious. Examples:

```text
fix(result): keep total count when retrying the current page
feat(files): show manifest column statistics in the detail pane
docs: clarify noncommercial licensing
```

## Contribution license

By submitting a pull request, issue attachment, or other contribution, you agree
that your contribution may be distributed under the project's license
(PolyForm Noncommercial 1.0.0) and that you have the right to grant that
permission. If your employer owns the work, make sure you have permission
before contributing.

## Code of conduct

Be respectful and constructive. Harassment, personal attacks, and disclosure of
other people's private information are not acceptable.
