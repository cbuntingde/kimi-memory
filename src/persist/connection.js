// SQLite connection + schema management.
//
// Handles DB open/close, runs the idempotent migration list, and
// exposes the cross-project shared DB path. Schema definition lives
// here because openDb is the only entry point that creates it.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { logPersistError } from '../diagnostics.js';

const SCHEMA_VERSION = 13;

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
        -- (Audit fix L1: also re-create the v3
        -- idx_memories_project_embedding_dim, which the previous
        -- shape omitted. Without it, vector recall falls back to
        -- a full table scan on the (project_key, embedding_dim)
        -- predicate right after the rebuild — exactly the case the
        -- index exists to avoid.)
        CREATE INDEX idx_memories_project_type   ON memories(project_key, type);
        CREATE INDEX idx_memories_project_status ON memories(project_key, status);
        CREATE INDEX idx_memories_expires        ON memories(expires_at);
        CREATE INDEX idx_memories_supersedes     ON memories(supersedes);
        CREATE INDEX idx_memories_embedded_at    ON memories(embedded_at);
        CREATE INDEX idx_memories_project_embedding_dim ON memories(project_key, embedding_dim);
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
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_edges'").get()
        ?.sql || '';
    const hasCodegraphKinds = /kind\s+IN\s*\([^)]*\bimports\b[^)]*\bcalls\b[^)]*\bdefines\b/i.test(
      createSql,
    );
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
        -- (Audit fix L1: re-create the v3
        -- idx_memories_project_embedding_dim index after the rebuild,
        -- see comment in the v5 migration above.)
        CREATE INDEX idx_memories_project_embedding_dim ON memories(project_key, embedding_dim);
        DELETE FROM memories_fts;
        INSERT INTO memories_fts (id, project_key, type, title, content, tags)
          SELECT id, project_key, type, title, content, tags FROM memories;
        COMMIT;
      `);
    }
  },
  // v11: index project_key on memories_fts so the FTS5 MATCH can
  // filter on project_key directly (via the virtual table's
  // auxiliary columns) instead of always reading every match back
  // through the JOIN to memories. In the per-project-per-DB model
  // the benefit is modest (every row in this DB shares the same
  // project_key), but it future-proofs the schema against a
  // multi-tenant DB layout and removes a WHERE-clause layer.
  //
  // Idempotent: probe the CREATE TABLE SQL on sqlite_master, and
  // only rebuild when `project_key UNINDEXED` is still on the
  // existing virtual table. Re-runs after a successful rebuild
  // short-circuit.
  // (Audit finding F-010.)
  function migrateFts5IndexProjectKey(db) {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .get();
    const sql = (row && row.sql) || '';
    if (!sql) return;
    if (!/project_key\s+UNINDEXED/i.test(sql)) return;
    db.exec(`
      BEGIN;
      DROP TABLE IF EXISTS memories_fts;
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        id UNINDEXED,
        project_key,
        type,
        title,
        content,
        tags,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      INSERT INTO memories_fts (id, project_key, type, title, content, tags)
        SELECT id, project_key, type, title, content, tags FROM memories;
      COMMIT;
    `);
  },

  // v12: dedicated is_session_focus column. The previous read path used
  // `instr(metadata, '"session_focus":true') > 0`, a function predicate
  // that cannot ride any B-tree index — every session-focus lookup paid
  // a scan over every working-type row in the project. The dedicated
  // column + composite index turns the predicate into a range scan
  // bound to a tiny constant working set per project.
  function migrateAddSessionFocusColumn(db) {
    const cols = db.prepare('PRAGMA table_info(memories)').all();
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('is_session_focus')) {
      db.exec('ALTER TABLE memories ADD COLUMN is_session_focus INTEGER NOT NULL DEFAULT 0');
    }
    // Backfill: any working-type row whose metadata already contains the
    // canonical flag gets the column stamped so legacy rows survive the
    // migration without a manual step. Idempotent — re-running on a
    // fully-stamped DB updates 0 rows.
    db.exec(
      'UPDATE memories SET is_session_focus = 1 ' +
        "WHERE is_session_focus = 0 AND type = 'working' " +
        'AND instr(metadata, \'"session_focus":true\') > 0',
    );
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_session_focus'",
      )
      .get();
    if (!idx)
      db.exec(
        'CREATE INDEX idx_memories_session_focus ' +
          'ON memories(project_key, is_session_focus, updated_at)',
      );
  },

  // v13: Phase-1 staged Dream consolidation. Two durable tables:
  //
  //   dream_jobs       — one row per scheduled Dream pass.
  //                      Status moves through queued → running → ready
  //                      → applied (or failed / stale / cancelled).
  //                      A partial unique index on
  //                      (project_key) WHERE status='running' is the
  //                      "single in-flight job per project" guard.
  //
  //   dream_proposals  — proposed operations for a given job:
  //                      conclusion, merge, supersede, link.
  //                      Stores source / target ids, proposed content,
  //                      confidence, provenance, and per-row status.
  //
  // Both tables are project-scoped (per-project DBs only — the global
  // DB never receives dream traffic). The unique-active-job index is
  // the single concurrency primitive; re-enqueue is idempotent at the
  // SQL layer. Every column / index probe is idempotent so a re-run is
  // a no-op once a DB is fully migrated.
  function migrateAddDreamTables(db) {
    // dream_jobs: lifecycle + scheduling metadata. Input snapshot is
    // stored as a small JSON blob (memory_count + sessions list) so
    // apply-time can validate "sources unchanged" without re-walking
    // the whole DB.
    db.exec(`
      CREATE TABLE IF NOT EXISTS dream_jobs (
        id              TEXT PRIMARY KEY,
        project_key     TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','running','ready','applied','stale','failed','cancelled')),
        triggered_by    TEXT NOT NULL DEFAULT 'lifecycle',
        input_snapshot  TEXT NOT NULL DEFAULT '{}',
        result_counts   TEXT NOT NULL DEFAULT '{}',
        error           TEXT,
        enqueued_at     TEXT NOT NULL,
        started_at      TEXT,
        ready_at        TEXT,
        applied_at      TEXT,
        updated_at      TEXT NOT NULL
      )
    `);
    const idxDreamProj = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_dream_jobs_project'",
      )
      .get();
    if (!idxDreamProj)
      db.exec('CREATE INDEX idx_dream_jobs_project ON dream_jobs(project_key, updated_at)');
    // Partial unique index — the only invariant we need for the
    // "one running job per project" guard. A second concurrent enqueue
    // trips this constraint, which the application layer catches and
    // turns into a no-op. Skipped on tables that already have the index.
    const idxActive = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_dream_jobs_active'")
      .get();
    if (!idxActive) {
      db.exec(
        "CREATE UNIQUE INDEX idx_dream_jobs_active ON dream_jobs(project_key) WHERE status = 'running'",
      );
    }

    // dream_proposals: staged operations. source_ids + target_ids are
    // JSON arrays; confidence + provenance make the proposal
    // self-describing so review/apply never has to reconstruct meaning.
    db.exec(`
      CREATE TABLE IF NOT EXISTS dream_proposals (
        id              TEXT PRIMARY KEY,
        job_id          TEXT NOT NULL,
        project_key     TEXT NOT NULL,
        kind            TEXT NOT NULL
                          CHECK (kind IN ('conclusion','merge','supersede','link')),
        source_ids      TEXT NOT NULL DEFAULT '[]',
        target_ids      TEXT NOT NULL DEFAULT '[]',
        proposed_content TEXT NOT NULL DEFAULT '',
        confidence      REAL NOT NULL DEFAULT 0.7,
        provenance      TEXT NOT NULL DEFAULT '{}',
        source_checksum TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','stale','approved','applied','rejected')),
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES dream_jobs(id)
      )
    `);
    const idxPropJob = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_dream_proposals_job'",
      )
      .get();
    if (!idxPropJob)
      db.exec('CREATE INDEX idx_dream_proposals_job ON dream_proposals(job_id, status)');
    const idxPropProj = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_dream_proposals_project'",
      )
      .get();
    if (!idxPropProj)
      db.exec('CREATE INDEX idx_dream_proposals_project ON dream_proposals(project_key, status)');
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
  last_accessed_at TEXT,
  -- v12: dedicated session-focus column. Replaces the function
  -- predicate on metadata JSON so the hook thread can ride
  -- idx_memories_session_focus instead of scanning every working
  -- row in the project.
  is_session_focus INTEGER NOT NULL DEFAULT 0
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
  project_key,
  type,
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
-- Supports readRecentFilePaths: the hot query filters by project_key
-- AND kind, then sorts by line_no. The composite index matches both
-- the equality filter and the sort. (Audit finding F-006.)
CREATE INDEX IF NOT EXISTS idx_events_project_kind_line
  ON conversation_events(project_key, kind, line_no);

-- FTS5 mirror of conversation_events for conversation_search. The
-- LIKE-on-summary / LIKE-on-payload path in project.js#searchConversationEvents
-- was a full table scan on every call; a 50k-event archive per
-- project pays that cost on every MCP invocation. The FTS5 mirror
-- carries line_no + session_id + project_key as UNINDEXED columns so
-- the read path can JOIN back to the source row on the composite PK.
-- The mirror is populated lazily by mirrorConversationEventsFts;
-- a freshly-ingested row may briefly live in the source table only
-- and is covered by the LIKE fallback. (Audit fix H4.)
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_events_fts USING fts5(
  session_id UNINDEXED,
  project_key UNINDEXED,
  line_no UNINDEXED,
  role UNINDEXED,
  summary,
  payload,
  tokenize = 'unicode61 remove_diacritics 2'
);

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
  // Open read-write + create if missing. If any of the PRAGMA calls,
  // SCHEMA_SQL execution, the migration loop, or the schema_meta
  // upsert throws, close the native handle before propagating so the
  // process does not leak it on every failed open. node:sqlite does
  // not finalize dropped JS references automatically — each leaked
  // handle is a permanent file descriptor until the process exits.
  // (Audit fix M4.)
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: false, create: true });
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
  } catch (err) {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
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

// Re-export statSync so other modules can use it without re-importing
// node:fs (used by project.js for re-clone detection).
export { statSync };
