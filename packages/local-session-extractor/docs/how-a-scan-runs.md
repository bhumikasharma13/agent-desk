# How a scan runs

How the package fits together, and one scan followed from start to result. The [README](https://github.com/tetriz-ai/agent-desk/blob/main/packages/local-session-extractor/README.md) shows how to install and use it.

## How the parts fit

The package turns each session file an AI coding tool leaves on a Mac into one normalized row. It masks secrets, email addresses in session text and your user name, then stores the row in a local SQLite file. Each tool's login email and account ids are kept as they are, as [Redaction](limits.md#redaction) says.

```mermaid
flowchart LR
  tools["Local session files<br/>Claude Code, Copilot, Codex,<br/>Cursor, Kiro, Antigravity"] --> readers["Readers, one per source<br/>readAll / readSource"]
  host["Host settings<br/>logger, metrics, path overrides<br/>(local-session-extractor/host)"] -.-> readers
  lookup["cursor.lookup<br/>(optional callback)"] -.-> readers
  readers --> redact["Redaction<br/>user names, then secrets"]
  redact --> store[("SessionStore<br/>SQLite, versioned schema")]
  store --> exporter["exportSessions<br/>Session Intelligence Conversations"]
  store --> cli["local-session-extractor<br/>command"]
  store --> outbox["Outbox<br/>markSyncing / markSynced"]
  outbox --> yours["Your server"]
```

Use it as the `local-session-extractor` command or as a library through `openStore`, `readAll` and `exportSessions`. The outbox and the host settings are for embedding it in your own app, and [docs/reference.md](https://github.com/tetriz-ai/agent-desk/blob/main/packages/local-session-extractor/docs/reference.md) covers both. [Agent Desk](https://github.com/tetriz-ai/agent-desk/blob/main/README.md), the menu bar app in the same repository, reads its sessions through this package.

## One scan, step by step

```mermaid
sequenceDiagram
  participant Caller
  participant readAll
  participant Reader as Reader for one source
  participant Store as SessionStore
  Caller->>readAll: readAll(store, options)
  readAll->>readAll: check sources, paths and home
  readAll->>Store: record the home folder's owner
  loop each source, in order
    readAll-->>Caller: onProgress start
    readAll->>Reader: read this source's files
    Reader->>Reader: redact user names, then secrets
    Reader->>Store: upsert one row per session
    alt the source fails as a whole
      readAll->>readAll: add a redacted error, mark the source partial
    end
    readAll-->>Caller: onProgress done, with the count
  end
  readAll-->>Caller: ScanResult
```

A scan first checks its options and throws before reading anything when one is wrong. It then records the owner of the home folder it reads, so a later export hashes that name too.

Each source runs in turn, and a source that fails is marked partial while the next one still runs. The result carries the counts, the errors, the partial sources and any record kinds the readers did not know.
