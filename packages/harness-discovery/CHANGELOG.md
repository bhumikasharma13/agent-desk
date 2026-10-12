# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-12

### Added

- Initial public release.
- `harness-discovery scan`, a command-line tool that lists the skills, rules, hooks and other agent files Claude Code, Codex, Cursor and Kiro load, with their scope and a content hash.
- `scan()`, which returns the same result to a script or CI job, with warnings and errors for anything it could not read.
- Collectors and sessions (`createCollectSession` and one collector per tool), for an app that keeps its own inventory.

[Unreleased]: https://github.com/tetriz-ai/agent-desk/compare/harness-discovery-v0.1.0...HEAD
[0.1.0]: https://github.com/tetriz-ai/agent-desk/releases/tag/harness-discovery-v0.1.0
