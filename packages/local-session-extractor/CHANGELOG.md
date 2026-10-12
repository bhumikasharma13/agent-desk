# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-12

### Added

- Initial public release.
- The `local-session-extractor` command and the `openStore`, `readAll` and `exportSessions` library, which read Claude Code, Copilot, Codex, Cursor, Kiro and Antigravity sessions on macOS into one local SQLite store, one normalized row per session.
- Secrets, email addresses in session text and your user name masked before a row is stored, and nothing uploaded.
- An export in [Session Intelligence](https://github.com/tetriz-ai/session-intelligence)'s `Conversation` format, so a session goes straight into its analysis, with `--raw` for the stored rows.
- An outbox and host settings for embedding it in your own app.

[Unreleased]: https://github.com/tetriz-ai/agent-desk/compare/local-session-extractor-v0.1.0...HEAD
[0.1.0]: https://github.com/tetriz-ai/agent-desk/releases/tag/local-session-extractor-v0.1.0
