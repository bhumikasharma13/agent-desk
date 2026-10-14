# Reference

This page lists the exact rules: the scan, the store, the export, the redaction, the host settings and the command line. The [README](../README.md) shows how to install and use the package. The full type signatures ship in the package's `.d.ts` files. The last sections cover versioning, checking a release and the tests.

## Scanning: `readAll` and `readSource`

`readAll(store, options?)` scans every source, or the ones in `options.sources`, into the store. `readSource(source, store, options?)` does the same for one source. Both return a `ScanResult`.

| Option | What it does |
|---|---|
| `sources` | The sources to run, in this order, each at most once. Defaults to `capabilities().sources` |
| `home` | Reads every default location under this folder instead of your home, a symlink followed. Runs no git, no `ps` and no request |
| `paths` | Per-location overrides for this scan. They win over `home` and the process-wide overrides |
| `captureLineage` | Also stores each sub-agent run as its own row (see [Sub-agents](#sub-agents)) |
| `extractorVersions` | A version number per source, stamped on every row that source writes |
| `logger`, `metrics` | This scan's logger and metrics sink. They win over the process-wide ones |
| `onProgress` | Called with `{ source, state: "start" }` and `{ source, state: "done", count }` for each source |
| `cursor.lookup` | A callback for the Cursor seat tier. Without it the package never contacts Cursor |

| `ScanResult` field | What it holds |
|---|---|
| `counts` | Sessions written per source that ran |
| `errors` | One `RecordError` per unreadable session or file, and one per source that failed as a whole |
| `partial` | Per source, `true` exactly when the source failed as a whole |
| `unknownRecordKinds` | Record kinds the readers did not know, keyed `<source>:<kind>` |
| `durationMs` | How long the scan took |
| `seatTier` | Present when the Cursor source reached the seat-tier step |

- **Order.** Sources run in the order given. A source that fails is marked in `partial`, and the next source still runs.
- **Errors.** A `RecordError` has `source`, `scope` (`session` or `source`), `sessionId`, `file` and `message`. The path and the message are redacted. A file-system error's message keeps the path it names, with the user name hashed and any token in it masked.
- **Validation.** These throw before any source runs.

| Input | Error |
|---|---|
| An unknown source | `UnsupportedSourceError` |
| A source listed twice | `DuplicateSourceError` |
| An unknown path key | `UnknownPathKeyError` |
| A `home` that is empty or not a directory | `TypeError` |

- **Change tracking.** A file whose size and modification time match the last scan is skipped.

### Where each source reads

All paths are under your home folder, or under `home` when it is given.

| Source | Where it reads |
|---|---|
| `claude-code` | `.claude/projects`, `.claude.json`, `.claude/usage-data`, `Library/Application Support/Claude` |
| `copilot` | `Library/Application Support/Code/User`, `.copilot/session-state`, `.config/github-copilot` |
| `antigravity` | `Library/Application Support/Antigravity/User`, `.gemini/antigravity/brain`, and a local server |
| `codex` | `.codex`: sessions, archived sessions, its SQLite state, `config.toml` and `auth.json` |
| `kiro` | `.kiro`, `Library/Application Support/kiro`, `Library/Application Support/kiro-cli` |
| `cursor` | `Library/Application Support/Cursor/User`, `.cursor` |

### Sub-agents

Claude Code keeps a sub-agent's transcript at `.claude/projects/<project>/<parent session>/subagents/agent-<id>.jsonl`, beside an `agent-<id>.meta.json` that names its agent type. With `captureLineage: true`, each one is its own row, and `session_meta.lineage` holds these fields.

| Field | Meaning |
|---|---|
| `relation_type` | `SUBAGENT` or `PLUGIN` |
| `parent_record_key` | The parent row's `id` |
| `linkage_confidence` | `STRONG`, `HEURISTIC` or `NONE`. Fold a child into its parent only when this is `STRONG` |
| `tokens` | The child run's own token count |
| `origin_agent_type` | The agent that ran, such as `Explore` |
| `plugin_name` | The plugin that spawned the child, for a `PLUGIN` run |
| `spawn_depth` | Nesting depth, 0 for a direct child of a session |
| `tool_use_id` | The tool call in the parent that started the child |

### Cursor stop ledger

A Cursor stop hook you install yourself can write `~/.cursor/token-events-raw/stop.jsonl`, a file Cursor itself never writes. The scan reads it when it exists, and never moves or rotates it. Each line is one JSON object.

| Field | Meaning |
|---|---|
| `conversation_id` | The Cursor conversation |
| `generation_id` | One model generation. Repeats of the same id are merged |
| `status` | The generation's outcome, such as `completed` or `error` |
| `input_tokens` | The whole prompt, the cached tokens included |
| `output_tokens` | Tokens generated |
| `cache_read_tokens`, `cache_write_tokens` | The cached part of `input_tokens` |
| `model` | The model name |

The measured counts replace Cursor's own estimates on the matching turns.

## The store: `openStore` and `SessionStore`

`openStore(path?, { mustExist? })` opens the store, or creates it. The default path is `~/.local-session-extractor/sessions.db`, from `defaultStorePath()`.

- **Permissions.** The folder is created at mode 0700. A file the call creates, or an empty file it initialises, is set to 0600.
- **Identity.** A file that is not a store is refused with `StoreOpenError` before SQLite opens it, so nothing in it, its `-wal` or its mode changes. A path that is a symlink to a missing file is refused too. With `{ mustExist: true }`, a missing, empty or older store is refused too, and nothing is created or migrated.
- **Migrations.** They run forward only, inside one write transaction. A store from a newer version opens as long as every column this version reads exists.
- **Reading.** `getConversation(source, sessionId)` returns one row. `listConversations({ ideType, projectPath, repoName, updatedSince, syncStatus, limit, offset })` returns the most recently updated rows, 500 by default.
- **Reading for a list view.** Neither method below returns the conversation as one string or `installation_metadata`.
  - `listSessionSummaries({ ideType, projectPath, query, limit, after })` returns `{ rows, total }`: one page of primary sessions, 50 by default and at most 200. `projectPath: null` lists the sessions with no folder. Sub-agent, plugin and hook runs are left out, as in `countByIde`.
  - The most recently active come first, by `last_message_ms`: the session's newest message time, else when the reader saw its source last change. Every write sets it, migration 20 fills older rows, and an index serves the order. Rows with the same time come in `id` order.
  - Pass the last row of a page as `after` to get the next one. No unchanged row repeats or is skipped. A row whose activity moves older between pages can come again later, so de-duplicate by `id`. `total` counts every match, in the same read as the page.
  - Each row has `id`, `ideType`, `sessionId`, `lastActivityMs`, `lastActivityAt`, `projectPath`, `repoName`, `branch`, `title`, `startedAt`, `durationMinutes`, `userMessages`, `assistantMessages` and `models`. `branch` is the last of `git_branches`, else `git_branch`, as stored. The title is `session_title`, else `first_prompt`, else the first message's text, cut to 200 characters. The counts, models and times come from the stored messages.
  - `query`, at most 200 characters, matches every source of the title: `session_title`, `first_prompt` and the first message. It ignores ASCII case only, and `%` and `_` match themselves.
  - A row whose stored conversation is not a JSON array lists with no messages, and stored JSON that does not parse is read as absent.
  - `getConversationPage(id, { offset, limit })` takes a row's `id` and returns `{ total, messages }`, 100 messages by default and at most 1,000, or null for an unknown id. It throws when the stored conversation is not a JSON array.
  - Each message has `role`, `content`, `timestamp`, `model`, `inputTokens`, `outputTokens` and `isSubAgent`. Only user and assistant messages are returned and counted, as in the list's counts. A content that is not text reads as an empty string.

### Sync states

Every row has a sync state, for a host that copies rows elsewhere.

| State | Meaning |
|---|---|
| `pending` | New or changed, waiting to be sent |
| `syncing` | Claimed by `markSyncing`. Handed back by `getPendingConversations` after 30 minutes |
| `synced` | `markSynced` recorded the delivery |
| `failed` | `markFailed` recorded a rejection. It stays failed until `resetToPending` |
| `skipped_out_of_scope` | Parked by `applyScope`, because its project is outside the host's scope |

- **Cursor rows.** A re-read Cursor row goes back to `pending` only when what it stores changed: the conversation, `session_meta` (less the workspace-wide MCP and transcript counts), the project path, the repo name, the events, the event coverage, the facets or the stats cache.
- **The outbox.** `getPendingConversations(limit)` returns pending rows, oldest first. Call `markSyncing(ids)` before sending. `markSynced(id)` and `markFailed(id)` change only a row that is still `syncing`, so a row that changed during the send is sent again.
- **Scope.** `applyScope(paths, "filtered")` parks every pending row outside `paths`, a row with no project included. It puts parked rows back in the queue once they are in scope. `getDistinctProjectPaths`, `listDetectedProjects` and `countByIdeAndProject` help a host choose `paths`.
- **Resetting.** `clearAll()` deletes every row and every stored setting. `resetFileDedupTracking(sources)` makes the next scan read those sources' files again, and leaves each row's `updated_at` as it was.

## Export: `exportSessions`

`exportSessions(store, { format, out, shape?, filter?, includeSyncState? })` writes every matching session and returns `{ written }`. `format: "jsonl"` writes one JSON object per line, and `format: "json"` one array of them. `exportSessions(store, { split, force?, filter? })` writes one `Conversation` per file instead, as [Split](#split-one-conversation-per-file) describes.

- **Shape.** By default each object is a [Session Intelligence](https://github.com/tetriz-ai/session-intelligence) `Conversation` (`sessionintelligence.v1`, `conversation.proto`) in its protojson form, as [Session Intelligence's `Conversation`](#session-intelligences-conversation) describes. `shape: "row"` writes the stored row instead, its JSON columns parsed. `toConversation(record)` turns one such row into a `Conversation`, and the CLI's `--raw` is `shape: "row"`.
- **Snapshot.** One export reads one consistent snapshot of the store.
- **Redaction.** A `Conversation` is built from the redacted row, so both shapes are redacted alike. In the row, every string and every object key in every exported JSON column is redacted, whatever field it is in, and a column that does not parse is redacted whole. So is every other text column, `project_path`, `repo_name` and `event_coverage` among them, but an id, hash, enum or timestamp of the shape the store writes. A column stored as bytes is read as its text first. An id, a timestamp or an event's `operation_name` usually comes out unchanged, but a user name, path or secret inside one is masked. `installation_metadata` is kept as stored.
- **Stored rows.** The store keeps branch, model and agent names as the readers wrote them. Only the export hashes a user name inside them.
- **File target.** A file path is replaced whole at mode 0600, through a temp file beside it. A symlink is refused.
- **Stream target.** A stream is written and left open for the caller to end. The whole snapshot is read into memory first.
- **Sync columns.** With `shape: "row"`, `sync_status` and `synced_at` are dropped unless `includeSyncState` is set. `includeSyncState` without `shape: "row"` throws, since a `Conversation` has no sync state. `last_message_ms`, the list order derived from the messages, is never exported.
- **Filter.** `filter` narrows by `ideType`, `projectPath`, `repoName`, `updatedSince` and `syncStatus`.

### Split: one `Conversation` per file

Session Intelligence's `analyze-real` and `ReadConversationFile` read one `Conversation` per file, and `ReadConversationDir` reads every `.json` file under a folder. `split` (the CLI's `--split <folder>`) writes that form.

- **Names.** Each session goes to `<ide_type>/<name>.json`, where the name is the first 32 hex digits of the SHA-256 of its redacted session id. A name is the same in every export, holds no path separator, and says nothing the file does not. Two sessions whose ids redact alike get the store row id mixed into the second one's hash.
- **Folder.** A missing folder is created at mode 0700. One that is not empty is refused unless `force` (`--force`), which replaces the files of the same name and leaves every other file, an older export's included.
- **Files.** Each file is written at mode 0600 through a temp file beside it and a rename, so it is whole or absent. A failed export leaves the files written before it. A symlink in place of the folder, a source folder or a file is refused.
- **Options.** `split` takes no `out`, `format`, `includeSyncState` or `shape: "row"`, and throws when given one. The CLI's `--split` refuses `--out`, `--format` and `--raw` with a usage error.

### Session Intelligence's `Conversation`

The export matches `conversation.proto` at Session Intelligence commit `aebbc1d`. `src/__tests__/sessionIntelligenceContract.test.ts` parses every fixture session with unknown fields and unknown enum names refused, against the descriptor in `contract/session-intelligence/`.

- **Names and values.** Every key is the proto field's JSON name, which is the stored snake_case name in lowerCamelCase (`session_meta.tool_counts` becomes `sessionMeta.toolCounts`). Enums are written by value name, timestamps as RFC 3339, and int64 counts as JSON numbers. The same test checks every entry of the converter's field tables against the descriptor, with or without fixture data: its JSON name, its type and its enum value names.
- **Nothing is invented.** A value whose type the proto field cannot hold is left out: a fraction in an int32 field, a timestamp with no time zone, an unknown enum value. A list is kept only when every element fits. Each stored message becomes one prompt, so an event's `promptOrdinal` still points at it.
- **Timestamps.** Session Intelligence refuses the whole `Conversation` over one timestamp outside 0001-01-01 to 9999-12-31 UTC, or a date or time that does not exist, such as `2026-02-30` or `T24:00:00`. Such a timestamp is left out. An event whose time is left out is still written, without `occurredAt`, so its `sequence` stays.
- **Large counts.** An int64 count above 2^53 is left out, since a JSON number cannot hold it exactly. No count the readers write gets that large.

| Row column | `Conversation` field |
|---|---|
| `ide_type` | `ideType`: `IDE_TYPE_CLAUDE_CODE`, `IDE_TYPE_CURSOR`, `IDE_TYPE_COPILOT`, `IDE_TYPE_ANTIGRAVITY`, `IDE_TYPE_CODEX` or `IDE_TYPE_KIRO` |
| `session_id` | `sessionId`, redacted as in the row |
| `project_path` | `projectName`: the path's last segment |
| `conversation` | `prompts`: `role` as `ROLE_USER` or `ROLE_ASSISTANT`, `content`, `timestamp` and `metadata` (`permission_mode` becomes `permissionMode`) |
| the earliest prompt time, else `conversation_source_created_at_ms`, else `created_at` (UTC) | `conversationStartedAt` |
| `last_mtime_ms` | `lastUpdatedAt` |
| `session_meta`, `session_facets`, `installation_metadata`, `ai_attribution`, `stats_cache`, `session_events` | `sessionMeta`, `sessionFacets`, `installationMetadata`, `aiAttribution`, `statsCache`, `sessionEvents`, field by field |
| `session_meta.lineage.relation_type` | `relationType`: `CONVERSATION_TYPE_` and the stored value |
| `session_meta.lineage.linkage_confidence` | `linkageConfidence`: `LINKAGE_CONFIDENCE_` and the stored value |
| `event_coverage` | `eventCoverage` |
| `extractor_version` | `extractorVersion`, when set |

These are left out, because the proto has no field with their meaning.

| Left out | Why |
|---|---|
| `id`, `last_size`, `last_offset`, `content_hash`, `last_reextract_at`, `tokens_observed`, `updated_at`, `sync_status`, `synced_at` | Store bookkeeping |
| `relation_type` | The same value is in `sessionMeta.lineage.relationType` |
| `repo_name` | No such field |
| `session_meta.session_duration_seconds` | No such field. For a Kiro session, Session Intelligence takes the session's duration from `durationMinutes`, which Kiro writes as these seconds over 60. For every other source it takes `lastUpdatedAt` minus `conversationStartedAt`, and reads a `durationMinutes` (Copilot writes one from its own times) separately, as the IDE-reported duration |
| `session_meta.total_input_tokens`, `total_output_tokens` | The proto's `inputTokens` and `outputTokens` are Claude Code's own session counts, a measure these are not shown to equal |
| `session_meta.lineage.parent_record_key` | The parent row's store id. The proto's `parentSessionId` is the parent's own session id, a different value |

So a `Conversation` cannot link a sub-agent, plugin or hook session to its parent. To link them, export the rows (`--raw`, or `shape: "row"`) and match `session_meta.lineage.parent_record_key` to the parent's `id`.

## Redaction

`redactText`, `redactPath`, `redactPrompts` and `sanitizeSessionMeta` apply the masks the scan uses. `unredactPath` reverses a path this machine redacted.

- **Secrets.** Text is checked against 28 patterns, plus a check for quoted strings that look random and for AWS keys named in context. A match becomes `████████`.
- **People.** Email addresses become `████████`. Your user name becomes `user_` and 8 hex characters, in paths and as a plain word.
  - A name shorter than 4 characters, or a common account name, is hashed in paths only.
  - The owner of a scanned home folder is hashed in paths only.
  - On macOS a home path matches in any letter case, and a `%2F`-encoded path matches too.
- **Session details.** `sanitizeSessionMeta` classifies every field as text, a path, a list of names, nested data, a bridge URL or a value to keep. A field it does not know has every string in it redacted.
- **Bridge URL.** `bridge_session_url` keeps its host and leading path. Its last non-empty segment is masked and its query dropped.
- **Long addresses.** An email local part longer than 256 characters has its last 256 characters masked with the domain.
- **Masks too much.** These are masked though they may not be secret, the safe direction.

| Input | Why it is masked |
|---|---|
| A quoted string that looks random, such as an id | It passes the check for random-looking quoted strings |
| A quoted home path | Once the name in it is hashed, it looks random |
| A port-like `redis://:6379@host` | Its userinfo holds a `:` |
| `https://host:8080/a@b`, with no user | The `host:port` reads as `user:password`, and a host follows the `@` |
| A short value of a secret-named key, such as `token: string` in code | Any value of such a key is masked |


| Kind | What is masked |
|---|---|
| Vendor tokens | Anthropic, OpenAI (every key form), GitHub, Slack, Stripe, npm, PyPI, Hugging Face, Google and AWS keys, Discord webhooks |
| Credentials in text | any `scheme://user:password@host` URL, masked from the scheme to the end of the URL, whatever its password holds, with an empty or socket host (`@/db?host=/tmp`, `@:5433`) or a user holding `@`, `Bearer` tokens of 8 or more characters, any value of a secret-named key (`KEY=value`, `"key": "value"`), PEM private keys |
| Web tokens and addresses | JSON Web Tokens, whole or cut short, and email addresses in any script |

## Host settings: `local-session-extractor/host`

`setLogger`, `setMetricsSink` and `setPathOverrides` set process-wide defaults for every scan. A scan's own options win over them.

- **Defaults.** The logger is silent and the metrics sink discards until a host installs one. `setLogger(null)` and `setMetricsSink(null)` restore the defaults.
- **Precedence.** A scan's `paths` win over `home`, and `home` wins over `setPathOverrides`.
- **Keys.** `PathKey` names each location a host can override. `getPathOverride`, `hasPathOverride` and `resetPathOverrides` read and clear them.

| Metric | When it is counted |
|---|---|
| `unknown_record_kinds`, tags `component`, `errorKind: "parse"`, `status: "skipped"` | A reader met a record kind it does not know, or a known record missing a field it reads. `component` names the reader, such as `extraction.claude_code` |

## The command line

| Command | What it does |
|---|---|
| `scan` | Reads every source into the store. `--sources a,b` picks sources. `--home <dir>` reads under that folder, with no git and no `ps` |
| `status` | Sessions per source, and rows per sync state |
| `list` | The most recently updated sessions. `--limit <n>` (default 20) and `--sources <one>` |
| `show <source> <session-id>` | One session in full, as a Session Intelligence `Conversation`. Takes the id as `list` prints it or as stored. `--raw` shows the stored row |
| `export` | Every session as Session Intelligence `Conversation`s. `--out <file>`, `--format jsonl` (one per line, the default) or `--format json` (one array), `--sources <one>`, `--raw` for the stored rows, `--include-sync-state` with `--raw`. `--split <folder>` writes one `Conversation` per file, with `--force` for a folder that is not empty |
| `capabilities` | The sources, formats, platforms and versions this build supports |
| `reset` | Deletes every stored session (`--all`, the default), or clears the change tracking (`--dedup`, with `--sources`) |

- **Store.** `--db <path>` picks the store. The read commands and `reset` never create one.
- **Output.** `--json` gives machine-readable output for `scan`, `status`, `list`, `show` and `capabilities`.
- **Confirmation.** `reset` asks first. Without `--yes` it refuses to run when input is not a terminal.
- **Session ids.** An id that starts with `-`, as a Claude Code id does, goes after `--`, with options before it: `local-session-extractor show --db <path> claude-code -- <id>`. A Claude Code id has the form `<encoded project folder>::<session uuid>`.
- **Exit codes.** 0 on success, 2 when a scan finished but at least one source failed as a whole, 1 on a usage error or any other failure. A session that could not be read is reported and still exits 0.

## Versioning and compatibility

The package is at v0.1.0 and follows semantic versioning. A change to an exported signature, a store column or an export field is breaking. Before 1.0, the store schema, the export fields and the function signatures may change in a minor release.

## Checking a release

Each version has its own URL, with the version in both the tag and the file name. To check a downloaded `.tgz`, run `shasum -a 256 -c <file>.tgz.sha256` beside the `.sha256` the release attaches. These manually built releases include checksums but no hosted build provenance attestation.

## Tests

`pnpm test` runs the whole suite offline. A test-wide guard gives every test an empty temp home, blocks `ps` and HTTPS, and ignores your git settings.

`scripts/smoke-install.sh` installs the packed package and compares a scan of the fixture homes with `fixtures/golden.jsonl` and `fixtures/golden-conversation.jsonl`. Run every example locally through `scripts/run-examples.sh`; GitHub Actions is disabled.
