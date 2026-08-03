// SQLite lifecycle: handle cache, schema SQL, and idempotent migrations.
// Lives next to its sibling modules (memory.js, edges.js, working.js,
// conversations.js) so persist.js can act as a thin re-export barrel.
//
// The same SQLite schema is used for both project and global databases;
// the only difference is the directory layout and the value stored in
// the `project_key` column. Project databases store a SHA-256 prefix of
// the canonical project root. The global database stores the literal
// string `_global`. Because IDs are derived from `(projectKey, ...)`,
// an id in one database never collides with an id in the other.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 8;

// Schema migrations. Each entry is idempotent: it inspects the live
// schema, no-ops when its target shape is already in place, and
// mutates the schema otherwise. All entries run unconditionally on
// every openDb() call; cost is one PRAGMA table_info per migration.
//
// To add a future schema change: append a new idempotent function
// here, and bump SCHEMA_VERSION above so observers can tell which
// migrations exist. The migrations themselves never depend on
// SCHEMA_VERSION.
const MIGRATIONS = [
  // working_memory: composite primary key (project_key, slot). Pre-v2
  // DBs had a single-column primary key on (slot) only, which made
  // per-project isolation impossible at the SQL level.
  function migrateWorkingMemoryCompositePk(db) {
    const pk = db.prepare('PRAGMA table_info(working_memory)').all();
    if (pk.filter((column) => column.pk > 0).length === 2) return;
    db.exec(`
      BEGIN;
      ALTER TABLE working_memory RENAME TO working_memory_v1;
      CREATE TABLE working_memory (
        slot TEXT NOT NULL,
        project_key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_key, slot)
      );
      INSERT OR REPLACE INTO working_memory (slot, project_key, value, updated_at)
        SELECT slot, project_key, value, updated_at FROM working_memory_v1;
      DROP TABLE working_memory_v1;
      COMMIT;
    `);
  },

  // v3: add embedding columns + usage tracking. All columns are
  // idempotent — re-runs are no-ops via the `have` set check.
  function migrateAddEmbeddingColumns(db) {
    const cols = db.prepare('PRAGMA table_info(memories)').all();
    const have = new Set(cols.map((c) => c.name));
    const alters = [];
    if (!have.has('embedding')) alters.push('ALTER TABLE memories ADD COLUMN embedding BLOB');
    if (!have.has('embedding_model'))
      alters.push('ALTER TABLE memories ADD COLUMN embedding_model TEXT');
    if (!have.has('embedding_dim'))
      alters.push('ALTER TABLE memories ADD COLUMN embedding_dim INTEGER');
    if (!have.has('embedded_at')) alters.push('ALTER TABLE memories ADD COLUMN embedded_at TEXT');
    if (!have.has('access_count'))
      alters.push('ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0');
    if (!have.has('last_accessed_at'))
      alters.push('ALTER TABLE memories ADD COLUMN last_accessed_at TEXT');
    for (const sql of alters) db.exec(sql);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_embedded_at'",
      )
      .get();
    if (!idx) db.exec('CREATE INDEX idx_memories_embedded_at ON memories(embedded_at)');
  },

  // v4: typed edges between memories (related | supports | contradicts |
  // supersedes | synthesizes). Replaces the in-memory supersedes /
  // superseded_by columns going forward — those stay for back-compat, but
  // new links land here. Idempotent: create-table-if-missing plus
  // index-if-missing probes.
  function migrateAddMemoryEdges(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_edges (
        id          TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        from_id     TEXT NOT NULL,
        to_id       TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('related','supports','contradicts','supersedes','synthesizes')),
        weight      REAL NOT NULL DEFAULT 1.0,
        created_at  TEXT NOT NULL,
        UNIQUE(project_key, from_id, to_id, kind)
      )
    `);
    const idxFrom = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_edges_from'")
      .get();
    if (!idxFrom)
      db.exec('CREATE INDEX idx_memory_edges_from ON memory_edges(project_key, from_id)');
    const idxTo = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_edges_to'")
      .get();
    if (!idxTo) db.exec('CREATE INDEX idx_memory_edges_to ON memory_edges(project_key, to_id)');
  },

  // v5: extend the memories CHECK to allow 'conclusion' (the higher-order
  // type that synthesizes N underlying memories) and add the
  // memory_synthesizes table that records conclusion → source edges.
  //
  // SQLite cannot ALTER an existing CHECK constraint in place. The
  // migration probes first (try INSERT type='conclusion' on a throwaway
  // row); only if that fails do we rebuild the memories + memories_fts
  // tables with the new constraint and copy every row across. The probe
  // row is always deleted before returning. CREATE TABLE IF NOT EXISTS
  // keeps the migration idempotent — re-runs are no-ops once the rebuild
  // has happened.
  function migrateAddConclusionType(db) {
    // Probe: can we already insert type='conclusion'?
    const probeId = '__conclusion_probe__';
    let needsRebuild = false;
    try {
      db.prepare(
        "INSERT INTO memories (id, project_key, type, content) VALUES (?, '_conclusion_probe', 'conclusion', 'x')",
      ).run(probeId);
      // Succeeded — the CHECK already accepts 'conclusion'. Tidy up.
      db.prepare('DELETE FROM memories WHERE id=?').run(probeId);
    } catch {
      needsRebuild = true;
    }
    if (needsRebuild) {
      db.exec(`
        BEGIN;
        CREATE TABLE memories_new (
          id            TEXT PRIMARY KEY,
          project_key   TEXT NOT NULL,
          type          TEXT NOT NULL CHECK (type IN ('working','episodic','semantic','procedural','conclusion')),
          title         TEXT,
          content       TEXT NOT NULL,
          tags          TEXT NOT NULL DEFAULT '[]',
          metadata      TEXT NOT NULL DEFAULT '{}',
          provenance    TEXT NOT NULL DEFAULT '{}',
          confidence    REAL NOT NULL DEFAULT 0.8,
          status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','deleted')),
          priority      INTEGER NOT NULL DEFAULT 0,
          supersedes    TEXT,
          superseded_by TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          expires_at    TEXT,
          embedding       BLOB,
          embedding_model TEXT,
          embedding_dim   INTEGER,
          embedded_at     TEXT,
          access_count     INTEGER NOT NULL DEFAULT 0,
          last_accessed_at TEXT
        );
        INSERT INTO memories_new
          SELECT id, project_key, type, title, content, tags, metadata, provenance,
                 confidence, status, priority, supersedes, superseded_by,
                 created_at, updated_at, expires_at,
                 embedding, embedding_model, embedding_dim, embedded_at,
                 access_count, last_accessed_at
          FROM memories;
        DROP TABLE memories;
        ALTER TABLE memories_new RENAME TO memories;
        -- Recreate every index the SCHEMA_SQL ships with. Indexes don't
        -- survive DROP TABLE, so we have to re-create them after the
        -- rename. These mirror SCHEMA_SQL exactly — keep them in sync.
        CREATE INDEX idx_memories_project_type   ON memories(project_key, type);
        CREATE INDEX idx_memories_project_status ON memories(project_key, status);
        CREATE INDEX idx_memories_expires        ON memories(expires_at);
        CREATE INDEX idx_memories_supersedes     ON memories(supersedes);
        CREATE INDEX idx_memories_embedded_at    ON memories(embedded_at);
        -- FTS5 is a virtual table; rebuild from the canonical memories
        -- table so the search index stays consistent. The tags column
        -- is a JSON string ('["a","b"]'); FTS5 tokenizes it as text,
        -- which is sufficient for keyword recall (titles + content are
        -- the high-signal fields anyway).
        DELETE FROM memories_fts;
        INSERT INTO memories_fts (id, project_key, type, title, content, tags)
          SELECT id, project_key, type, title, content, tags
          FROM memories;
        COMMIT;
      `);
    }
    // The synthesizes edge table is additive; idempotent via IF NOT EXISTS.
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_synthesizes (
        parent_id   TEXT NOT NULL,
        child_id    TEXT NOT NULL,
        project_key TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (parent_id, child_id)
      )
    `);
    const idxSynth = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_synthesizes_child'",
      )
      .get();
    if (!idxSynth)
      db.exec('CREATE INDEX idx_memory_synthesizes_child ON memory_synthesizes(child_id)');
  },

  // v6: project_paths registry. Records the canonical project root for
  // every project_key that has ever opened this DB. Memory_prune reads
  // this table to find project DBs whose canonical root no longer
  // exists on disk (orphans from deleted projects). Idempotent: create-
  // table-if-missing plus index-if-missing.
  function migrateAddProjectPaths(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_paths (
        project_key    TEXT PRIMARY KEY,
        canonical_root TEXT NOT NULL,
        first_seen_at  TEXT NOT NULL,
        last_seen_at   TEXT NOT NULL
      )
    `);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_project_paths_root'",
      )
      .get();
    if (!idx) db.exec('CREATE INDEX idx_project_paths_root ON project_paths(canonical_root)');
  },

  // v7: embedding error surface. The async embedding microtask was
  // previously a black box — a failed download or model load left the
  // row in `embedding_status: 'pending'` forever with no diagnostic
  // beyond a one-shot stderr line. Add a `last_embed_error` column so
  // the failure mode is observable through `memory_status` and via
  // `rowToMemory`. Cleared to NULL on the next successful embed.
  function migrateAddEmbedErrorColumn(db) {
    const cols = db.prepare('PRAGMA table_info(memories)').all();
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('last_embed_error')) {
      db.exec('ALTER TABLE memories ADD COLUMN last_embed_error TEXT');
    }
  },

  // v8: project path move history. The v6 design overwrote
  // canonical_root on every record, which meant a project that
  // physically moved (and got re-stamped) was no longer detectable as
  // an orphan. We add `last_canonical_root` so the previous path is
  // preserved when a re-record happens, and tighten the ON CONFLICT
  // update to copy the current root to `last_canonical_root` first
  // (idempotent: same canonical_root means no copy is needed).
  function migrateAddProjectPathHistory(db) {
    const cols = db.prepare('PRAGMA table_info(project_paths)').all();
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('last_canonical_root')) {
      db.exec('ALTER TABLE project_paths ADD COLUMN last_canonical_root TEXT');
    }
    if (!have.has('record_count')) {
      db.exec('ALTER TABLE project_paths ADD COLUMN record_count INTEGER NOT NULL DEFAULT 1');
    }
  },
];

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  project_key   TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('working','episodic','semantic','procedural')),
  title         TEXT,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',  -- JSON array
  metadata      TEXT NOT NULL DEFAULT '{}',  -- JSON object
  provenance    TEXT NOT NULL DEFAULT '{}',  -- JSON object: {source, session_id, cwd, ...}
  confidence    REAL NOT NULL DEFAULT 0.8,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','deleted')),
  priority      INTEGER NOT NULL DEFAULT 0,
  supersedes    TEXT,                         -- id of the memory this one replaces
  superseded_by TEXT,                         -- id of the memory that replaced this one
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  expires_at    TEXT,                         -- ISO; null = never
  -- v3: embedding support for hybrid (FTS5 + vector) retrieval.
  -- embedding is a packed Float32Array little-endian, EMBEDDING_DIM floats.
  embedding       BLOB,
  embedding_model TEXT,
  embedding_dim   INTEGER,
  embedded_at     TEXT,
  -- v3: usage tracking for importance / decay (will be used by #3).
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_project_type ON memories(project_key, type);
CREATE INDEX IF NOT EXISTS idx_memories_project_status ON memories(project_key, status);
CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);
CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories(supersedes);
-- idx_memories_embedded_at is created by the v3 migration after it
-- adds the embedded_at column. Including it here would fail on any
-- pre-v3 database because the column doesn't exist yet.

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  project_key UNINDEXED,
  type UNINDEXED,
  title,
  content,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS working_memory (
  slot          TEXT NOT NULL,                -- e.g. 'current_focus'
  project_key   TEXT NOT NULL,
  value         TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (project_key, slot)
);

CREATE TABLE IF NOT EXISTS conversations (
  session_id    TEXT NOT NULL,
  project_key   TEXT NOT NULL,
  cwd           TEXT,
  byte_offset   INTEGER NOT NULL DEFAULT 0,
  line_count    INTEGER NOT NULL DEFAULT 0,
  last_event_at TEXT,
  last_import_at TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (session_id, project_key)
);

CREATE TABLE IF NOT EXISTS conversation_events (
  session_id    TEXT NOT NULL,
  project_key   TEXT NOT NULL,
  line_no       INTEGER NOT NULL,
  byte_offset   INTEGER NOT NULL,
  role          TEXT,                         -- 'user'|'assistant'|'tool'|'system'|...
  kind          TEXT,                         -- 'message'|'tool_call'|'tool_result'|...
  payload       TEXT NOT NULL,                -- raw JSON
  summary       TEXT,                         -- extracted short text when possible
  created_at    TEXT,
  PRIMARY KEY (session_id, project_key, line_no)
);
CREATE INDEX IF NOT EXISTS idx_events_role ON conversation_events(session_id, project_key, role);

-- v6: per-DB project_paths registry. Each row pins a project_key to the
-- canonical project root the DB was last opened with. Memory_prune uses
-- this to find orphan DBs whose project no longer exists on disk. The
-- global DB has no canonical root of its own; its project_paths table
-- stays empty.
--
-- v8: last_canonical_root records the previous root when a re-record
-- happens, and record_count tracks how active the project is.
CREATE TABLE IF NOT EXISTS project_paths (
  project_key         TEXT PRIMARY KEY,
  canonical_root      TEXT NOT NULL,
  first_seen_at       TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  last_canonical_root TEXT,
  record_count        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_project_paths_root ON project_paths(canonical_root);
`;

// Path-keyed handle cache. Each hook or MCP call may legitimately open
// both the project database and the global database simultaneously, so
// we cannot keep a single handle + key. closeDb() releases every
// cached handle, so callers can rely on exit hooks to flush WAL.
const cachedDbs = new Map();

export function openDb(dbPath) {
  const existing = cachedDbs.get(dbPath);
  if (existing) return existing;
  // node:sqlite does not create the parent directory; do it ourselves
  // so callers (tests, hooks, MCP server) can pass a path that does
  // not yet exist.
  const parent = path.dirname(dbPath);
  try {
    mkdirSync(parent, { recursive: true });
  } catch {
    /* ignore */
  }
  // Open read-write + create if missing.
  const db = new DatabaseSync(dbPath, { readOnly: false, create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  // The hook runner and the MCP server are separate processes that
  // both write to the same DB. WAL allows concurrent readers + a
  // single writer, but a second writer must wait for the first to
  // commit; without a busy_timeout SQLite returns SQLITE_BUSY
  // immediately. 5s is generous for a single-row insert but short
  // enough that a stuck MCP server doesn't hang the hook.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA_SQL);
  // Run every idempotent migration. Cost is one PRAGMA per migration;
  // on a healthy DB each one short-circuits.
  for (const migrate of MIGRATIONS) migrate(db);
  db.prepare(
    `
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `,
  ).run(String(SCHEMA_VERSION));
  cachedDbs.set(dbPath, db);
  return db;
}

export function closeDb(dbPath) {
  if (dbPath) {
    const db = cachedDbs.get(dbPath);
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      cachedDbs.delete(dbPath);
    }
    return;
  }
  for (const [p, db] of cachedDbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    try {
      cachedDbs.delete(p);
    } catch {
      /* ignore */
    }
  }
}
