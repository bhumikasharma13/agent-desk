// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The package store's migrations, applied by position under `user_version`.
 * Additive only: an entry is never edited or removed once shipped, and a table
 * is never dropped here. The comment above each entry gives its position.
 */
export const MIGRATIONS: readonly string[] = [
  // migration 0
  `
CREATE TABLE IF NOT EXISTS conversations (
  id             TEXT PRIMARY KEY,
  ide_type       TEXT NOT NULL CHECK (ide_type IN ('claude-code', 'cursor')),
  session_id     TEXT NOT NULL,
  conversation   JSONB NOT NULL DEFAULT '[]',
  project_path   TEXT,
  last_mtime_ms  INTEGER NOT NULL DEFAULT 0,
  last_size      INTEGER NOT NULL DEFAULT 0,
  last_offset    INTEGER NOT NULL DEFAULT 0,
  sync_status    TEXT NOT NULL DEFAULT 'pending'
                   CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed')),
  synced_at      TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT (datetime('now')),
  created_at     TIMESTAMP NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ide_type, session_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_sync ON conversations(sync_status);
  `,
  // migration 1
  `
CREATE TABLE IF NOT EXISTS conversations_new (
  id             TEXT PRIMARY KEY,
  ide_type       TEXT NOT NULL CHECK (ide_type IN ('claude-code', 'cursor', 'antigravity')),
  session_id     TEXT NOT NULL,
  conversation   JSONB NOT NULL DEFAULT '[]',
  project_path   TEXT,
  last_mtime_ms  INTEGER NOT NULL DEFAULT 0,
  last_size      INTEGER NOT NULL DEFAULT 0,
  last_offset    INTEGER NOT NULL DEFAULT 0,
  sync_status    TEXT NOT NULL DEFAULT 'pending'
                   CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed')),
  synced_at      TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT (datetime('now')),
  created_at     TIMESTAMP NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ide_type, session_id)
);
INSERT INTO conversations_new SELECT * FROM conversations;
DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;
CREATE INDEX IF NOT EXISTS idx_conversations_sync ON conversations(sync_status);
  `,
  // migration 2
  `
ALTER TABLE conversations ADD COLUMN conversation_source_created_at_ms INTEGER;
  `,
  // migration 3
  `
ALTER TABLE conversations ADD COLUMN repo_name TEXT;
  `,
  // migration 4
  `
ALTER TABLE conversations ADD COLUMN session_meta TEXT;
ALTER TABLE conversations ADD COLUMN session_facets TEXT;
  `,
  // migration 5
  `
ALTER TABLE conversations ADD COLUMN installation_metadata TEXT;
  `,
  // migration 6
  `
ALTER TABLE conversations ADD COLUMN stats_cache TEXT;
ALTER TABLE conversations ADD COLUMN ai_attribution TEXT;
  `,
  // migration 7
  `
CREATE TABLE IF NOT EXISTS conversations_new (
  id             TEXT PRIMARY KEY,
  ide_type       TEXT NOT NULL CHECK (ide_type IN ('claude-code', 'cursor', 'copilot', 'antigravity')),
  session_id     TEXT NOT NULL,
  conversation   JSONB NOT NULL DEFAULT '[]',
  project_path   TEXT,
  repo_name      TEXT,
  last_mtime_ms  INTEGER NOT NULL DEFAULT 0,
  last_size      INTEGER NOT NULL DEFAULT 0,
  last_offset    INTEGER NOT NULL DEFAULT 0,
  conversation_source_created_at_ms INTEGER,
  session_meta   TEXT,
  session_facets TEXT,
  installation_metadata TEXT,
  stats_cache    TEXT,
  ai_attribution TEXT,
  sync_status    TEXT NOT NULL DEFAULT 'pending'
                   CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed')),
  synced_at      TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT (datetime('now')),
  created_at     TIMESTAMP NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ide_type, session_id)
);
INSERT INTO conversations_new SELECT * FROM conversations;
DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;
CREATE INDEX IF NOT EXISTS idx_conversations_sync ON conversations(sync_status);
  `,
  // migration 8
  `
CREATE TABLE IF NOT EXISTS conversations_new (
  id             TEXT PRIMARY KEY,
  ide_type       TEXT NOT NULL CHECK (ide_type IN ('claude-code', 'cursor', 'copilot', 'antigravity', 'codex')),
  session_id     TEXT NOT NULL,
  conversation   JSONB NOT NULL DEFAULT '[]',
  project_path   TEXT,
  repo_name      TEXT,
  last_mtime_ms  INTEGER NOT NULL DEFAULT 0,
  last_size      INTEGER NOT NULL DEFAULT 0,
  last_offset    INTEGER NOT NULL DEFAULT 0,
  conversation_source_created_at_ms INTEGER,
  session_meta   TEXT,
  session_facets TEXT,
  installation_metadata TEXT,
  stats_cache    TEXT,
  ai_attribution TEXT,
  sync_status    TEXT NOT NULL DEFAULT 'pending'
                   CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed')),
  synced_at      TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT (datetime('now')),
  created_at     TIMESTAMP NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ide_type, session_id)
);
INSERT INTO conversations_new SELECT * FROM conversations;
DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;
CREATE INDEX IF NOT EXISTS idx_conversations_sync ON conversations(sync_status);
  `,
  // migration 9
  `
CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);
  `,
  // migration 10
  `
CREATE TABLE IF NOT EXISTS conversations_new (
  id             TEXT PRIMARY KEY,
  ide_type       TEXT NOT NULL CHECK (ide_type IN ('claude-code', 'cursor', 'copilot', 'antigravity', 'codex', 'kiro')),
  session_id     TEXT NOT NULL,
  conversation   JSONB NOT NULL DEFAULT '[]',
  project_path   TEXT,
  repo_name      TEXT,
  last_mtime_ms  INTEGER NOT NULL DEFAULT 0,
  last_size      INTEGER NOT NULL DEFAULT 0,
  last_offset    INTEGER NOT NULL DEFAULT 0,
  conversation_source_created_at_ms INTEGER,
  session_meta   TEXT,
  session_facets TEXT,
  installation_metadata TEXT,
  stats_cache    TEXT,
  ai_attribution TEXT,
  sync_status    TEXT NOT NULL DEFAULT 'pending'
                   CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed')),
  synced_at      TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT (datetime('now')),
  created_at     TIMESTAMP NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ide_type, session_id)
);
INSERT INTO conversations_new SELECT
  id, ide_type, session_id, conversation, project_path, repo_name,
  last_mtime_ms, last_size, last_offset, conversation_source_created_at_ms,
  session_meta, session_facets, installation_metadata, stats_cache, ai_attribution,
  sync_status, synced_at, updated_at, created_at
FROM conversations;
DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;
CREATE INDEX IF NOT EXISTS idx_conversations_sync ON conversations(sync_status);
CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);
  `,
  // migration 11
  `
CREATE TABLE IF NOT EXISTS conversations_new (
  id             TEXT PRIMARY KEY,
  ide_type       TEXT NOT NULL CHECK (ide_type IN ('claude-code', 'cursor', 'copilot', 'antigravity', 'codex', 'kiro')),
  session_id     TEXT NOT NULL,
  conversation   JSONB NOT NULL DEFAULT '[]',
  project_path   TEXT,
  repo_name      TEXT,
  last_mtime_ms  INTEGER NOT NULL DEFAULT 0,
  last_size      INTEGER NOT NULL DEFAULT 0,
  last_offset    INTEGER NOT NULL DEFAULT 0,
  conversation_source_created_at_ms INTEGER,
  session_meta   TEXT,
  session_facets TEXT,
  installation_metadata TEXT,
  stats_cache    TEXT,
  ai_attribution TEXT,
  sync_status    TEXT NOT NULL DEFAULT 'pending'
                   CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed', 'skipped_out_of_scope')),
  synced_at      TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT (datetime('now')),
  created_at     TIMESTAMP NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ide_type, session_id)
);
INSERT INTO conversations_new SELECT
  id, ide_type, session_id, conversation, project_path, repo_name,
  last_mtime_ms, last_size, last_offset, conversation_source_created_at_ms,
  session_meta, session_facets, installation_metadata, stats_cache, ai_attribution,
  sync_status, synced_at, updated_at, created_at
FROM conversations;
DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;
CREATE INDEX IF NOT EXISTS idx_conversations_sync ON conversations(sync_status);
CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);
  `,
  // migration 12
  `
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT (datetime('now'))
);
  `,
  // migration 13
  `
CREATE INDEX IF NOT EXISTS idx_conversations_ide_created ON conversations(ide_type, created_at);
  `,
  // migration 14
  `
ALTER TABLE conversations ADD COLUMN content_hash TEXT;
ALTER TABLE conversations ADD COLUMN last_reextract_at INTEGER;
ALTER TABLE conversations ADD COLUMN tokens_observed INTEGER NOT NULL DEFAULT 0;
UPDATE conversations
SET tokens_observed = 1
WHERE ide_type = 'cursor'
  AND (
    SELECT json_extract(t.value, '$.metadata.inputTokens') > 0
        OR json_extract(t.value, '$.metadata.outputTokens') > 0
    FROM json_each(conversation) AS t
    WHERE json_extract(t.value, '$.role') = 'assistant'
    ORDER BY t.key DESC
    LIMIT 1
  ) = 1;
  `,
  // migration 15
  `
CREATE INDEX IF NOT EXISTS idx_conversations_project_path ON conversations(project_path);
  `,
  // migration 16
  `
ALTER TABLE conversations ADD COLUMN relation_type TEXT NOT NULL DEFAULT 'PRIMARY';
UPDATE conversations SET relation_type = COALESCE(json_extract(session_meta, '$.lineage.relation_type'), 'PRIMARY');
CREATE INDEX IF NOT EXISTS idx_conversations_ide_relation ON conversations(ide_type, relation_type);
  `,
  // migration 17
  `
ALTER TABLE conversations ADD COLUMN session_events TEXT;
ALTER TABLE conversations ADD COLUMN event_coverage TEXT;
`,
  // migration 18
  `ALTER TABLE conversations ADD COLUMN extractor_version INTEGER;`,
  // migration 19
  `CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);`,
  // migration 20: each session's last activity, the newest message time, else the source's
  // own last change. Existing rows are filled here, so a list is right as soon as it opens.
  `
ALTER TABLE conversations ADD COLUMN last_message_ms INTEGER NOT NULL DEFAULT 0;
UPDATE conversations SET last_message_ms = COALESCE(
  (SELECT CAST(ROUND((MAX(julianday(json_extract(t.value, '$.timestamp'))) - 2440587.5) * 86400000) AS INTEGER)
   FROM json_each(CASE WHEN json_valid(conversation) THEN CASE json_type(conversation) WHEN 'array' THEN conversation END END) AS t
   WHERE CASE WHEN t.type = 'object' THEN json_type(t.value, '$.timestamp') END = 'text'),
  last_mtime_ms);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_ms DESC, id);
`,
];
