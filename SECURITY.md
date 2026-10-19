# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| < 0.1 | No |

## Reporting a vulnerability

Please report security issues privately to **1510365643@qq.com**. Do not open a
public GitHub issue, discussion, or pull request for a vulnerability.

Include, when possible:

- Studio version (shown in **About** / `Studio v...` in the status bar).
- QSDB server version.
- Operating system and WebView version.
- A minimal reproduction and the affected feature.
- Sanitized logs. Remove passwords, tokens, connection URLs, SQL containing
  sensitive data, and file paths that identify your environment.

You should receive an acknowledgement within a few business days. Please allow
time for a fix before public disclosure.

## Scope

In scope:

- Credential handling and storage (OS keyring, profile files, logs).
- Local IPC / Tauri command boundaries and capability scope.
- File download, deletion, and path handling in the file manager.
- Protocol parsing and error handling in `qsdb-studio-core`.
- Supply-chain and dependency issues in this repository.

Out of scope:

- Vulnerabilities in the QSDB server itself — report those to the QSDB project.
- Issues that require a compromised operating system, keyring, or WebView.
- Self-XSS, social engineering, or denial of service against your own machine.
- Missing hardening headers in the static website unless they enable a concrete
  attack.

## Data handling

Studio does not include telemetry or crash upload. Passwords and tokens are
stored only in the operating system keyring. Connection profiles contain the
authentication kind and username, never the secret.
