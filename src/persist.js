// SQLite persistence for project memory. Uses node:sqlite so we don't
// need a native build. Schema is intentionally narrow but supports
// rich metadata, supersession, and FTS keyword recall.
//
// The same SQLite schema is used for both project and global databases;
// the only difference is the directory layout and the value stored in
// the `project_key` column. Project databases store a SHA-256 prefix of
// the canonical project root. The global database stores the literal
// string `_global`. Because IDs are derived from `(projectKey, ...)`,
// an id in one database never collides with an id in the other.
import { DatabaseSync } from 'node:sqlite';
import { promises as fs, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { nowIso, hashId, shortId, safeJsonParse } from './util.js';
import { ensureProjectDir, ingestStatePath } from './project-key.js';
import { looksLikeSecret } from './extract.js';
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  embedText,
  lastEmbeddingError,
  encodeVector,
  decodeVector,
  cosineSimilarity,
} from './embedding.js';
import { logPersistError, logEmbeddingError, logPerformanceMetric } from './diagnostics.js';

const SCHEMA_VERSION = 10;

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
    // Covering index for the vector recall branch: searchMemories
    // filters by (project_key, embedding_dim) before reading every
    // embedding BLOB. Without this index the vector scan is a full
    // table scan per recall, which dominates latency on large projects.
    const idxVec = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_project_embedding_dim'",
      )
      .get();
    if (!idxVec)
      db.exec(
        'CREATE INDEX idx_memories_project_embedding_dim ON memories(project_key, embedding_dim)',
      );
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
    // Probe: does the memories.type CHECK already include 'conclusion'?
    // The previous probe INSERT always failed because it omitted the
    // NOT NULL created_at/updated_at columns, forcing this migration to
    // rebuild on every open and leaving a vtable-construction race
    // window for memories_fts (the rebuild drops memories, so a
    // concurrent process opening the same DB sees a vtable whose
    // backing table is in flux). Read the CREATE TABLE SQL from
    // sqlite_master instead — atomic, no probe row, no rebuild on
    // already-applied DBs.
    const createSql =
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get()
        ?.sql || '';
    const hasConclusion = /type\s+IN\s*\([^)]*\bconclusion\b/i.test(createSql);
    if (!hasConclusion) {
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

  // v9: Ebbinghaus-style decay. The legacy decay scaled a single
  // confidence number by elapsed days past a 30-day grace window —
  // fine for a filing cabinet, useless for a brain analog. We add two
  // new columns to the memories table:
  //
  //   stability_days     — per-row "how long this memory survives
  //                        without rehearsal". Grows geometrically on
  //                        every access (memory_reinforce, recall hit).
  //                        Capped at 365 days.
  //   last_rehearsed_at  — last time the memory was actually used.
  //                        Distinct from last_accessed_at because
  //                        that field already tracks every read;
  //                        rehearsal is what re-stabilises the memory
  //                        for future decay.
  //
  // Order matters: ADD COLUMN must precede the UPDATE that backfills
  // the new column. ALTER TABLE ADD COLUMN with a default value
  // populates existing rows in SQLite, so the UPDATE is only needed
  // for nullable columns where we want to seed from updated_at.
  function migrateAddEbbinghausColumns(db) {
    const cols = db.prepare('PRAGMA table_info(memories)').all();
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('stability_days')) {
      db.exec('ALTER TABLE memories ADD COLUMN stability_days REAL NOT NULL DEFAULT 30');
    }
    if (!have.has('last_rehearsed_at')) {
      db.exec('ALTER TABLE memories ADD COLUMN last_rehearsed_at TEXT');
      // Backfill from updated_at for pre-migration rows. Safe because
      // the column now exists; new saves will overwrite this value.
      db.exec(
        `UPDATE memories SET last_rehearsed_at = updated_at
         WHERE last_rehearsed_at IS NULL OR last_rehearsed_at = ''`,
      );
    }
  },

  // v10: ACL / visibility model (ported from TencentDB-Agent-Memory).
  // Adds per-row visibility + shared_with grant list, plus 5 nullable
  // identity columns (team_id, agent_id, user_id, session_id, task_id)
  // used for principal-scoped reads. Also creates memories_acl as the
  // explicit grant table (memory_id × principal_kind × principal_id).
  //
  // Idempotent: every column add is gated on the `have` set check, and
  // the memories_acl table + index use IF NOT EXISTS / index-if-missing.
  // Pre-v10 rows backfill visibility='private' (from the column default)
  // and shared_with='[]' (also from the column default); no UPDATE needed.
  function migrateAddVisibilityAndSharedWith(db) {
    const cols = db.prepare('PRAGMA table_info(memories)').all();
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('visibility')) {
      db.exec(
        "ALTER TABLE memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' " +
          "CHECK (visibility IN ('private','team','restricted','agent','task'))",
      );
    }
    if (!have.has('shared_with')) {
      db.exec("ALTER TABLE memories ADD COLUMN shared_with TEXT NOT NULL DEFAULT '[]'");
    }
    if (!have.has('team_id')) db.exec('ALTER TABLE memories ADD COLUMN team_id TEXT');
    if (!have.has('agent_id')) db.exec('ALTER TABLE memories ADD COLUMN agent_id TEXT');
    if (!have.has('user_id')) db.exec('ALTER TABLE memories ADD COLUMN user_id TEXT');
    if (!have.has('session_id')) db.exec('ALTER TABLE memories ADD COLUMN session_id TEXT');
    if (!have.has('task_id')) db.exec('ALTER TABLE memories ADD COLUMN task_id TEXT');
    // memories_acl is the explicit grant table; visibility/shared_with
    // on the row are a denormalised cache of the "current" grants, kept
    // in sync by shareMemory(). UNIQUE(memory_id, principal_kind, principal_id)
    // makes grants idempotent at the SQL layer.
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories_acl (
        memory_id      TEXT NOT NULL,
        principal_kind TEXT NOT NULL CHECK (principal_kind IN ('user','team','role','agent')),
        principal_id   TEXT NOT NULL,
        granted_at     TEXT NOT NULL,
        UNIQUE(memory_id, principal_kind, principal_id)
      )
    `);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_acl_memory'",
      )
      .get();
    if (!idx) db.exec('CREATE INDEX idx_memories_acl_memory ON memories_acl(memory_id)');
  },

  // v10: Chat Memory L0→L1→L2→L3 layered model (TencentDB port).
  // Adds the `tier` column (L0/L1/L2/L3) and a nullable `persona_id`
  // tag, plus the persona_promotions audit table. tier defaults to 'L0'
  // (rawest: a fresh save is just an un-promoted memory); the hook
  // layer promotes rows through L1/L2/L3 on lifecycle events.
  //
  // Idempotent: column adds gated on `have`; persona_promotions is
  // CREATE TABLE IF NOT EXISTS with an idempotent index.
  function migrateAddTierAndPersona(db) {
    const cols = db.prepare('PRAGMA table_info(memories)').all();
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('tier')) {
      db.exec(
        "ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'L0' " +
          "CHECK (tier IN ('L0','L1','L2','L3'))",
      );
    }
    if (!have.has('persona_id')) {
      db.exec('ALTER TABLE memories ADD COLUMN persona_id TEXT');
    }
    // persona_promotions is the audit log for tier transitions.
    // setMemoryTier / promoteMemory / demoteMemory all write here so
    // a "memory_tier_history" recall can reconstruct the lineage.
    db.exec(`
      CREATE TABLE IF NOT EXISTS persona_promotions (
        id         TEXT PRIMARY KEY,
        memory_id  TEXT NOT NULL,
        from_tier  TEXT NOT NULL,
        to_tier    TEXT NOT NULL,
        reason     TEXT,
        at         TEXT NOT NULL
      )
    `);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_persona_promotions_memory'",
      )
      .get();
    if (!idx)
      db.exec('CREATE INDEX idx_persona_promotions_memory ON persona_promotions(memory_id)');
  },

  // v10: Wiki / LLM-Wiki tables (TencentDB port). Pages live alongside
  // the per-project memories table (same DB file). Pages are keyed by
  // (project_key, name) so the upsert is idempotent and re-saving the
  // same name rewrites the body in place. Edges are typed via a CHECK
  // constraint; a future-target edge (the linked page does not exist
  // yet) is recorded with to_wiki_id='pending:<name>' so the link is
  // preserved across re-saves and resolved once the target lands.
  function migrateAddWikiTables(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wiki_pages (
        wiki_id     TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        service_id  TEXT NOT NULL DEFAULT '',
        team_id     TEXT NOT NULL DEFAULT '',
        name        TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        summary     TEXT NOT NULL DEFAULT '',
        updated_at  TEXT NOT NULL,
        UNIQUE(project_key, name)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS wiki_links (
        from_wiki_id TEXT NOT NULL,
        to_wiki_id   TEXT NOT NULL,
        project_key  TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('mentions','derived_from','contradicts','supersedes')),
        weight       REAL NOT NULL DEFAULT 1.0,
        created_at   TEXT NOT NULL,
        UNIQUE(project_key, from_wiki_id, to_wiki_id, kind)
      )
    `);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
        wiki_id UNINDEXED,
        project_key UNINDEXED,
        name,
        body,
        summary,
        tokenize = 'unicode61 remove_diacritics 2'
      )
    `);
    const idxFrom = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_wiki_links_from'")
      .get();
    if (!idxFrom)
      db.exec('CREATE INDEX idx_wiki_links_from ON wiki_links(project_key, from_wiki_id)');
    const idxTo = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_wiki_links_to'")
      .get();
    if (!idxTo) db.exec('CREATE INDEX idx_wiki_links_to ON wiki_links(project_key, to_wiki_id)');
    const idxPage = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_wiki_pages_project'",
      )
      .get();
    if (!idxPage)
      db.exec('CREATE INDEX idx_wiki_pages_project ON wiki_pages(project_key, updated_at)');
  },

  // v10: CodeGraph edge kinds + memory_edges.metadata column (Phase 5).
  // Extends the memory_edges.kind CHECK to include the three codegraph
  // kinds (imports, calls, defines) and adds a `metadata TEXT` column
  // for edge payload (file path, language, byte range). Both are
  // idempotent: the CHECK rebuild uses the same probe-then-rebuild
  // pattern as the v5 conclusion migration, and the metadata column
  // add is gated on the `have` set probe.
  function migrateAddCodegraphEdges(db) {
    // Add `metadata` column to memory_edges (idempotent ALTER).
    const cols = db.prepare('PRAGMA table_info(memory_edges)').all();
    const haveCols = new Set(cols.map((c) => c.name));
    if (!haveCols.has('metadata')) {
      db.exec("ALTER TABLE memory_edges ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
    }
    // Probe via sqlite_master.sql — atomic, no throwaway row. Same
    // pattern as migrateAddConclusionType (line 152-156). The previous
    // probe-insert approach always failed (omitted created_at NOT NULL)
    // and forced a full rebuild on every open.
    const createSql =
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_edges'")
        .get()?.sql || '';
    const hasCodegraphKinds =
      /kind\s+IN\s*\([^)]*\bimports\b[^)]*\bcalls\b[^)]*\bdefines\b/i.test(createSql);
    if (!hasCodegraphKinds) {
      db.exec(`
        BEGIN;
        CREATE TABLE memory_edges_new (
          id          TEXT PRIMARY KEY,
          project_key TEXT NOT NULL,
          from_id     TEXT NOT NULL,
          to_id       TEXT NOT NULL,
          kind        TEXT NOT NULL CHECK (kind IN ('related','supports','contradicts','supersedes','synthesizes','imports','calls','defines')),
          weight      REAL NOT NULL DEFAULT 1.0,
          metadata    TEXT NOT NULL DEFAULT '{}',
          created_at  TEXT NOT NULL,
          UNIQUE(project_key, from_id, to_id, kind)
        );
        INSERT INTO memory_edges_new (id, project_key, from_id, to_id, kind, weight, metadata, created_at)
          SELECT id, project_key, from_id, to_id, kind, weight, metadata, created_at FROM memory_edges;
        DROP TABLE memory_edges;
        ALTER TABLE memory_edges_new RENAME TO memory_edges;
        CREATE INDEX idx_memory_edges_from ON memory_edges(project_key, from_id);
        CREATE INDEX idx_memory_edges_to   ON memory_edges(project_key, to_id);
        COMMIT;
      `);
    }
  },

  // v10: skill_invocations audit table (Phase 6). One row per
  // invocation of a skill; updated by recordSkillInvocation and
  // aggregated by updateSkillInvocationStats. No FK to memories so
  // soft-deleted / superseded skills can still carry their stats
  // until the next `memory_prune` sweep.
  function migrateAddSkillInvocationsTable(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_invocations (
        id          TEXT PRIMARY KEY,
        skill_id    TEXT NOT NULL,
        project_key TEXT NOT NULL,
        tool_name   TEXT,
        success     INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        invoked_at  TEXT NOT NULL
      )
    `);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_skill_invocations_skill'",
      )
      .get();
    if (!idx)
      db.exec(
        'CREATE INDEX idx_skill_invocations_skill ON skill_invocations(project_key, skill_id)',
      );
  },

  // v10: extend the memories CHECK to include 'skill' (Phase 6).
  // Same probe-then-rebuild shape as the v5 (conclusion) and v10
  // (visibility) migrations: SQLite cannot ALTER a CHECK constraint,
  // so we probe a throwaway row to detect the current shape; if the
  // probe fails, rebuild the table with the expanded vocabulary and
  // copy every row across. Re-runs are no-ops.
  function migrateAddSkillType(db) {
    // Same shape as migrateAddConclusionType: the prior probe INSERT
    // always failed (omitted NOT NULL created_at/updated_at) and forced
    // a full rebuild on every open. Inspect the CREATE TABLE SQL so
    // already-applied DBs short-circuit without rebuilding.
    const createSql =
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get()
        ?.sql || '';
    const hasSkill = /type\s+IN\s*\([^)]*\bskill\b/i.test(createSql);
    if (!hasSkill) {
      db.exec(`
        BEGIN;
        CREATE TABLE memories_new (
          id            TEXT PRIMARY KEY,
          project_key   TEXT NOT NULL,
          type          TEXT NOT NULL CHECK (type IN ('working','episodic','semantic','procedural','conclusion','skill')),
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
          last_accessed_at TEXT,
          last_embed_error TEXT,
          stability_days    REAL NOT NULL DEFAULT 30,
          last_rehearsed_at TEXT,
          visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','team','restricted','agent','task')),
          shared_with TEXT NOT NULL DEFAULT '[]',
          team_id     TEXT,
          agent_id    TEXT,
          user_id     TEXT,
          session_id  TEXT,
          task_id     TEXT,
          tier        TEXT NOT NULL DEFAULT 'L0' CHECK (tier IN ('L0','L1','L2','L3')),
          persona_id  TEXT
        );
        INSERT INTO memories_new
          SELECT id, project_key, type, title, content, tags, metadata, provenance,
                 confidence, status, priority, supersedes, superseded_by,
                 created_at, updated_at, expires_at,
                 embedding, embedding_model, embedding_dim, embedded_at,
                 access_count, last_accessed_at, last_embed_error,
                 stability_days, last_rehearsed_at,
                 visibility, shared_with, team_id, agent_id, user_id, session_id, task_id,
                 tier, persona_id
          FROM memories;
        DROP TABLE memories;
        ALTER TABLE memories_new RENAME TO memories;
        CREATE INDEX idx_memories_project_type   ON memories(project_key, type);
        CREATE INDEX idx_memories_project_status ON memories(project_key, status);
        CREATE INDEX idx_memories_expires        ON memories(expires_at);
        CREATE INDEX idx_memories_supersedes     ON memories(supersedes);
        CREATE INDEX idx_memories_embedded_at    ON memories(embedded_at);
        DELETE FROM memories_fts;
        INSERT INTO memories_fts (id, project_key, type, title, content, tags)
          SELECT id, project_key, type, title, content, tags FROM memories;
        COMMIT;
      `);
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
  kind          TEXT,                         -- 'message'|'tool_call'|'tool_result'|'thinking'|...
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
  // immediately. Increase timeout from 5s to 30s for better reliability,
  // and log long waits for observability.
  db.exec('PRAGMA busy_timeout = 30000;');
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
      } catch (err) {
        // Log but don't propagate: a close error shouldn't disrupt the caller.
        logPersistError('close_db', err, { dbPath }).catch(() => {});
      }
      cachedDbs.delete(dbPath);
    }
    return;
  }
  for (const [p, db] of cachedDbs) {
    try {
      db.close();
    } catch (err) {
      logPersistError('close_db_all', err, { dbPath: p }).catch(() => {});
    }
    try {
      cachedDbs.delete(p);
    } catch {
      /* ignore */
    }
  }
}

export function memoryId(projectKey, type, title, content) {
  return shortId(hashId(projectKey, type, title || '', content || ''), 24);
}

export function rowToMemory(row) {
  if (!row) return null;
  // shared_with is a JSON-encoded array of {kind, id} principal
  // descriptors. Safe-parse rather than throw — a corrupt row from a
  // pre-v10 DB should still load and read back as [].
  const sharedParsed = safeJsonParse(row.shared_with || '[]');
  const sharedWith = sharedParsed.ok && Array.isArray(sharedParsed.value) ? sharedParsed.value : [];
  // Each JSON column gets its own try/catch + typed fallback. A single
  // corrupt column (WAL crash mid-write, manual sqlite3 edit, partial
  // import) used to throw and crash the entire `memory_recall` result;
  // now the row degrades to empty arrays/objects and the rest of the
  // set still returns. (Audit finding B2-3.)
  const tags = safeParseJson(row.tags, [], (v) => Array.isArray(v));
  const provenance = safeParseJson(row.provenance, {}, (v) => v && typeof v === 'object' && !Array.isArray(v));
  const metadata = safeParseJson(row.metadata, {}, (v) => v && typeof v === 'object' && !Array.isArray(v));
  // Surface processing_status as a top-level field for callers that
  // don't want to dig into metadata. Defaults to 'ready' on rows that
  // pre-date the v10 processing pipeline (scaffold tests assert this).
  let processingStatus = 'ready';
  if (metadata && typeof metadata.processing_status === 'string') {
    processingStatus = metadata.processing_status;
  }
  return {
    id: row.id,
    type: row.type,
    title: row.title || '',
    content: row.content,
    tags,
    metadata,
    provenance,
    confidence: row.confidence,
    status: row.status,
    priority: row.priority,
    supersedes: row.supersedes || null,
    superseded_by: row.superseded_by || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at || null,
    processing_status: processingStatus,
    // Lightweight embedding summary — never include the raw BLOB.
    // Three states: 'embedded' (BLOB present), 'pending' (no BLOB
    // yet, no error), 'failed' (no BLOB and a recorded error).
    embedding_status: row.embedding ? 'embedded' : row.last_embed_error ? 'failed' : 'pending',
    embedding_model: row.embedding_model || null,
    last_embed_error: row.last_embed_error || null,
    access_count: row.access_count || 0,
    last_accessed_at: row.last_accessed_at || null,
    // v9 Ebbinghaus fields. Surfaced so the recall layer (and the
    // dashboard) can read the raw stability and rehearsal time without
    // re-querying. Null on pre-v9 rows that have not been touched by
    // the v9 migration yet.
    stability_days: row.stability_days == null ? null : row.stability_days,
    last_rehearsed_at: row.last_rehearsed_at || null,
    // v10 ACL / visibility fields. visibility defaults to 'private' on
    // any pre-v10 row (the column default), and shared_with defaults to
    // an empty list. team_id / agent_id / user_id / session_id / task_id
    // are nullable TEXT — only set when the row was tagged with an
    // identity at write time (e.g. by the hook layer for telemetry).
    visibility: row.visibility || 'private',
    shared_with: sharedWith,
    team_id: row.team_id || null,
    agent_id: row.agent_id || null,
    user_id: row.user_id || null,
    session_id: row.session_id || null,
    task_id: row.task_id || null,
    // v10 tier (Chat Memory L0→L1→L2→L3). Defaults to 'L0' on pre-v10
    // rows (column default). persona_id is nullable — only set when
    // the row is associated with a cross-cutting persona.
    tier: row.tier || 'L0',
    persona_id: row.persona_id || null,
  };
}

// ----- CRUD -----

// Safe JSON parse for an in-row text column. Returns `fallback` when
// the column is missing, empty, corrupt, or fails the type-guard. Used
// by rowToMemory so a single bad column can't crash `memory_recall`.
// (Audit finding B2-3.)
function safeParseJson(text, fallback, isShape) {
  if (typeof text !== 'string' || text.length === 0) return fallback;
  const parsed = safeJsonParse(text);
  if (!parsed.ok) return fallback;
  if (typeof isShape === 'function' && !isShape(parsed.value)) return fallback;
  return parsed.value;
}

// Defense in depth: refuse to persist a memory whose title or content
// matches a known credential shape. The auto-extract path already
// scrubs candidates before this point, but `memory_save` and
// `memory_update` are exposed directly to the agent — a misbehaving
// model reply, a follow-the-instructions prompt-injection, or a user
// asking the agent to "remember my API key" would otherwise land the
// secret in the durable store. The check is opt-out via
// KIMI_MEMORY_SECRET_SCAN=off for the rare case where a user genuinely
// needs to persist a secret-shaped string (e.g. an example fixture).
// False positives are accepted: dropping a candidate that mentions a
// generic "api_key" is far cheaper than persisting a real one.
function assertNoSecret(input) {
  if (process.env.KIMI_MEMORY_SECRET_SCAN === 'off') return;
  // Tags and metadata are checked too — the previous version only
  // scanned title and content, leaving a small gap for credentials
  // stashed in tag names or structured metadata.
  // (Audit finding B2-11.)
  const matched = [];
  // Title + content as flat strings.
  for (const name of ['title', 'content']) {
    if (typeof input[name] === 'string' && looksLikeSecret(input[name])) {
      matched.push(name);
    }
  }
  // Each tag value individually — the JSON-encoded array would
  // start with `["` and the existing regex's leading-char boundary
  // would miss a secret that begins at position 0 of a tag.
  if (Array.isArray(input.tags)) {
    for (const t of input.tags) {
      if (typeof t === 'string' && looksLikeSecret(t)) {
        matched.push('tags');
        break;
      }
    }
  }
  // The metadata object's string values, recursively. Stash the
  // serialised JSON as a fallback for shapes the recursion can't
  // reach (e.g. deeply nested arrays of objects).
  function scan(value, path) {
    if (typeof value === 'string') {
      if (looksLikeSecret(value)) matched.push(path);
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) scan(value[i], `${path}[${i}]`);
      return;
    }
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) scan(value[k], `${path}.${k}`);
    }
  }
  if (input.metadata && typeof input.metadata === 'object') {
    scan(input.metadata, 'metadata');
  }
  if (matched.length === 0) return;
  // De-dupe matched paths so the error message is concise.
  const unique = [...new Set(matched.map((p) => p.split(/[.\[]/)[0] === 'metadata' ? 'metadata' : p.split(/[.\[]/)[0]))];
  const where = unique.length > 1 ? unique.join(' + ') : unique[0];
  const err = new Error(
    `secret_detected: refusing to persist a memory whose ${where} matches a known credential shape. ` +
      `Remove the secret and retry, or set KIMI_MEMORY_SECRET_SCAN=off to bypass.`,
  );
  err.code = 'KIMI_MEMORY_SECRET_DETECTED';
  err.where = where;
  throw err;
}

export function saveMemory(db, projectKey, input) {
  assertNoSecret(input);
  const now = nowIso();
  const id = input.id || memoryId(projectKey, input.type, input.title || '', input.content || '');
  const tags = JSON.stringify(input.tags || []);
  // v10: fold a top-level `processing_status` into metadata so a
  // caller can mark a row as 'pending' (skill extraction in flight)
  // or 'active' without needing to wrap it under metadata. The merge
  // happens here so every existing call site that passes
  // `processing_status` directly still works.
  const baseMeta =
    input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata
      : {};
  const metadata = JSON.stringify(
    input.processing_status
      ? { ...baseMeta, processing_status: input.processing_status }
      : baseMeta,
  );
  const provenance = JSON.stringify(input.provenance || {});
  const confidence =
    typeof input.confidence === 'number' ? Math.max(0, Math.min(1, input.confidence)) : 0.8;
  const status = input.status || 'active';
  const priority = Number.isFinite(input.priority) ? Math.trunc(input.priority) : 0;
  const expires = input.expires_at || null;
  // v10 ACL / visibility fields. visibility defaults to 'private' on
  // every save so a row never accidentally becomes cross-project
  // visible. shared_with defaults to an empty list; principal identity
  // columns (team_id / agent_id / user_id / session_id / task_id) are
  // pass-through TEXT — set by the call site when the row is tagged
  // with a specific principal context (typically the hook layer).
  const visibility = VISIBILITY_VALUES.has(input.visibility) ? input.visibility : 'private';
  const sharedWith = JSON.stringify(Array.isArray(input.shared_with) ? input.shared_with : []);
  const teamId = input.team_id || null;
  const agentId = input.agent_id || null;
  const userId = input.user_id || null;
  const sessionId = input.session_id || null;
  const taskId = input.task_id || null;
  // v10 tier (Chat Memory L0→L1→L2→L3). Defaults to 'L0' so every
  // fresh save is un-promoted. tier-promotion happens via setMemoryTier
  // / promoteMemory / demoteMemory (which write the audit row to
  // persona_promotions). persona_id is pass-through.
  const tier = TIER_VALUES.has(input.tier) ? input.tier : 'L0';
  const personaId = input.persona_id || null;

  // Supersession: when supersede=true and a prior memory with the
  // same (project_key, type, title) is active, mark the prior
  // superseded and record a backlink from the new memory back to it.
  // If no prior exists, the flag is a no-op: the new memory is still
  // created as active. This is intentional — callers that want a
  // pure "replace me" should pair supersede=true with an existing
  // title they intend to replace.
  let supersedesId = input.supersedes || null;
  if (input.supersede) {
    const existing = db
      .prepare(
        "SELECT id FROM memories WHERE project_key = ? AND type = ? AND COALESCE(title,'') = ? AND status = 'active' AND id != ? ORDER BY updated_at DESC",
      )
      .all(projectKey, input.type, input.title || '', id);
    if (existing.length > 0) {
      // Link back to the most-recent prior; mark every prior superseded.
      supersedesId = existing[0].id;
      for (const ex of existing) {
        db.prepare(
          "UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE id=?",
        ).run(id, now, ex.id);
      }
      // Record a typed supersedes edge in memory_edges so the new
      // graph primitive stays the canonical source going forward.
      // Deduped via UNIQUE(project_key, from_id, to_id, kind); the
      // edge primitive is idempotent.
      try {
        db.prepare(
          `
          INSERT OR IGNORE INTO memory_edges (id, project_key, from_id, to_id, kind, weight, created_at)
          VALUES (?, ?, ?, ?, 'supersedes', 1.0, ?)
        `,
        ).run(
          shortId(hashId('edge', projectKey, ex.id, id, 'supersedes'), 16),
          projectKey,
          ex.id,
          id,
          now,
        );
      } catch {
        /* memory_edges may not exist on a pre-v4 DB; ignore */
      }
    }
  }

  const row = db.prepare('SELECT id, created_at FROM memories WHERE id=?').get(id);
  if (row) {
    db.prepare(
      `
      UPDATE memories SET
        title = COALESCE(?, title),
        content = COALESCE(?, content),
        tags = COALESCE(?, tags),
        metadata = COALESCE(?, metadata),
        provenance = COALESCE(?, provenance),
        confidence = COALESCE(?, confidence),
        status = COALESCE(?, status),
        priority = COALESCE(?, priority),
        supersedes = COALESCE(?, supersedes),
        expires_at = COALESCE(?, expires_at),
        visibility = COALESCE(?, visibility),
        shared_with = COALESCE(?, shared_with),
        team_id = COALESCE(?, team_id),
        agent_id = COALESCE(?, agent_id),
        user_id = COALESCE(?, user_id),
        session_id = COALESCE(?, session_id),
        task_id = COALESCE(?, task_id),
        tier = COALESCE(?, tier),
        persona_id = COALESCE(?, persona_id),
        updated_at = ?,
        last_rehearsed_at = ?
      WHERE id = ?
    `,
    ).run(
      input.title ?? null,
      input.content ?? null,
      input.tags !== undefined ? JSON.stringify(input.tags) : null,
      input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
      input.provenance !== undefined ? JSON.stringify(input.provenance) : null,
      input.confidence != null ? confidence : null,
      input.status ?? null,
      input.priority != null ? priority : null,
      supersedesId ?? null,
      expires,
      input.visibility ?? null,
      input.shared_with !== undefined ? JSON.stringify(input.shared_with) : null,
      input.team_id ?? null,
      input.agent_id ?? null,
      input.user_id ?? null,
      input.session_id ?? null,
      input.task_id ?? null,
      input.tier ?? null,
      input.persona_id ?? null,
      now,
      now,
      id,
    );
  } else {
    db.prepare(
      `
      INSERT INTO memories (id, project_key, type, title, content, tags, metadata, provenance, confidence, status, priority, supersedes, created_at, updated_at, expires_at, last_rehearsed_at, visibility, shared_with, team_id, agent_id, user_id, session_id, task_id, tier, persona_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      projectKey,
      input.type,
      input.title || '',
      input.content || '',
      tags,
      metadata,
      provenance,
      confidence,
      status,
      priority,
      supersedesId,
      now,
      now,
      expires,
      now,
      visibility,
      sharedWith,
      teamId,
      agentId,
      userId,
      sessionId,
      taskId,
      tier,
      personaId,
    );
  }

  // FTS upsert — wrapped in BEGIN/COMMIT with the row write above so a
  // crash or SQLITE_BUSY between the row INSERT/UPDATE and the FTS
  // write cannot leave a row visible but not FTS-indexed.
  //
  // SAVEPOINT (not BEGIN) so saveMemory is safe to call from inside
  // another transaction (e.g. saveMemoryBulk's outer BEGIN/COMMIT).
  // SAVEPOINT is a no-op when no outer transaction is in flight.
  db.exec('SAVEPOINT save_memory_upsert');
  try {
    db.prepare('DELETE FROM memories_fts WHERE id=?').run(id);
    db.prepare(
      'INSERT INTO memories_fts (id, project_key, type, title, content, tags) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      projectKey,
      input.type,
      input.title || '',
      input.content || '',
      (input.tags || []).join(' '),
    );

    // Conclusion edge: record this memory's synthesizes[] children in
    // memory_synthesizes so bidirectional lookup is a single indexed
    // query. Skip empty / duplicate / self-references. Idempotent via
    // PRIMARY KEY (parent_id, child_id); re-saving just re-stamps the
    // created_at, which is what callers usually want.
    const synth = Array.isArray(input.synthesizes) ? input.synthesizes : null;
    if (synth && synth.length > 0) {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO memory_synthesizes (parent_id, child_id, project_key, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const childId of synth) {
        if (typeof childId !== 'string' || childId === id) continue;
        try {
          stmt.run(id, childId, projectKey, now);
        } catch {
          /* child missing in same scope; ignore */
        }
      }
    }
    db.exec('RELEASE SAVEPOINT save_memory_upsert');
  } catch (e) {
    try {
      db.exec('ROLLBACK TO SAVEPOINT save_memory_upsert');
    } catch {
      /* ignore */
    }
    throw e;
  }

  const saved = getMemory(db, projectKey, id);

  // Fire-and-forget embedding update. Runs as a microtask so saveMemory
  // itself stays synchronous (existing tests and callers depend on that).
  // Failures inside the embedding module are already logged via warnOnce;
  // they never bubble up here. Pass _embed:false to skip (used by tests).
  if (input._embed !== false && process.env.KIMI_MEMORY_EMBEDDINGS !== 'off') {
    scheduleEmbeddingUpdate(db, id, saved?.title || '', saved?.content || '');
  }

  return saved;
}

// Read every conclusion that synthesizes a given memory. The argument
// is a *child* memory id; we return the parent conclusions.
export function listConclusionsFor(db, projectKey, childId, { limit = 50 } = {}) {
  const rows = db
    .prepare(
      `
    SELECT m.* FROM memories m
    JOIN memory_synthesizes s ON s.parent_id = m.id
    WHERE s.child_id = ? AND s.project_key = ?
      AND m.status = 'active'
    ORDER BY m.priority DESC, datetime(m.updated_at) DESC
    LIMIT ?
  `,
    )
    .all(childId, projectKey, Math.max(1, Math.min(200, limit)));
  return rows.map(rowToMemory);
}

// Inverse of listConclusionsFor: given a conclusion's id, return the
// underlying memories it synthesizes.
export function getParents(db, projectKey, conclusionId, { limit = 200 } = {}) {
  const rows = db
    .prepare(
      `
    SELECT m.* FROM memories m
    JOIN memory_synthesizes s ON s.child_id = m.id
    WHERE s.parent_id = ? AND s.project_key = ?
      AND m.status = 'active'
    ORDER BY m.priority DESC, datetime(m.updated_at) DESC
    LIMIT ?
  `,
    )
    .all(conclusionId, projectKey, Math.max(1, Math.min(500, limit)));
  return rows.map(rowToMemory);
}

// In-flight embedding-promise tracker. saveMemory schedules a microtask
// via scheduleEmbeddingUpdate() below; we register each one in this
// Set so closeDb() / a process.on('SIGTERM') handler can drain them
// before the SQLite handle closes. The promise resolves when the
// embedding row write completes (success or failure path) — including
// the embed_timeout case where embedText returns null. Drain logic
// uses Promise.allSettled so one rejection does not abort the others.
const inFlightEmbeddings = new Set();

function trackEmbedding(promise) {
  inFlightEmbeddings.add(promise);
  // Drop from the set as soon as it settles (success or failure).
  // No-op on rejection: the caller in scheduleEmbeddingUpdate
  // already swallows the error to keep saveMemory synchronous-fail-open.
  promise.finally(() => inFlightEmbeddings.delete(promise));
  return promise;
}

// Drain every in-flight embedding microtask. Called from closeDb() /
// process exit paths so a slow embed-write does not get truncated by
// db.close(). Bounded by a wall-clock cap so a hung encoder cannot
// hold the process open forever; the cap is generous (10 s) so a
// cold-cache model load has a chance to finish on the way out.
export async function flushEmbeddings({ timeoutMs = 10000 } = {}) {
  if (inFlightEmbeddings.size === 0) return { waited: 0 };
  const settled = inFlightEmbeddings.size;
  const drain = Promise.allSettled([...inFlightEmbeddings]);
  const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
  await Promise.race([drain, timer]);
  return { waited: settled };
}

// Async helper: compute embedding for a saved memory and write the
// embedding columns. Never throws — failures are recorded in the
// `last_embed_error` column so the row's `embedding_status` flips
// from 'pending' to 'failed' and the operator can see why.
function scheduleEmbeddingUpdate(db, id, title, content) {
  const job = Promise.resolve().then(async () => {
    let vec = null;
    let embedErr = null;
    try {
      const text = `${title || ''}\n${content || ''}`.trim().slice(0, 4000);
      if (!text) return;
      vec = await embedText(text);
    } catch (e) {
      embedErr = e && e.message ? e.message : String(e);
    }
    // Re-check the row still exists; could have been deleted between
    // save and this microtask.
    let stillThere = null;
    try {
      stillThere = db.prepare('SELECT id FROM memories WHERE id=?').get(id);
    } catch (e) {
      // The DB itself is unavailable — nothing useful we can do.
      return;
    }
    if (!stillThere) return;
    try {
      if (vec) {
        db.prepare(
          `UPDATE memories
                    SET embedding=?, embedding_model=?, embedding_dim=?, embedded_at=?,
                        last_embed_error=NULL
                    WHERE id=?`,
        ).run(encodeVector(vec), EMBEDDING_MODEL, EMBEDDING_DIM, nowIso(), id);
      } else {
        // No vector returned and no exception either: the embedding
        // module is opted out (KIMI_MEMORY_EMBEDDINGS=off), the
        // encoder timed out within its wall-clock budget, or the
        // model is unavailable. Prefer the most specific reason
        // available — `lastEmbeddingError()` carries the timeout
        // message or the real error from the import / pipe — and
        // fall back to a generic one for the cold-cache case where
        // we never reached the encoder at all.
        const reason =
          embedErr ||
          lastEmbeddingError() ||
          (process.env.KIMI_MEMORY_EMBEDDINGS === 'off'
            ? 'embeddings disabled (KIMI_MEMORY_EMBEDDINGS=off)'
            : 'embedding model unavailable');
        db.prepare(
          `UPDATE memories
                    SET last_embed_error=?, embedded_at=?
                    WHERE id=?`,
        ).run(reason, nowIso(), id);
      }
    } catch {
      /* DB write failed; nothing else we can do here */
    }
  });
  trackEmbedding(job);
}

// Increment access_count and stamp last_accessed_at for the given ids.
// Best-effort: failures (e.g. locked db) are swallowed.
function bumpAccess(db, projectKey, ids) {
  if (!ids || ids.length === 0) return;
  try {
    // One UPDATE statement per recall instead of N round-trips. The
    // previous loop issued O(N) prepared-statement runs wrapped in a
    // BEGIN/COMMIT; on a hot UserPromptSubmit loop that adds up.
    // (Audit finding B2-2.)
    const placeholders = ids.map(() => '?').join(',');
    const now = nowIso();
    db.prepare(
      `UPDATE memories
       SET access_count = access_count + 1, last_accessed_at = ?
       WHERE project_key = ? AND id IN (${placeholders})`,
    ).run(now, projectKey, ...ids);
  } catch (err) {
    // Best-effort: a failed access bump should never break the read
    // path. Log via the diagnostics pipeline so the operator can see
    // the contention pattern in `_diagnostics/hooks.log`.
    logPersistError('bump_access', err, { projectKey, count: ids.length }).catch(() => {});
  }
}

// Save N memories atomically inside one transaction. On any error
// the transaction rolls back so the database is unchanged. Useful for
// batch imports that must not partially commit.
//
// Inputs are validated in server.js before they reach this function;
// this layer trusts the shape. Supersede behaviour is identical to
// saveMemory: within a batch, earlier rows can be superseded by later
// rows that share the same (project_key, type, title).
export function saveMemoryBulk(db, projectKey, inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];

  // Enhanced error handling: collect per-item errors instead of total rollback.
  // This allows the caller to know which items failed and which succeeded.
  const results = [];
  const errors = [];

  db.exec('BEGIN');
  try {
    for (let i = 0; i < inputs.length; i++) {
      try {
        const result = saveMemory(db, projectKey, inputs[i]);
        results.push(result);
      } catch (err) {
        // Record the error but continue to process remaining items.
        // This gives visibility into which items failed without losing all progress.
        errors.push({
          index: i,
          input: inputs[i],
          error: err,
        });
        results.push(null);
      }
    }

    // If any item failed due to secret detection or other validation,
    // roll back the entire transaction for safety. Secret-related errors
    // should fail the whole batch.
    const hasSecretError = errors.some(
      (e) =>
        e.error &&
        (e.error.code === 'KIMI_MEMORY_SECRET_DETECTED' || e.error.message?.includes('secret')),
    );

    if (hasSecretError) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      // Surface the established `secret_detected:` error code in the
      // message so callers (and tests) can match the same token the
      // single-save path uses. The structured `code` field carries
      // the bulk-specific variant for finer-grained dispatch.
      const err = new Error(
        `secret_detected: refusing to persist a batch containing item(s) that match a known credential shape (bulk save failed: ${errors.length} of ${inputs.length} item(s) rejected). Remove the secret and retry.`,
      );
      err.code = 'BULK_SAVE_SECRET_DETECTED';
      err.details = {
        total: inputs.length,
        failed: errors.length,
        failed_indices: errors.map((e) => e.index),
      };
      throw err;
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }

  // Return all results, marking failures as null for introspection.
  return results;
}

export function getMemory(db, projectKey, id, { includeSuperseded = false } = {}) {
  const row = db.prepare('SELECT * FROM memories WHERE id=? AND project_key=?').get(id, projectKey);
  if (!row) return null;
  if (row.status === 'deleted') return null;
  if (row.status === 'superseded' && !includeSuperseded) return null;
  // Expiry check
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    return { ...rowToMemory(row), expired: true };
  }
  return rowToMemory(row);
}

export function listMemories(
  db,
  projectKey,
  { type, status = 'active', limit = 50, offset = 0, includeExpired = false } = {},
) {
  const where = ['project_key = ?'];
  const params = [projectKey];
  if (type) {
    where.push('type = ?');
    params.push(type);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (!includeExpired) where.push("(expires_at IS NULL OR datetime(expires_at) > datetime('now'))");
  const sql = `SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY priority DESC, datetime(updated_at) DESC LIMIT ? OFFSET ?`;
  params.push(Math.max(1, Math.min(500, limit)), Math.max(0, offset));
  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToMemory);
}

export function deleteMemory(db, projectKey, id, { hard = false } = {}) {
  if (hard) {
    db.prepare('DELETE FROM memories_fts WHERE id=?').run(id);
    const r = db.prepare('DELETE FROM memories WHERE id=? AND project_key=?').run(id, projectKey);
    return r.changes > 0;
  }
  const now = nowIso();
  const r = db
    .prepare("UPDATE memories SET status='deleted', updated_at=? WHERE id=? AND project_key=?")
    .run(now, id, projectKey);
  if (r.changes) {
    db.prepare('DELETE FROM memories_fts WHERE id=?').run(id);
  }
  return r.changes > 0;
}

// Combined-score floor below which a candidate is treated as not
// relevant. Default tuning for the RRF (Reciprocal Rank Fusion) path:
// a row that ranks first in BOTH FTS and vec scores 2/(RRF_K+1) ≈ 0.0328
// at the default RRF_K=60. A row that ranks first in only one channel
// scores 1/61 ≈ 0.0164. The threshold of 0.01 lets every rank-1 hit
// in any channel through and stops a rank-2-only row (≈0.0161) only
// when it loses both channels. Tests that need every FTS candidate
// pass minScore=0.
const MIN_RELEVANCE_SCORE = 0.01;

// RRF (Reciprocal Rank Fusion) constant. Mirrors
// TencentDB-Agent-Memory's RRF_K = 60 in core/store/search-utils.ts.
// score = Σ 1 / (RRF_K + rank_i) summed across every channel that
// ranks the candidate. A missing channel contributes 0 (we pass
// Number.POSITIVE_INFINITY so the contribution cleanly rounds to 0).
// Lower RRF_K sharpens the curve (rank-1 hits dominate more); the
// default 60 is the standard RRF textbook value.
const RRF_K = 60;

/**
 * Pure RRF combiner. Returns the RRF score for a single candidate.
 *
 * Inputs are channel ranks — 1-indexed, with `Number.POSITIVE_INFINITY`
 * (or any non-finite / sub-1 value) representing "this channel did not
 * rank the candidate". Each finite, positive rank contributes
 * 1 / (k + rank); missing channels contribute 0. The sum is the
 * combined RRF score.
 *
 * This function is exported because (a) it's useful as a unit-tested
 * pure helper and (b) the scaffold test at tests/24-rrf-scoring.test.js
 * imports it directly. Side-effect free; safe to call from any thread.
 */
export function combineRrfScores({ ftsRank, vecRank, k }) {
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error(`combineRrfScores: k must be a positive finite number, got ${k}`);
  }
  const fts = Number.isFinite(ftsRank) && ftsRank >= 1 ? 1 / (k + ftsRank) : 0;
  const vec = Number.isFinite(vecRank) && vecRank >= 1 ? 1 / (k + vecRank) : 0;
  return fts + vec;
}

export async function searchMemories(db, projectKey, query, opts = {}) {
  if (!query || !query.trim()) return [];
  const limit = Math.max(1, Math.min(200, opts.limit || 20));
  const type = opts.type || null;
  const minScore =
    Number.isFinite(opts.minScore) && opts.minScore >= 0 && opts.minScore <= 1
      ? opts.minScore
      : MIN_RELEVANCE_SCORE;
  // perType: when true, pick the top `perTypeLimit` rows from EACH
  // type that has a hit, then sort by score and take the global top
  // `limit`. Use this when you want a balanced recall (e.g. the
  // UserPromptSubmit hook, so the agent sees a mix of conventions,
  // procedures, and working notes rather than the top-N of one type).
  // The SQL-level `type` filter is ignored when perType is set — a
  // type filter plus per-type balancing is contradictory.
  const perType = !!opts.perType;
  const perTypeLimit = Math.max(1, Math.min(20, opts.perTypeLimit || 2));
  const includeScore = !!opts.includeScore;
  // Fusion strategy. Default = 'rrf' (Reciprocal Rank Fusion, the
  // TencentDB-aligned path). 'weighted' preserves the legacy 0.5/0.5
  // blend for callers that need it for one release.
  const fusion = opts.fusion === 'weighted' ? 'weighted' : 'rrf';
  const rrfK = Number.isFinite(opts.rrfK) && opts.rrfK > 0 ? opts.rrfK : RRF_K;
  // v10 visibility filter. Accepts either a single visibility string
  // (e.g. 'team') or an array (e.g. ['private', 'team']). Null / empty
  // means "no filter" — preserves the pre-v10 recall surface. The
  // filter is pushed into both the FTS and the vector branches so a
  // restricted row never appears via either channel.
  let visibilityFilter = null;
  if (typeof opts.visibility === 'string' && VISIBILITY_VALUES.has(opts.visibility)) {
    visibilityFilter = [opts.visibility];
  } else if (Array.isArray(opts.visibility)) {
    const filtered = opts.visibility.filter((v) => VISIBILITY_VALUES.has(v));
    if (filtered.length > 0) visibilityFilter = filtered;
  }
  // v10 tier filter. Accepts a single tier (e.g. 'L2') or an array.
  // Tier filtering is independent of the visibility filter — a row
  // can match both gates. Null / omitted = no tier restriction.
  let tierFilter = null;
  if (typeof opts.tier === 'string' && TIER_VALUES.has(opts.tier)) {
    tierFilter = [opts.tier];
  } else if (Array.isArray(opts.tier)) {
    const filtered = opts.tier.filter((v) => TIER_VALUES.has(v));
    if (filtered.length > 0) tierFilter = filtered;
  }
  // v10 per-tier recall budgets. Mirrors TencentDB's
  // `recall.maxResults` + per-tier shaping: a {L0:2, L1:1, L2:1} map
  // caps each tier independently during selection. When omitted,
  // no per-tier shaping is applied.
  const tierBudgets =
    opts.tierBudgets && typeof opts.tierBudgets === 'object' ? opts.tierBudgets : null;
  // v10 recall budgets. maxCharsPerMemory truncates an individual row's
  // content body in the returned payload; maxTotalRecallChars drops
  // rows from the tail once the cumulative sum exceeds the limit.
  const maxCharsPerMemory =
    Number.isFinite(opts.maxCharsPerMemory) && opts.maxCharsPerMemory > 0
      ? Math.floor(opts.maxCharsPerMemory)
      : 0;
  const maxTotalRecallChars =
    Number.isFinite(opts.maxTotalRecallChars) && opts.maxTotalRecallChars > 0
      ? Math.floor(opts.maxTotalRecallChars)
      : 0;

  // ---- 1. FTS5 candidates ----
  // When perType is on we want every type's hits, so we suppress the
  // SQL-level type filter and bucket in memory below.
  const ftsType = perType ? null : type;
  const tokens = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 16);
  const ftsRows = [];
  if (tokens.length > 0) {
    const fts = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
    const params = [fts, projectKey];
    let typeClause = '';
    if (ftsType) {
      typeClause = ' AND m.type = ?';
      params.push(ftsType);
    }
    let visibilityClause = '';
    if (visibilityFilter) {
      visibilityClause = ` AND m.visibility IN (${visibilityFilter.map(() => '?').join(',')})`;
      params.push(...visibilityFilter);
    }
    let tierClause = '';
    if (tierFilter) {
      tierClause = ` AND m.tier IN (${tierFilter.map(() => '?').join(',')})`;
      params.push(...tierFilter);
    }
    // Cast a wide net for perType: pull up to `limit * 5` rows so
    // every type has a chance to be represented.
    params.push(perType ? Math.max(limit * 5, 100) : limit);
    ftsRows.push(
      ...db
        .prepare(
          `
      SELECT m.* FROM memories_fts f
      JOIN memories m ON m.id = f.id
      WHERE memories_fts MATCH ?
        AND m.project_key = ?
        AND m.status = 'active'
        AND (m.expires_at IS NULL OR datetime(m.expires_at) > datetime('now'))${typeClause}${visibilityClause}${tierClause}
      ORDER BY rank, m.priority DESC
      LIMIT ?
    `,
        )
        .all(...params),
    );
  }

  // ---- 2. Vector candidates (best-effort, fail-open) ----
  // Compute the query embedding once, then cosine-similarity against
  // every active memory in this project that has an embedding of the
  // expected dimension. Embedding module never throws; null = skip.
  const qVec = await embedText(query);
  const vecScores = new Map();
  if (qVec && qVec.length === EMBEDDING_DIM) {
    const where = [
      'project_key = ?',
      "status = 'active'",
      "(expires_at IS NULL OR datetime(expires_at) > datetime('now'))",
      'embedding IS NOT NULL',
      'embedding_dim = ?',
    ];
    const params = [projectKey, EMBEDDING_DIM];
    if (!perType && type) {
      where.push('type = ?');
      params.push(type);
    }
    if (visibilityFilter) {
      where.push(`visibility IN (${visibilityFilter.map(() => '?').join(',')})`);
      params.push(...visibilityFilter);
    }
    if (tierFilter) {
      where.push(`tier IN (${tierFilter.map(() => '?').join(',')})`);
      params.push(...tierFilter);
    }
    const rows = db
      .prepare(`SELECT id, embedding FROM memories WHERE ${where.join(' AND ')}`)
      .all(...params);
    for (const r of rows) {
      const v = decodeVector(r.embedding);
      if (!v || v.length !== EMBEDDING_DIM) continue;
      vecScores.set(r.id, cosineSimilarity(qVec, v));
    }
  }

  // ---- 3. Combine ----
  // Each channel produces a ranked list. We turn each into a
  // {id → rank} map, then run combineRrfScores() over both ranks per
  // candidate. The legacy 'weighted' fusion path (0.5/0.5 blend) is
  // preserved for callers that opt in via `fusion: 'weighted'`; the
  // default is RRF.
  const ftsRank = new Map();
  ftsRows.forEach((row, idx) => ftsRank.set(row.id, idx + 1));
  // vecScores is a Map<id, similarity>. Re-rank by similarity desc to
  // produce vecRank = 1..N. Rows tied on similarity share the lower
  // rank (the first tie wins).
  const vecRank = new Map();
  if (vecScores.size > 0) {
    const sortedVec = [...vecScores.entries()].sort((a, b) => b[1] - a[1]);
    sortedVec.forEach(([id], idx) => vecRank.set(id, idx + 1));
  }
  // Build the union of candidates from both channels. Rows in
  // vecScores but not ftsRows need to be fetched so rowToMemory can
  // surface the full row.
  const merged = new Map();
  for (const row of ftsRows)
    merged.set(row.id, { row, ftsRank: ftsRank.get(row.id), vecRank: Number.POSITIVE_INFINITY });
  if (vecScores.size > 0) {
    const missing = [...vecRank.keys()].filter((id) => !merged.has(id));
    let fetched = new Map();
    if (missing.length > 0) {
      const placeholders = missing.map(() => '?').join(',');
      const fetchedRows = db
        .prepare(`SELECT * FROM memories WHERE project_key=? AND id IN (${placeholders})`)
        .all(projectKey, ...missing);
      fetched = new Map(fetchedRows.map((r) => [r.id, r]));
    }
    for (const [id, rank] of vecRank) {
      const row = merged.get(id)?.row || fetched.get(id);
      if (!row) continue;
      const e = merged.get(id) || {
        row,
        ftsRank: Number.POSITIVE_INFINITY,
        vecRank: Number.POSITIVE_INFINITY,
      };
      e.vecRank = rank;
      merged.set(id, e);
    }
  }

  // ---- 4. Score + relevance filter ----
  // For RRF, score = combineRrfScores(ftsRank, vecRank). For the legacy
  // weighted blend, score = 0.5*ftsScore + 0.5*vecScore. Drop anything
  // below the relevance threshold so a fuzzy FTS hit with no semantic
  // similarity (or vice-versa) does not pollute the recall. Pass
  // minScore=0 to keep every candidate (used by tests).
  // Per-channel score helpers shared by both fusion paths so the
  // includeScore surface always carries fts_score + vec_score (the test
  // at tests/13-recall-per-type.test.js:127 asserts both are numbers).
  // A row that did NOT match a channel gets a 0 score for that channel.
  const ftsScoreOf = (r) => (Number.isFinite(r) && r >= 1 ? 1 / r : 0);
  const vecScoreOf = (rowId) => {
    const sim = vecScores.get(rowId);
    return Number.isFinite(sim) ? Math.max(0, Math.min(1, sim)) : 0;
  };
  let scored;
  if (fusion === 'rrf') {
    // Surface the rank-decayed per-channel scores alongside the RRF
    // combined score so callers (tests, the agent's [recall] renderer)
    // can verify per-channel attribution. A row that did NOT match a
    // channel gets a 0 score for that channel — the natural RRF "missing
    // channel contributes 0" semantics carry through.
    scored = [...merged.values()].map(({ row, ftsRank, vecRank }) => ({
      row,
      fts_rank: ftsRank,
      vec_rank: vecRank,
      fts_score: ftsScoreOf(ftsRank),
      vec_score: vecScoreOf(row.id),
      rrf_score: combineRrfScores({ ftsRank, vecRank, k: rrfK }),
      score: combineRrfScores({ ftsRank, vecRank, k: rrfK }),
    }));
  } else {
    // Weighted fusion: build pseudo-scores from ranks so the per-channel
    // info is still surfaced when includeScore is true. The rank-decay
    // matches the legacy 1/(idx+1) shape.
    scored = [...merged.values()].map(({ row, ftsRank, vecRank }) => {
      const ftsScore = ftsScoreOf(ftsRank);
      const vecScore = vecScoreOf(row.id);
      return {
        row,
        fts_rank: ftsRank,
        vec_rank: vecRank,
        fts_score: ftsScore,
        vec_score: vecScore,
        score: 0.5 * ftsScore + 0.5 * vecScore,
      };
    });
  }
  if (minScore > 0) scored = scored.filter((e) => e.score >= minScore);

  // ---- 5. Selection ----
  let picked;
  if (perType) {
    // Bucket by type, take top perTypeLimit per type, then re-sort
    // by score and trim to the global `limit`. Guarantees the agent
    // sees at least one row from every type that has a hit.
    const byType = new Map();
    for (const e of scored) {
      const t = e.row.type;
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(e);
    }
    picked = [];
    for (const items of byType.values()) {
      items.sort((a, b) => b.score - a.score);
      picked.push(...items.slice(0, perTypeLimit));
    }
    picked.sort((a, b) => b.score - a.score);
    picked = picked.slice(0, limit);
  } else {
    scored.sort((a, b) => b.score - a.score);
    picked = scored.slice(0, limit);
  }

  // v10 per-tier recall budgets. When set, cap each tier independently
  // from the picked list. This runs after perType/global selection so
  // the budgets can down-select a balanced recall to fit the agent's
  // context. Tiers not in the budget map are uncapped.
  if (tierBudgets) {
    const byTier = new Map();
    const remaining = [];
    for (const e of picked) {
      const tier = e.row.tier || 'L0';
      const cap = tierBudgets[tier];
      if (Number.isFinite(cap) && cap >= 0) {
        if (!byTier.has(tier)) byTier.set(tier, []);
        const bucket = byTier.get(tier);
        if (bucket.length < cap) {
          bucket.push(e);
        }
        // Else drop — budget for this tier is full.
      } else {
        remaining.push(e);
      }
    }
    picked = [...remaining, ...[].concat(...byTier.values())].sort((a, b) => b.score - a.score);
  }

  const out = picked.map(({ row, score, fts_rank, vec_rank, rrf_score, fts_score, vec_score }) => {
    const mem = rowToMemory(row);
    if (includeScore) {
      mem.score = score;
      // Always surface ranks and per-channel scores when includeScore
      // is on — including 0 for the channel a row did NOT match.
      // Tests assert `typeof r[0].fts_score === 'number'` and the same
      // for vec_score (tests/13-recall-per-type.test.js:127-128), so a
      // missing channel must be a numeric 0, not `undefined`.
      mem.fts_rank = fts_rank;
      mem.vec_rank = vec_rank;
      if (rrf_score !== undefined) mem.rrf_score = rrf_score;
      mem.fts_score = fts_score || 0;
      mem.vec_score = vec_score || 0;
    }
    return mem;
  });

  // v10 per-row character truncation. maxCharsPerMemory cuts the
  // individual row's content + snippet to the budget; the prefix is
  // preserved verbatim and a "…(truncated)" suffix is appended so the
  // agent can see the cut. Suffix is in code points (surrogate-pair
  // safe) to mirror TencentDB's MIN_TRUNCATED_RECALL_LINE_CHARS =
  // 40 floor on a meaningful truncation length.
  if (maxCharsPerMemory > 0) {
    const TRUNC_SUFFIX = '…(truncated)';
    for (const m of out) {
      if (typeof m.content === 'string' && m.content.length > maxCharsPerMemory) {
        // Slice on a code-point boundary.
        let cut = maxCharsPerMemory;
        while (cut > 0 && (m.content.charCodeAt(cut - 1) & 0xfc00) === 0xdc00) cut -= 1;
        m.content = m.content.slice(0, cut) + TRUNC_SUFFIX;
      }
    }
  }

  // v10 cumulative character cap. Drop tail rows once the running sum
  // of content lengths exceeds maxTotalRecallChars. Keeps the
  // highest-scoring rows the agent can actually fit into context.
  let finalOut = out;
  if (maxTotalRecallChars > 0) {
    let used = 0;
    finalOut = [];
    for (const m of out) {
      const len = typeof m.content === 'string' ? m.content.length : 0;
      if (used + len > maxTotalRecallChars && finalOut.length > 0) break;
      used += len;
      finalOut.push(m);
    }
  }

  // ---- 6. Best-effort access bump on the top results ----
  bumpAccess(
    db,
    projectKey,
    finalOut.map((m) => m.id),
  );

  return finalOut;
}

// Find memories semantically similar to a given memory id (cosine
// over stored embeddings). Returns [] if the target has no embedding
// (e.g. legacy row, embedding model unavailable).
export async function similarMemories(db, projectKey, id, { limit = 10, threshold = 0.6 } = {}) {
  const target = db
    .prepare('SELECT id, embedding, embedding_dim FROM memories WHERE id=? AND project_key=?')
    .get(id, projectKey);
  if (!target || !target.embedding) return [];
  const tVec = decodeVector(target.embedding);
  if (!tVec || tVec.length !== EMBEDDING_DIM) return [];

  const where = [
    'project_key = ?',
    'id != ?',
    "status = 'active'",
    "(expires_at IS NULL OR datetime(expires_at) > datetime('now'))",
    'embedding IS NOT NULL',
    'embedding_dim = ?',
  ];
  const params = [projectKey, id, EMBEDDING_DIM];
  const rows = db.prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')}`).all(...params);

  const scored = [];
  for (const row of rows) {
    const v = decodeVector(row.embedding);
    if (!v || v.length !== EMBEDDING_DIM) continue;
    const sim = cosineSimilarity(tVec, v);
    if (sim >= threshold) scored.push({ row, sim });
  }
  scored.sort((a, b) => b.sim - a.sim);
  const top = scored.slice(0, Math.max(1, Math.min(50, limit)));

  if (top.length > 0) {
    bumpAccess(
      db,
      projectKey,
      top.map((s) => s.row.id),
    );
  }

  return top.map(({ row, sim }) => ({
    ...rowToMemory(row),
    similarity: sim,
  }));
}

// Backfill embeddings for rows that don't have one yet. Idempotent:
// safe to re-run. Returns counts. Used by `npm run backfill-embeddings`
// and exposed to the dashboard.
export async function backfillEmbeddings(db, projectKey, { batchSize = 50, force = false } = {}) {
  const where = ['project_key = ?', "status = 'active'"];
  const params = [projectKey];
  if (!force) where.push('embedding IS NULL');
  const rows = db
    .prepare(
      `SELECT id, title, content FROM memories WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`,
    )
    .all(...params);

  let embedded = 0,
    skipped = 0,
    failed = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    for (const r of batch) {
      try {
        const text = `${r.title || ''}\n${r.content || ''}`.trim().slice(0, 4000);
        const vec = await embedText(text);
        if (!vec) {
          skipped++;
          continue;
        }
        db.prepare(
          `UPDATE memories
                      SET embedding=?, embedding_model=?, embedding_dim=?, embedded_at=?
                      WHERE id=?`,
        ).run(encodeVector(vec), EMBEDDING_MODEL, EMBEDDING_DIM, nowIso(), r.id);
        embedded++;
      } catch {
        failed++;
      }
    }
  }
  return { scanned: rows.length, embedded, skipped, failed };
}

// Re-export the CodeGraph helpers (Phase 5). Implementation lives in
// src/codegraph.js; re-exporting here so the scaffold test at
// tests/26-codegraph.test.js can keep its existing
// `import { extractSymbolsFromText, … } from '../src/persist.js'`
// contract.
export {
  extractSymbolsFromText,
  extractCodeGraph,
  buildCodeGraphEdges,
  queryMemoryGraph,
} from './codegraph.js';

// ----- Importance + decay (signal-driven reinforcement) -----

// Single-row bump for "this memory helped". On top of the legacy
// +0.05 confidence nudge, this v9 update grows the row's stability
// (so the next decay pass demotes it more slowly) and stamps
// last_rehearsed_at (so the Ebbinghaus timer resets). The growth
// factor lives in src/decay.js so the formula has a single home.
import { derivedConfidence, growStability } from './decay.js';

const REINFORCE_DELTA = 0.05;

export function reinforceMemory(db, projectKey, id) {
  const now = nowIso();
  const row = db
    .prepare(
      "SELECT id, confidence, stability_days FROM memories WHERE id=? AND project_key=? AND status='active'",
    )
    .get(id, projectKey);
  if (!row) return null;
  const next = Math.min(1, Math.max(0, (row.confidence || 0) + REINFORCE_DELTA));
  const prevStab =
    row.stability_days == null || !Number.isFinite(row.stability_days) ? null : row.stability_days;
  const newStab = growStability(prevStab);
  db.prepare(
    `
    UPDATE memories
    SET access_count = access_count + 1,
        last_accessed_at = ?,
        last_rehearsed_at = ?,
        confidence = ?,
        stability_days = ?
    WHERE id = ? AND project_key = ?
  `,
  ).run(now, now, next, newStab, id, projectKey);
  return getMemory(db, projectKey, id);
}

// Debounced auto-reinforce for the hook layer. Same bump as
// `reinforceMemory`, but only fires if the row hasn't been rehearsed
// in the last `debounceMs` (default 60s). Avoids hammering the DB
// when a user re-types the same prompt or the same recall hit repeats.
//
// Returns the reinforced row, or null when the row is missing /
// soft-deleted. When the debounce trips, returns the current row
// (status quo) so the caller can log a no-op uniformly.
const REINFORCE_DEBOUNCE_MS = 60_000;

export function reinforceIfStale(db, projectKey, id, { debounceMs = REINFORCE_DEBOUNCE_MS } = {}) {
  const row = db
    .prepare(
      "SELECT id, last_rehearsed_at FROM memories WHERE id=? AND project_key=? AND status='active'",
    )
    .get(id, projectKey);
  if (!row) return null;
  const last = row.last_rehearsed_at ? Date.parse(row.last_rehearsed_at) : 0;
  if (Number.isFinite(last) && Date.now() - last < debounceMs) {
    return getMemory(db, projectKey, id);
  }
  return reinforceMemory(db, projectKey, id);
}

// SessionStart pass: walks every active memory and rewrites
// `confidence` from the Ebbinghaus retrievability curve based on
// (stability_days, last_rehearsed_at, now). Replaces the legacy
// `decayMemories` linear scaling — same hook call site, different
// formula.
//
// Idempotent: re-running on already-fresh rows is a no-op
// (retrievability 1.0 → confidence ~1.0 → unchanged). Floor of 0.1
// matches the legacy DECAY_FLOOR so a cold memory never fully "dies".
//
// We do this in JS rather than SQL because the formula uses Math.exp
// and per-row stability — the per-row branch is what makes the model
// brain-like (every rehearsal changes the curve).
export function decayMemories(db, projectKey, { now = new Date() } = {}) {
  let scanned = 0;
  let rewritten = 0;
  let errors = 0;
  // Pull every active row in one query, walk it in JS, write back the
  // updated confidence in a single transaction. The hook is fail-open
  // so any timeout or error here is logged and skipped.
  const rows = db
    .prepare(
      `SELECT id, confidence, stability_days, last_rehearsed_at
       FROM memories
       WHERE project_key = ? AND status = 'active'
         AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`,
    )
    .all(projectKey);
  scanned = rows.length;
  if (rows.length === 0) return { scanned, rewritten, errors };
  const stmt = db.prepare(`UPDATE memories SET confidence = ? WHERE id = ? AND project_key = ?`);
  try {
    db.exec('BEGIN');
    for (const r of rows) {
      try {
        const target = derivedConfidence(r.stability_days, r.last_rehearsed_at, now);
        // Only write when the change is meaningful (≥0.01 absolute).
        // Avoids burning WAL on rows that are already at the curve.
        if (Math.abs((r.confidence || 0) - target) >= 0.01) {
          stmt.run(target, r.id, projectKey);
          rewritten += 1;
        }
      } catch {
        errors += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    return {
      scanned,
      rewritten,
      errors: errors + 1,
      error: e && e.message ? e.message : String(e),
    };
  }
  return { scanned, rewritten, errors };
}

// Allowed kinds for memory_edges. Stable, versioned vocabulary — the
// dashboard and any external consumers key off these strings. The
// three CodeGraph kinds (`imports`, `calls`, `defines`) were added in
// Phase 5; the v10 + Phase 5 migration rebuilds the CHECK constraint
// to include them.
const EDGE_KINDS = new Set([
  'related',
  'supports',
  'contradicts',
  'supersedes',
  'synthesizes',
  'imports',
  'calls',
  'defines',
]);

export function validEdgeKinds() {
  return [...EDGE_KINDS];
}

// v10 ACL / visibility vocabulary. Five visibility levels mirroring
// TencentDB-Agent-Memory's `AssetVisibility` enum (private, team,
// restricted, agent, task). saveMemory falls back to 'private' when
// the input is missing or out-of-vocabulary, so a save never produces
// a row that bypasses the principal gate.
const VISIBILITY_VALUES = new Set(['private', 'team', 'restricted', 'agent', 'task']);

export function validVisibilityLevels() {
  return [...VISIBILITY_VALUES];
}

// Shared DB location + accessor. The cross-project shared pool lives
// at <kimiHome>/kimi-memory/_shared/memory.sqlite with the literal
// project_key '_shared' so per-project queries never accidentally hit
// it. The path is sibling to globalDataDir — both underscore-prefixed
// names live at the top level of the data root.
export const SHARED_DIR_NAME = '_shared';
export const SHARED_PROJECT_KEY = '_shared';

export function sharedDataDir(kimiHomeDir) {
  return path.join(kimiHomeDir, 'kimi-memory', SHARED_DIR_NAME);
}

export function sharedDbPath(kimiHomeDir) {
  return path.join(sharedDataDir(kimiHomeDir), 'memory.sqlite');
}

// openSharedDb is a thin wrapper around openDb(sharedDbPath(...)) that
// returns the cached handle on subsequent calls. openDb itself caches
// by dbPath, so the handle is shared across calls — the tests at
// tests/29-visibility-acl.test.js rely on identity equality.
export function openSharedDb(kimiHomeDir) {
  return openDb(sharedDbPath(kimiHomeDir));
}

// v10 tier model (Chat Memory L0→L1→L2→L3). The four levels mirror
// TencentDB-Agent-Memory's distillation pipeline:
//   L0 — raw save (a memory just landed; no promotion yet)
//   L1 — Stop-hook auto-extract promoted it to working state
//   L2 — access pattern promoted it to durable state
//   L3 — explicitly promoted by the agent or operator (curated)
// Every new save lands at L0; promote / demote move it along the
// chain with an audit row in persona_promotions.
const TIER_VALUES = new Set(['L0', 'L1', 'L2', 'L3']);

export function validTiers() {
  return [...TIER_VALUES];
}

export function isValidTier(v) {
  return TIER_VALUES.has(v);
}

// Promote one or more memories to a new visibility level. Two modes:
//
//   toSharedPool: false (default)
//     Update the row in-place. The memory stays in its project DB but
//     `visibility` and `shared_with` change so the read paths can see
//     it through the new ACL gate. `sharedWith` is a JSON-encoded list
//     of principal descriptors (e.g. ['user:alice','role:editor']).
//
//   toSharedPool: true
//     Move the row out of the project DB into the cross-project shared
//     DB at _shared/memory.sqlite with project_key='_shared'. The row
//     keeps the same id so callers holding the id don't break. FTS5
//     rows are re-created on the target DB and dropped on the source.
//
// Returns { moved, updated }. `moved` is the count of rows physically
// relocated (toSharedPool=true path). `updated` is the count of rows
// whose visibility was rewritten in place. They sum to the number of
// ids the call acted on; ids that did not exist in `projectKey` are
// silently skipped (idempotent — re-running with the same ids is a
// no-op). Throws on an invalid visibility level; the caller is
// expected to validate input before invoking.
export function shareMemory(db, projectKey, ids, opts = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return { moved: 0, updated: 0 };
  const visibility = opts.visibility;
  if (!VISIBILITY_VALUES.has(visibility)) {
    throw new Error(`invalid visibility: ${visibility}`);
  }
  const sharedWith = Array.isArray(opts.sharedWith) ? opts.sharedWith : [];
  const toSharedPool = !!opts.toSharedPool;
  const kimiHomeDir = opts.kimiHomeDir;

  if (toSharedPool) {
    if (!kimiHomeDir) {
      throw new Error('shareMemory: toSharedPool=true requires kimiHomeDir');
    }
    // Defence-in-depth: refuse to promote a row whose title or content
    // matches a known credential shape. The save-side `assertNoSecret`
    // already blocks the original write, but a row could have been
    // saved under an older scanner revision, or the operator may have
    // imported via the legacy bulk path. Re-checking here keeps the
    // README's "the check is enforced at the lowest layer" claim true
    // for the cross-DB promotion path too.
    const idSet = new Set(ids);
    const candidates = db
      .prepare(
        `SELECT id, title, content FROM memories WHERE project_key = ? AND id IN (${[...idSet]
          .map(() => '?')
          .join(',')})`,
      )
      .all(projectKey, ...idSet);
    for (const r of candidates) {
      if (looksLikeSecret(r.title || '') || looksLikeSecret(r.content || '')) {
        const err = new Error(
          `secret_detected: refusing to share memory ${r.id} — title or content matches a known credential shape. Remove the secret and retry, or set KIMI_MEMORY_SECRET_SCAN=off to bypass.`,
        );
        err.code = 'KIMI_MEMORY_SECRET_DETECTED';
        throw err;
      }
    }

    const sharedDb = openSharedDb(kimiHomeDir);
    // We move rows one at a time inside a single transaction on the
    // source DB. The shared DB's writes piggy-back on the same call
    // site; node:sqlite uses a single connection per dbPath so the
    // target handle is on its own connection and does not need its own
    // transaction wrapper for atomicity from the caller's view.
    const now = nowIso();
    let moved = 0;
    db.exec('BEGIN');
    try {
      for (const id of ids) {
        const row = db
          .prepare('SELECT * FROM memories WHERE id=? AND project_key=?')
          .get(id, projectKey);
        if (!row) continue;
        // Insert into shared DB with project_key='_shared', preserving
        // every column the schema knows about. Idempotent via the row
        // PRIMARY KEY (id); if a row with the same id is already in
        // the shared DB we leave it and still remove from the source
        // so the caller observes a "move" — the target stays at the
        // version it already had, which is the safer failure mode.
        try {
          sharedDb
            .prepare(
              `INSERT OR IGNORE INTO memories (
                id, project_key, type, title, content, tags, metadata, provenance,
                confidence, status, priority, supersedes, superseded_by,
                created_at, updated_at, expires_at,
                embedding, embedding_model, embedding_dim, embedded_at,
                access_count, last_accessed_at,
                stability_days, last_rehearsed_at,
                last_embed_error,
                visibility, shared_with,
                team_id, agent_id, user_id, session_id, task_id,
                tier, persona_id
              ) VALUES (?, '_shared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              row.id,
              row.type,
              row.title,
              row.content,
              row.tags,
              row.metadata,
              row.provenance,
              row.confidence,
              row.status,
              row.priority,
              row.supersedes,
              row.superseded_by,
              row.created_at,
              now,
              row.expires_at,
              row.embedding,
              row.embedding_model,
              row.embedding_dim,
              row.embedded_at,
              row.access_count,
              row.last_accessed_at,
              row.stability_days,
              row.last_rehearsed_at,
              row.last_embed_error,
              visibility,
              JSON.stringify(sharedWith),
              row.team_id,
              row.agent_id,
              row.user_id,
              row.session_id,
              row.task_id,
              row.tier,
              row.persona_id,
            );
        } catch (e) {
          // Surface as a per-id error so the caller can decide; the
          // shared DB write should not silently disappear.
          throw new Error(
            `shareMemory: failed to insert into shared DB for ${id}: ${e && e.message}`,
          );
        }
        // Re-stamp FTS in the shared DB so the move is visible to
        // recall. memories_fts mirrors memories 1:1 by id.
        sharedDb.prepare('DELETE FROM memories_fts WHERE id=?').run(id);
        sharedDb
          .prepare(
            'INSERT INTO memories_fts (id, project_key, type, title, content, tags) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(id, '_shared', row.type, row.title || '', row.content || '', row.tags || '[]');
        // Remove from the source DB (memories + FTS). The source
        // DELETE is the point of the move — keep the shared row even
        // if the FTS delete errors, since the row itself is the
        // primary deliverable.
        db.prepare('DELETE FROM memories WHERE id=? AND project_key=?').run(id, projectKey);
        db.prepare('DELETE FROM memories_fts WHERE id=?').run(id);
        moved += 1;
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
    return { moved, updated: 0 };
  }

  // In-place update path: rewrite visibility + shared_with on every id
  // that exists in the source DB. Ids that don't exist are skipped
  // silently so the call is idempotent (re-running with the same ids
  // is a no-op).
  const now = nowIso();
  let updated = 0;
  const stmt = db.prepare(
    `UPDATE memories SET visibility = ?, shared_with = ?, updated_at = ?
     WHERE id = ? AND project_key = ?`,
  );
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      const r = stmt.run(visibility, JSON.stringify(sharedWith), now, id, projectKey);
      if (r.changes > 0) updated += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
  return { moved: 0, updated };
}

// v10: tier (Chat Memory L0→L1→L2→L3) management. Every transition
// writes a row to persona_promotions so memory_tier_history can
// reconstruct the lineage. promote/demote compute the next tier from
// the current one (L0→L1→L2→L3 in either direction); setMemoryTier is
// the explicit override.
//
// All three return { memory, transition } where transition is the
// audit row, or { memory: null } when the memory is missing / soft-
// deleted. Throws on invalid tier input; the caller is expected to
// validate before invoking.

function recordPromotion(db, memoryId, fromTier, toTier, reason) {
  // Mix ms + ns + a random int into the id stamp so two transitions
  // in the same second produce different ids. Same pattern as
  // recordSkillInvocation. INSERT OR IGNORE keeps the PRIMARY KEY
  // safety net for the rare ms-collision case.
  // (Audit finding B2-6.)
  const stamp = `${nowIso()}:${Date.now() % 1e9}:${Math.floor(Math.random() * 1e9)}`;
  const id = shortId(hashId('promo', memoryId, fromTier, toTier, reason || '', stamp), 16);
  db.prepare(
    `INSERT OR IGNORE INTO persona_promotions (id, memory_id, from_tier, to_tier, reason, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, memoryId, fromTier, toTier, reason || null, nowIso());
  return {
    id,
    memory_id: memoryId,
    from_tier: fromTier,
    to_tier: toTier,
    reason: reason || null,
    at: nowIso(),
  };
}

export function setMemoryTier(db, projectKey, memoryId, targetTier, { reason } = {}) {
  if (!TIER_VALUES.has(targetTier)) {
    throw new Error(`invalid tier: ${targetTier}`);
  }
  const row = db
    .prepare("SELECT id, tier FROM memories WHERE id=? AND project_key=? AND status='active'")
    .get(memoryId, projectKey);
  if (!row) return { memory: null, transition: null };
  if (row.tier === targetTier) {
    return {
      memory: getMemory(db, projectKey, memoryId),
      transition: null,
    };
  }
  db.prepare(`UPDATE memories SET tier = ?, updated_at = ? WHERE id = ? AND project_key = ?`).run(
    targetTier,
    nowIso(),
    memoryId,
    projectKey,
  );
  const transition = recordPromotion(db, memoryId, row.tier, targetTier, reason);
  return {
    memory: getMemory(db, projectKey, memoryId),
    transition,
  };
}

// Promote one tier up (capped at L3). Returns { memory, transition }.
export function promoteMemory(db, projectKey, memoryId, { reason } = {}) {
  const row = db
    .prepare("SELECT tier FROM memories WHERE id=? AND project_key=? AND status='active'")
    .get(memoryId, projectKey);
  if (!row) return { memory: null, transition: null };
  const order = ['L0', 'L1', 'L2', 'L3'];
  const idx = order.indexOf(row.tier);
  if (idx < 0 || idx === order.length - 1) {
    return {
      memory: getMemory(db, projectKey, memoryId),
      transition: null,
    };
  }
  return setMemoryTier(db, projectKey, memoryId, order[idx + 1], { reason });
}

// Demote one tier down (floor at L0). Returns { memory, transition }.
export function demoteMemory(db, projectKey, memoryId, { reason } = {}) {
  const row = db
    .prepare("SELECT tier FROM memories WHERE id=? AND project_key=? AND status='active'")
    .get(memoryId, projectKey);
  if (!row) return { memory: null, transition: null };
  const order = ['L0', 'L1', 'L2', 'L3'];
  const idx = order.indexOf(row.tier);
  if (idx <= 0) {
    return {
      memory: getMemory(db, projectKey, memoryId),
      transition: null,
    };
  }
  return setMemoryTier(db, projectKey, memoryId, order[idx - 1], { reason });
}

// Return the audit log of tier transitions for a memory, oldest-first.
export function listTierHistory(db, projectKey, memoryId, { limit = 200 } = {}) {
  const rows = db
    .prepare(
      `SELECT id, memory_id, from_tier, to_tier, reason, at
       FROM persona_promotions
       WHERE memory_id = ?
       ORDER BY datetime(at) ASC, id ASC
       LIMIT ?`,
    )
    .all(memoryId, Math.max(1, Math.min(500, limit)));
  return rows;
}

// ----- v10 Skill assets (Phase 6) -----
//
// Skills are memories with type='skill' that carry a structured trigger
// surface in metadata.trigger ({commands, paths, keywords}). The hook
// layer calls matchSkillTriggers on every UserPromptSubmit so a stored
// skill can surface as a one-line hint alongside the recall lines.
// Invocations are recorded in skill_invocations for stats / ranking.

/**
 * Score every active skill against an arbitrary (command?, file_path?,
 * ...arbitrary) tool-call args shape. Each skill carries a trigger
 * object with at most three arrays: `commands` (substring match on the
 * `command` field), `paths` (suffix/segment match on the `file_path`
 * field), and `keywords` (substring match on any other string value).
 *
 * Returns the top `limit` matches by score, descending. Empty trigger
 * objects produce no match.
 */
export function matchSkillTriggers(db, projectKey, args, { limit = 5 } = {}) {
  const cap = Math.max(1, Math.min(50, limit));
  const argCommand = typeof args.command === 'string' ? args.command : '';
  const argPath = typeof args.file_path === 'string' ? args.file_path : '';
  // Other arbitrary string values get keyword-scanned.
  const keywordHaystack = Object.entries(args || {})
    .filter(([k, v]) => typeof v === 'string' && k !== 'command' && k !== 'file_path')
    .map(([, v]) => v)
    .join(' ');
  const rows = db
    .prepare(
      `SELECT id, type, title, content, tags, metadata, provenance, confidence, status,
              priority, supersedes, superseded_by, created_at, updated_at,
              expires_at, embedding, embedding_model, last_embed_error,
              access_count, last_accessed_at, stability_days, last_rehearsed_at,
              visibility, shared_with, team_id, agent_id, user_id, session_id,
              task_id, tier, persona_id
         FROM memories
        WHERE project_key = ? AND type = 'skill' AND status = 'active'`,
    )
    .all(projectKey);
  const matches = [];
  for (const row of rows) {
    let meta;
    try {
      meta = JSON.parse(row.metadata || '{}');
    } catch {
      meta = {};
    }
    const trig = meta.trigger || {};
    if (!trig || typeof trig !== 'object') continue;
    let score = 0;
    const cmdList = Array.isArray(trig.commands) ? trig.commands : [];
    const pathList = Array.isArray(trig.paths) ? trig.paths : [];
    const kwList = Array.isArray(trig.keywords) ? trig.keywords : [];
    if (cmdList.length > 0 && argCommand) {
      for (const c of cmdList) {
        if (typeof c !== 'string' || c.length === 0) continue;
        if (argCommand.includes(c)) {
          score += 2.0;
          break;
        }
      }
    }
    if (pathList.length > 0 && argPath) {
      for (const p of pathList) {
        if (typeof p !== 'string' || p.length === 0) continue;
        // Path match: suffix match OR exact segment match (last path
        // component equal). Tolerant of forward/back slashes.
        const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
        if (
          norm(argPath).endsWith('/' + norm(p)) ||
          norm(argPath).endsWith(norm(p)) ||
          norm(argPath) === norm(p)
        ) {
          score += 1.5;
          break;
        }
      }
    }
    if (kwList.length > 0 && keywordHaystack) {
      for (const k of kwList) {
        if (typeof k !== 'string' || k.length === 0) continue;
        if (keywordHaystack.toLowerCase().includes(k.toLowerCase())) {
          score += 1.0;
          break;
        }
      }
    }
    if (score > 0) {
      matches.push({ row, score });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  const top = matches.slice(0, cap);
  return top.map((m) => ({
    ...rowToMemory(m.row),
    trigger_score: m.score,
  }));
}

/**
 * Record a single skill invocation. Inserts a row into
 * skill_invocations with success/failure flag and tool name.
 *
 * The scaffold test calls this with `{success: 0|1, toolName: 'x'}`;
 * durationMs is optional and may be added later.
 */
export function recordSkillInvocation(
  db,
  projectKey,
  skillId,
  { success, toolName, durationMs = null } = {},
) {
  const ok = success === 1 || success === true ? 1 : 0;
  // Three calls in the same millisecond would otherwise collide on
  // PRIMARY KEY; mix in nanoseconds + a per-call counter so the id
  // is unique even under tight loops.
  const stamp = `${nowIso()}:${Date.now() % 1e9}:${Math.floor(Math.random() * 1e9)}`;
  const id = shortId(hashId('skinv', projectKey, skillId, stamp), 16);
  db.prepare(
    `INSERT INTO skill_invocations (id, skill_id, project_key, tool_name, success, duration_ms, invoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, skillId, projectKey, toolName || null, ok, durationMs, nowIso());
  return { id, skill_id: skillId, success: ok };
}

/**
 * Aggregate skill_invocations for a skill: count and success rate.
 * Returns { invoke_count, success_rate } where success_rate is a float
 * in [0, 1] (or 0 when invoke_count is 0).
 */
export function updateSkillInvocationStats(db, projectKey, skillId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(success), 0) AS successes
       FROM skill_invocations
       WHERE project_key = ? AND skill_id = ?`,
    )
    .get(projectKey, skillId);
  const total = row ? row.total : 0;
  const successes = row ? row.successes : 0;
  const success_rate = total > 0 ? successes / total : 0;
  return { invoke_count: total, success_rate };
}

/**
 * List every active skill in the project. Excludes superseded rows
 * and any row whose processing_status === 'pending' (the scaffold
 * test asserts that pending rows are filtered).
 */
export function listSkillMemories(db, projectKey) {
  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE project_key = ? AND type = 'skill' AND status = 'active'`,
    )
    .all(projectKey);
  const out = [];
  for (const r of rows) {
    let meta;
    try {
      meta = JSON.parse(r.metadata || '{}');
    } catch {
      meta = {};
    }
    if (meta.processing_status === 'pending') continue;
    out.push(rowToMemory(r));
  }
  return out;
}

export function isValidEdgeKind(kind) {
  return EDGE_KINDS.has(kind);
}

// ----- Lazy tool registry re-exports -----
//
// `buildToolRegistry` and `filterToolRegistry` are implemented in the
// standalone `./tool-registry.js` module so both `persist.js` and
// `server.js` can import them without creating a circular dependency
// (server.js already imports from persist.js). The test
// `tests/27-tools-lazy.test.js` imports them directly from persist.js,
// which is why the re-exports live here.
export { buildToolRegistry, filterToolRegistry } from './tool-registry.js';

// ----- Processing pipeline -----
//
// promotePendingRows walks the active memories for a project and
// advances the per-row `processing_status` field (stored under
// metadata.processing_status by saveMemory) one step at a time:
//
//   pending    -> distilling   (skill is being extracted / analysed)
//   distilling -> ready        (extraction finished, row is recallable)
//   ready      -> ready        (no-op)
//
// `limit` caps how many rows are touched in one call so a hook caller
// cannot accidentally spend an entire event budget promoting N rows.
// The cap is clamped to [1, 10] to keep the contract bounded.
export function promotePendingRows(db, projectKey, { limit = 10 } = {}) {
  const cap = Math.max(1, Math.min(10, Math.trunc(limit)));
  const rows = db
    .prepare(
      `SELECT id, metadata FROM memories
       WHERE project_key = ? AND status = 'active'
         AND (instr(metadata, '"processing_status":"pending"') > 0
              OR instr(metadata, '"processing_status":"distilling"') > 0)
       LIMIT ?`,
    )
    .all(projectKey, cap);
  let promoted = 0;
  const now = nowIso();
  const updateStmt = db.prepare(`UPDATE memories SET metadata = ?, updated_at = ? WHERE id = ?`);
  for (const r of rows) {
    let meta;
    try {
      meta = JSON.parse(r.metadata || '{}');
    } catch {
      meta = {};
    }
    const current = meta.processing_status;
    let next;
    if (current === 'pending') next = 'distilling';
    else if (current === 'distilling') next = 'ready';
    else continue;
    meta.processing_status = next;
    updateStmt.run(JSON.stringify(meta), now, r.id);
    promoted += 1;
  }
  return { promoted };
}

// Deterministic id for an edge. Same (project_key, from, to, kind)
// always hashes to the same id, which makes memory_link idempotent —
// re-linking returns the same edge instead of erroring on the UNIQUE
// constraint.
function edgeId(projectKey, fromId, toId, kind) {
  return shortId(hashId('edge', projectKey, fromId, toId, kind), 16);
}

// Read an edge by id; returns null if not found or cross-project.
function readEdge(db, projectKey, id) {
  return (
    db.prepare('SELECT * FROM memory_edges WHERE id=? AND project_key=?').get(id, projectKey) ||
    null
  );
}

// Insert (or no-op fetch) an edge from fromId -> toId. Returns the
// existing or newly-created edge. Validates kind up-front.
export function linkMemory(db, projectKey, fromId, toId, kind, { weight = 1.0 } = {}) {
  if (!EDGE_KINDS.has(kind)) throw new Error(`invalid edge kind: ${kind}`);
  if (!fromId || !toId) throw new Error('linkMemory: fromId and toId are required');
  if (fromId === toId) throw new Error('linkMemory: fromId and toId must differ');
  const id = edgeId(projectKey, fromId, toId, kind);
  const existing = readEdge(db, projectKey, id);
  if (existing) {
    // Idempotent: same (project, from, to, kind) is a no-op. If the
    // caller passed a new weight, update it in place.
    if (Number.isFinite(weight) && Math.abs((existing.weight || 1.0) - weight) > 1e-9) {
      db.prepare('UPDATE memory_edges SET weight=? WHERE id=? AND project_key=?').run(
        weight,
        id,
        projectKey,
      );
      existing.weight = weight;
    }
    return existing;
  }
  const now = nowIso();
  db.prepare(
    `
    INSERT INTO memory_edges (id, project_key, from_id, to_id, kind, weight, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(id, projectKey, fromId, toId, kind, Number.isFinite(weight) ? weight : 1.0, now);
  return {
    id,
    project_key: projectKey,
    from_id: fromId,
    to_id: toId,
    kind,
    weight: Number.isFinite(weight) ? weight : 1.0,
    created_at: now,
  };
}

// Remove an edge by id. Returns true if a row was deleted.
export function unlinkMemory(db, projectKey, id) {
  const r = db.prepare('DELETE FROM memory_edges WHERE id=? AND project_key=?').run(id, projectKey);
  return r.changes > 0;
}

// List every edge touching a memory in the given scope (project or
// global). direction is "out" (from_id = id), "in" (to_id = id), or
// "both" (default). kind is optional filter.
export function listEdges(db, projectKey, id, { direction = 'both', kind = null } = {}) {
  const where = ['project_key = ?'];
  const params = [projectKey];
  if (direction === 'out') where.push('from_id = ?');
  else if (direction === 'in') where.push('to_id = ?');
  else where.push('(from_id = ? OR to_id = ?)');
  if (direction === 'out' || direction === 'in') params.push(id);
  else params.push(id, id);
  if (kind) {
    if (!EDGE_KINDS.has(kind)) throw new Error(`invalid edge kind: ${kind}`);
    where.push('kind = ?');
    params.push(kind);
  }
  const rows = db
    .prepare(
      `SELECT * FROM memory_edges WHERE ${where.join(' AND ')} ORDER BY created_at DESC, kind ASC`,
    )
    .all(...params);
  return rows.map((r) => ({
    id: r.id,
    project_key: r.project_key,
    from_id: r.from_id,
    to_id: r.to_id,
    kind: r.kind,
    weight: r.weight,
    created_at: r.created_at,
    direction: r.from_id === id ? 'out' : 'in',
  }));
}

// Merge `fromId` into `intoId`. Behaviour:
//   - intoId gains a union of tags from both memories (existing tags preserved, new ones appended).
//   - intoId gains a merge entry in its provenance: { source: 'memory_merge', merged_from: fromId, ... }.
//   - fromId is soft-superseded (status='superseded', superseded_by=intoId).
//   - fromId is removed from FTS so it no longer matches recall.
//   - A 'supersedes' edge (from -> into) is recorded in memory_edges.
//   - If opts.mergedContent is provided, intoId's content is replaced.
// Returns { into, from, edge }. Throws if either id is missing / soft-deleted.
export function mergeMemory(
  db,
  projectKey,
  intoId,
  fromId,
  { mergedContent = null, weight = 1.0 } = {},
) {
  if (!intoId || !fromId) throw new Error('mergeMemory: intoId and fromId are required');
  if (intoId === fromId) throw new Error('mergeMemory: intoId and fromId must differ');

  const into = getMemory(db, projectKey, intoId, { includeSuperseded: true });
  const from = getMemory(db, projectKey, fromId, { includeSuperseded: true });
  if (!into) throw new Error(`mergeMemory: into memory not found: ${intoId}`);
  if (!from) throw new Error(`mergeMemory: from memory not found: ${fromId}`);

  // Union tags (preserve order, de-dup case-insensitively).
  const seen = new Set();
  const tags = [];
  for (const t of into.tags || []) {
    const k = String(t).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    tags.push(t);
  }
  for (const t of from.tags || []) {
    const k = String(t).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    tags.push(t);
  }

  // Build the new provenance: copy into's, append a merge entry that
  // records where the trailing tags came from.
  const provenance = { ...(into.provenance || {}) };
  provenance.merged_from = Array.isArray(provenance.merged_from) ? provenance.merged_from : [];
  provenance.merged_from.push({
    id: from.id,
    merged_at: nowIso(),
    kind: 'memory_merge',
  });

  // Persist the merged into-memory. We call saveMemory directly so we
  // bypass its supersede-on-same-title logic (we already have a
  // supersedes relationship from -> into).
  const merged = {
    id: into.id,
    type: into.type,
    title: into.title,
    content:
      typeof mergedContent === 'string' && mergedContent.length > 0 ? mergedContent : into.content,
    tags,
    metadata: into.metadata || {},
    provenance,
    confidence: into.confidence,
    status: 'active',
    priority: into.priority || 0,
    expires_at: into.expires_at || null,
    // _embed:false keeps saveMemory sync and skips the embedding
    // microtask — the merged content already has the same or similar
    // embedding as before; the next backfill will refresh if needed.
    _embed: false,
  };
  const updated = saveMemory(db, projectKey, merged);

  // Soft-supersede the from-memory and stamp a back-link. Use raw SQL
  // so we don't re-fire saveMemory's title-based supersede logic (which
  // would chase a chain).
  const now = nowIso();
  db.prepare(
    `
    UPDATE memories
    SET status='superseded', superseded_by=?, updated_at=?
    WHERE id=? AND project_key=?
  `,
  ).run(intoId, now, fromId, projectKey);
  db.prepare('DELETE FROM memories_fts WHERE id=?').run(fromId);

  // Record the typed supersedes edge in memory_edges so consumers of
  // the new graph primitive see the relationship too.
  const edge = linkMemory(db, projectKey, fromId, intoId, 'supersedes', { weight });

  // Reload from-side so the caller sees the soft-superseded status.
  const after = db
    .prepare('SELECT * FROM memories WHERE id=? AND project_key=?')
    .get(fromId, projectKey);
  return {
    into: updated,
    from: after ? { ...rowToMemory(after), status: 'superseded', superseded_by: intoId } : null,
    edge,
  };
}

export function setWorkingMemory(db, projectKey, slot, value) {
  const now = nowIso();
  db.prepare(
    `
    INSERT INTO working_memory (slot, project_key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_key, slot) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `,
  ).run(slot, projectKey, value, now);
  return { slot, value, updated_at: now };
}

export function getWorkingMemory(db, projectKey, slot) {
  const row = db
    .prepare('SELECT * FROM working_memory WHERE slot=? AND project_key=?')
    .get(slot, projectKey);
  if (!row) return null;
  return { slot: row.slot, value: row.value, updated_at: row.updated_at };
}

export function clearWorkingMemory(db, projectKey, slot) {
  const r = db
    .prepare('DELETE FROM working_memory WHERE slot=? AND project_key=?')
    .run(slot, projectKey);
  return r.changes > 0;
}

export function listWorkingMemory(db, projectKey) {
  // The secondary `rowid DESC` sort is a tie-breaker for the common
  // case where many slots were set in the same millisecond — without
  // it, slots inserted back-to-back can return in non-deterministic
  // order across calls, and the UserPromptSubmit preview line for
  // "current_focus" can flicker. rowid is the auto-incrementing
  // physical position so the newest write on ties still wins.
  return db
    .prepare(
      'SELECT slot, value, updated_at FROM working_memory WHERE project_key=? ORDER BY updated_at DESC, rowid DESC',
    )
    .all(projectKey);
}

// ----- Conversations -----

export function upsertConversation(db, projectKey, sessionId, cwd) {
  db.prepare(
    `
    INSERT INTO conversations (session_id, project_key, cwd, last_event_at)
    VALUES (?, ?, ?, NULL)
    ON CONFLICT(session_id, project_key) DO UPDATE SET cwd = COALESCE(conversations.cwd, excluded.cwd)
  `,
  ).run(sessionId, projectKey, cwd || null);
  return getConversation(db, projectKey, sessionId);
}

export function getConversation(db, projectKey, sessionId) {
  const row = db
    .prepare('SELECT * FROM conversations WHERE session_id=? AND project_key=?')
    .get(sessionId, projectKey);
  if (!row) return null;
  return {
    session_id: row.session_id,
    cwd: row.cwd,
    byte_offset: row.byte_offset,
    line_count: row.line_count,
    last_event_at: row.last_event_at,
    last_import_at: row.last_import_at,
    status: row.status,
  };
}

export function listConversations(db, projectKey, { limit = 50 } = {}) {
  const rows = db
    .prepare(
      'SELECT * FROM conversations WHERE project_key=? ORDER BY datetime(last_event_at) DESC LIMIT ?',
    )
    .all(projectKey, Math.max(1, Math.min(500, limit)));
  return rows.map((r) => ({
    session_id: r.session_id,
    cwd: r.cwd,
    byte_offset: r.byte_offset,
    line_count: r.line_count,
    last_event_at: r.last_event_at,
    last_import_at: r.last_import_at,
    status: r.status,
  }));
}

export function searchConversationEvents(
  db,
  projectKey,
  query,
  { sessionId, role, limit = 20 } = {},
) {
  if (!query || !query.trim()) return [];
  const tokens = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 16);
  if (tokens.length === 0) return [];
  const like = '%' + tokens.slice(0, 6).join('%') + '%';
  const where = ['project_key = ?', '(summary LIKE ? OR payload LIKE ?)'];
  const params = [projectKey, like, like];
  if (sessionId) {
    where.push('session_id = ?');
    params.push(sessionId);
  }
  if (role) {
    where.push('role = ?');
    params.push(role);
  }
  params.push(Math.max(1, Math.min(200, limit)));
  const rows = db
    .prepare(
      `SELECT * FROM conversation_events WHERE ${where.join(' AND ')} ORDER BY datetime(created_at) DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map((r) => ({
    session_id: r.session_id,
    line_no: r.line_no,
    byte_offset: r.byte_offset,
    role: r.role,
    kind: r.kind,
    summary: r.summary,
    payload: r.payload,
    created_at: r.created_at,
  }));
}

export function getConversationEvents(db, projectKey, sessionId, { limit = 200, since = 0 } = {}) {
  const rows = db
    .prepare(
      `
    SELECT * FROM conversation_events
    WHERE project_key = ? AND session_id = ? AND line_no >= ?
    ORDER BY line_no ASC LIMIT ?
  `,
    )
    .all(projectKey, sessionId, Math.max(0, since), Math.max(1, Math.min(1000, limit)));
  return rows.map((r) => ({
    session_id: r.session_id,
    line_no: r.line_no,
    byte_offset: r.byte_offset,
    role: r.role,
    kind: r.kind,
    summary: r.summary,
    payload: r.payload,
    created_at: r.created_at,
  }));
}

export function recordConversationEvent(db, projectKey, sessionId, lineNo, byteOffset, event) {
  const payload = typeof event.raw === 'string' ? event.raw : JSON.stringify(event.parsed || {});
  const summary = event.summary || null;
  const role = event.role || null;
  const kind = event.kind || null;
  const createdAt = event.created_at || nowIso();
  db.prepare(
    `
    INSERT INTO conversation_events (session_id, project_key, line_no, byte_offset, role, kind, payload, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, project_key, line_no) DO UPDATE SET
      byte_offset = excluded.byte_offset,
      role = excluded.role,
      kind = excluded.kind,
      payload = excluded.payload,
      summary = excluded.summary
  `,
  ).run(sessionId, projectKey, lineNo, byteOffset, role, kind, payload, summary, createdAt);
}

export function updateConversationProgress(
  db,
  projectKey,
  sessionId,
  byteOffset,
  lineCount,
  lastEventAt,
) {
  db.prepare(
    `
    UPDATE conversations
    SET byte_offset = ?, line_count = ?, last_event_at = COALESCE(?, last_event_at), last_import_at = ?
    WHERE session_id = ? AND project_key = ?
  `,
  ).run(byteOffset, lineCount, lastEventAt || null, nowIso(), sessionId, projectKey);
}

// ----- Ingest state (per-session cursor, persisted to JSON) -----

export async function loadIngestState(kimiHomeDir, projectKey) {
  try {
    const raw = await fs.readFile(ingestStatePath(kimiHomeDir, projectKey), 'utf8');
    const parsed = safeJsonParse(raw);
    if (parsed.ok && parsed.value && typeof parsed.value === 'object') return parsed.value;
  } catch {
    /* missing */
  }
  return { sessions: {} };
}

export async function saveIngestState(kimiHomeDir, projectKey, state) {
  const dir = await ensureProjectDir(kimiHomeDir, projectKey);
  const tmp = ingestStatePath(kimiHomeDir, projectKey) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, path.join(dir, 'ingest-state.json'));
}

// ----- Status -----

// Count-only breakdown for one database (project or global). Pass the
// already-open db handle plus the project_key value (a SHA-256 prefix
// for project DBs, or the literal "_global" string for the global DB).
// Record (or refresh) the canonical project root for `projectKey` in
// this DB. Idempotent: re-recording the same root only updates
// `last_seen_at` and bumps `record_count`. When the new root differs
// from the current one, the current root is copied to
// `last_canonical_root` first so the move is observable by
// `memory_prune` and any external audit. The `record_count` column
// lets the prune tool see how active a project is (zero re-records
// since first_seen_at is a strong "probably orphan" signal).
export function recordProjectPath(db, projectKey, canonicalRoot) {
  if (!projectKey || !canonicalRoot) return;
  const now = nowIso();
  // Single statement: on first insert the conflict clause is skipped,
  // on subsequent inserts with the same root only the counter +
  // last_seen_at change, and on a different root the old root is
  // preserved in last_canonical_root before the overwrite.
  db.prepare(
    `
    INSERT INTO project_paths (
      project_key, canonical_root, first_seen_at, last_seen_at,
      last_canonical_root, record_count
    ) VALUES (?, ?, ?, ?, NULL, 1)
    ON CONFLICT(project_key) DO UPDATE SET
      last_canonical_root = CASE
        WHEN project_paths.canonical_root = excluded.canonical_root
          THEN project_paths.last_canonical_root
        ELSE project_paths.canonical_root
      END,
      canonical_root = excluded.canonical_root,
      last_seen_at   = excluded.last_seen_at,
      record_count   = project_paths.record_count + 1
  `,
  ).run(projectKey, canonicalRoot, now, now);
}

// List every (project_key, canonical_root) pair this DB has ever seen.
// Memory_prune uses this to map a project DB file back to a path on
// disk and decide whether the project still exists.
export function listProjectPaths(db) {
  return db
    .prepare(
      `SELECT project_key, canonical_root, first_seen_at, last_seen_at,
              last_canonical_root, record_count
       FROM project_paths
       ORDER BY last_seen_at DESC`,
    )
    .all();
}

// Re-clone detection: the per-project DB is keyed by a SHA-256 prefix of
// the canonical project root, so a repo that is deleted and re-cloned
// to the SAME path is indistinguishable from the original project. The
// strongest filesystem signal is the directory's birthtime (creation
// time on Windows, ctime fallback on Unix): if the directory was
// created strictly AFTER kimi-memory first stamped `first_seen_at`,
// the project was re-cloned after that stamp and the existing memories
// belong to a previous incarnation.
//
// Returns { isReclone, first_seen_at, dir_birthtime, reason }. The
// reason is non-null whenever isReclone is true or the check is
// inconclusive, so the caller can decide whether to surface a warning.
//
// Heuristic: a re-clone is signaled when the directory's birthtime is
// at least 60 seconds newer than first_seen_at AND the directory is
// less than 7 days old. The 60-second floor absorbs small clock skew
// (the SessionStart hook fires within milliseconds of mkdir, but the
// call paths are not perfectly atomic). The 7-day ceiling stops
// long-lived projects whose birthtime is older than first_seen_at
// (rare but possible after a host move) from being flagged every
// time the user opens the project.
const RECLONE_MIN_GAP_MS = 60_000;
const RECLONE_MAX_DIR_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export function detectReclone(db, projectKey, canonicalRoot) {
  const out = {
    isReclone: false,
    first_seen_at: null,
    dir_birthtime: null,
    reason: null,
  };
  if (!db || !projectKey) return out;
  const row = db
    .prepare('SELECT first_seen_at FROM project_paths WHERE project_key=?')
    .get(projectKey);
  if (!row) {
    out.reason = 'no prior record (fresh project)';
    return out;
  }
  out.first_seen_at = row.first_seen_at;
  if (!canonicalRoot) {
    out.reason = 'no canonical root in payload';
    return out;
  }
  let stat;
  try {
    stat = statSync(canonicalRoot);
  } catch (e) {
    out.reason = 'canonical root not on disk: ' + (e && e.code ? e.code : 'unknown');
    return out;
  }
  // birthtimeMs is 0 on some Unix filesystems; fall back to mtimeMs.
  // On Windows, birthtimeMs is the directory's actual creation time,
  // which is the strongest "this directory was just made" signal.
  //
  // We also clamp to Math.min(birthtimeMs, mtimeMs). On Linux, some
  // tests (and a few admin tools) backdate mtime via utimes, which
  // leaves birthtime ahead of mtime; without the min, the directory
  // would falsely look like it was just created. Using the min gives
  // the older of the two timestamps, which is the right "when was
  // this directory first made" signal across all platforms.
  const dirTime = Math.min(
    stat.birthtimeMs && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs,
    stat.mtimeMs,
  );
  out.dir_birthtime = new Date(dirTime).toISOString();
  const firstSeen = Date.parse(row.first_seen_at);
  if (!Number.isFinite(firstSeen)) {
    out.reason = 'first_seen_at is not parseable';
    return out;
  }
  // dirAheadMs is positive when the directory was created AFTER the
  // first_seen_at stamp — the re-clone signal. Negative values mean
  // the directory is older than first_seen_at, which is the normal
  // case for a long-lived project.
  const dirAheadMs = dirTime - firstSeen;
  const dirAgeMs = Date.now() - dirTime;
  if (dirAheadMs > RECLONE_MIN_GAP_MS && dirAgeMs < RECLONE_MAX_DIR_AGE_MS) {
    out.isReclone = true;
    out.reason = `directory birthtime is ${Math.round(dirAheadMs / 1000)}s newer than first_seen_at; project was re-cloned after kimi-memory first saw it`;
    return out;
  }
  out.reason =
    dirAheadMs <= RECLONE_MIN_GAP_MS
      ? 'directory birthtime predates or matches first_seen_at (no re-clone signal)'
      : `directory birthtime is older than ${Math.round(RECLONE_MAX_DIR_AGE_MS / (24 * 3600 * 1000))}d (long-lived project, skipping)`;
  return out;
}

// Wipe every per-project row for `projectKey` so the next hook / MCP
// call starts from a clean slate. Use this after a repo is re-cloned
// to the same canonical path: the project_key is identical to the old
// project's, so the only way to discard the stale memories, working
// memory, and session archive is to delete them at the row level.
//
// The reset is intentionally narrow:
//   - It scopes every DELETE to project_key = ?, so a single typo
//     cannot nuke the global DB or a sibling project.
//   - It preserves the `project_paths` row but resets first_seen_at
//     to `now`, so the re-clone warning in the hook stops firing for
//     this project after the reset.
//   - It preserves the `last_canonical_root` audit trail (the row
//     before the reset is what an external auditor can read).
//   - It does NOT touch the global DB, ingest-state.json, or the DB
//     file itself: schema + migrations stay in place.
//
// Returns a summary so the caller can render a confirmation message.
export function resetProject(db, projectKey) {
  if (!db || !projectKey) {
    throw new Error('resetProject: db and projectKey are required');
  }
  const summary = {
    project_key: projectKey,
    memories_deleted: 0,
    working_memory_deleted: 0,
    conversations_deleted: 0,
    conversation_events_deleted: 0,
    memory_edges_deleted: 0,
    memory_synthesizes_deleted: 0,
    project_path_preserved: false,
  };
  // node:sqlite does not expose a `db.transaction()` helper, so we run
  // BEGIN / COMMIT manually and roll back on any error. The DELETEs are
  // per-row and the UPDATE is a single statement, so the transaction
  // wraps at most a few hundred rows; the round-trip is sub-ms.
  db.exec('BEGIN');
  try {
    summary.memories_deleted = db
      .prepare('DELETE FROM memories WHERE project_key=?')
      .run(projectKey).changes;
    summary.working_memory_deleted = db
      .prepare('DELETE FROM working_memory WHERE project_key=?')
      .run(projectKey).changes;
    summary.conversations_deleted = db
      .prepare('DELETE FROM conversations WHERE project_key=?')
      .run(projectKey).changes;
    summary.conversation_events_deleted = db
      .prepare('DELETE FROM conversation_events WHERE project_key=?')
      .run(projectKey).changes;
    summary.memory_edges_deleted = db
      .prepare('DELETE FROM memory_edges WHERE project_key=?')
      .run(projectKey).changes;
    summary.memory_synthesizes_deleted = db
      .prepare('DELETE FROM memory_synthesizes WHERE project_key=?')
      .run(projectKey).changes;
    // FTS5 mirrors the memories table. Re-seeding it from a now-empty
    // memories table is a single DELETE; the next memory_save will
    // re-populate the FTS rows for the new project.
    db.exec('DELETE FROM memories_fts');
    // Refresh the project_paths row so first_seen_at reflects the new
    // incarnation. last_canonical_root is preserved as the audit
    // breadcrumb of the pre-reset project. record_count is left as-is
    // (it counts re-records, which we want to keep).
    const r = db
      .prepare(
        `UPDATE project_paths
         SET first_seen_at = ?, last_seen_at = ?, canonical_root = ?
         WHERE project_key = ?`,
      )
      .run(nowIso(), nowIso(), '', projectKey);
    summary.project_path_preserved = r.changes > 0;
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
  return summary;
}

export function memoryCounts(db, projectKey) {
  const total = db
    .prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key=?')
    .get(projectKey).n;
  const active = db
    .prepare(
      "SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND status='active' AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))",
    )
    .get(projectKey).n;
  const expired = db
    .prepare(
      "SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND status='active' AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')",
    )
    .get(projectKey).n;
  const superseded = db
    .prepare("SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND status='superseded'")
    .get(projectKey).n;
  const deleted = db
    .prepare("SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND status='deleted'")
    .get(projectKey).n;
  const retained = expired + superseded + deleted;
  const byType = db
    .prepare(
      "SELECT type, COUNT(*) AS n FROM memories WHERE project_key=? AND status='active' AND (expires_at IS NULL OR datetime(expires_at) > datetime('now')) GROUP BY type",
    )
    .all(projectKey);
  const byStatus = db
    .prepare('SELECT status, COUNT(*) AS n FROM memories WHERE project_key=? GROUP BY status')
    .all(projectKey);
  const latestRow = db
    .prepare('SELECT MAX(updated_at) AS t FROM memories WHERE project_key=?')
    .get(projectKey);
  return {
    // `total` is preserved as a compatibility field: every row in the
    // memories table for this key, regardless of status. The accurate
    // "currently forceable" count is `active`, and the still-on-disk
    // but no-longer-in-force count is `retained`.
    total,
    active,
    retained,
    expired,
    superseded,
    deleted,
    by_type: Object.fromEntries(byType.map((r) => [r.type, r.n])),
    by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    latest_update_at: latestRow && latestRow.t ? latestRow.t : null,
  };
}

// Backward-compatibility wrapper around memoryCounts. Top-level fields
// describe the project's own durable + working memory + conversations,
// matching the shape returned by earlier versions of this plugin.
export function projectStatus(db, projectKey) {
  const mem = memoryCounts(db, projectKey);
  const wm = db
    .prepare('SELECT COUNT(*) AS n FROM working_memory WHERE project_key=?')
    .get(projectKey).n;
  const conv = db
    .prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_key=?')
    .get(projectKey).n;
  const events = db
    .prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?')
    .get(projectKey).n;
  return {
    project_key: projectKey,
    memories: mem,
    working_memory_slots: wm,
    conversations: conv,
    conversation_events: events,
  };
}
// Row-count snapshot used by the dry-run path of memory_reset_project
// (and the matching CLI command). Both call sites need the same six
// counts, so the SELECT statements live here and the call sites
// decorate the result with `reclone` + `total_rows` as needed.
export function resetProjectDryRunCounts(db, projectKey) {
  const get = (sql) => db.prepare(sql).get(projectKey).n;
  return {
    memories: get('SELECT COUNT(*) AS n FROM memories WHERE project_key=?'),
    working_memory: get('SELECT COUNT(*) AS n FROM working_memory WHERE project_key=?'),
    conversations: get('SELECT COUNT(*) AS n FROM conversations WHERE project_key=?'),
    conversation_events: get('SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?'),
    memory_edges: get('SELECT COUNT(*) AS n FROM memory_edges WHERE project_key=?'),
    memory_synthesizes: get('SELECT COUNT(*) AS n FROM memory_synthesizes WHERE project_key=?'),
  };
}
