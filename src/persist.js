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
import { promises as fs, mkdirSync } from 'node:fs';
import path from 'node:path';
import { nowIso, hashId, shortId, safeJsonParse } from './util.js';
import {
  ensureProjectDir,
  ingestStatePath,
} from './project-key.js';

const SCHEMA_VERSION = 2;

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
    const pk = db.prepare("PRAGMA table_info(working_memory)").all();
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
  expires_at    TEXT                          -- ISO; null = never
);

CREATE INDEX IF NOT EXISTS idx_memories_project_type ON memories(project_key, type);
CREATE INDEX IF NOT EXISTS idx_memories_project_status ON memories(project_key, status);
CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);
CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories(supersedes);

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
  try { mkdirSync(parent, { recursive: true }); } catch { /* ignore */ }
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
  db.prepare(`
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(String(SCHEMA_VERSION));
  cachedDbs.set(dbPath, db);
  return db;
}

export function closeDb(dbPath) {
  if (dbPath) {
    const db = cachedDbs.get(dbPath);
    if (db) {
      try { db.close(); } catch { /* ignore */ }
      cachedDbs.delete(dbPath);
    }
    return;
  }
  for (const [p, db] of cachedDbs) {
    try { db.close(); } catch { /* ignore */ }
    try { cachedDbs.delete(p); } catch { /* ignore */ }
  }
}

export function memoryId(projectKey, type, title, content) {
  return shortId(hashId(projectKey, type, title || '', content || ''), 24);
}

export function rowToMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    title: row.title || '',
    content: row.content,
    tags: JSON.parse(row.tags || '[]'),
    metadata: JSON.parse(row.metadata || '{}'),
    provenance: JSON.parse(row.provenance || '{}'),
    confidence: row.confidence,
    status: row.status,
    priority: row.priority,
    supersedes: row.supersedes || null,
    superseded_by: row.superseded_by || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at || null,
  };
}

// ----- CRUD -----

export function saveMemory(db, projectKey, input) {
  const now = nowIso();
  const id = input.id || memoryId(projectKey, input.type, input.title || '', input.content || '');
  const tags = JSON.stringify(input.tags || []);
  const metadata = JSON.stringify(input.metadata || {});
  const provenance = JSON.stringify(input.provenance || {});
  const confidence = typeof input.confidence === 'number' ? Math.max(0, Math.min(1, input.confidence)) : 0.8;
  const status = input.status || 'active';
  const priority = Number.isFinite(input.priority) ? Math.trunc(input.priority) : 0;
  const expires = input.expires_at || null;

  // Supersession: when supersede=true and a prior memory with the
  // same (project_key, type, title) is active, mark the prior
  // superseded and record a backlink from the new memory back to it.
  // If no prior exists, the flag is a no-op: the new memory is still
  // created as active. This is intentional — callers that want a
  // pure "replace me" should pair supersede=true with an existing
  // title they intend to replace.
  let supersedesId = input.supersedes || null;
  if (input.supersede) {
    const existing = db.prepare(
      "SELECT id FROM memories WHERE project_key = ? AND type = ? AND COALESCE(title,'') = ? AND status = 'active' AND id != ? ORDER BY updated_at DESC"
    ).all(projectKey, input.type, input.title || '', id);
    if (existing.length > 0) {
      // Link back to the most-recent prior; mark every prior superseded.
      supersedesId = existing[0].id;
      for (const ex of existing) {
        db.prepare("UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE id=?").run(id, now, ex.id);
      }
    }
  }

  const row = db.prepare("SELECT id, created_at FROM memories WHERE id=?").get(id);
  if (row) {
    db.prepare(`
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
        updated_at = ?
      WHERE id = ?
    `).run(
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
      now,
      id
    );
  } else {
    db.prepare(`
      INSERT INTO memories (id, project_key, type, title, content, tags, metadata, provenance, confidence, status, priority, supersedes, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, projectKey, input.type, input.title || '', input.content || '',
      tags, metadata, provenance, confidence, status, priority,
      supersedesId,
      now, now, expires
    );
  }

  // FTS upsert
  db.prepare("DELETE FROM memories_fts WHERE id=?").run(id);
  db.prepare("INSERT INTO memories_fts (id, project_key, type, title, content, tags) VALUES (?, ?, ?, ?, ?, ?)").run(
    id, projectKey, input.type, input.title || '', input.content || '', (input.tags || []).join(' ')
  );

  return getMemory(db, projectKey, id);
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
  db.exec('BEGIN');
  try {
    const out = [];
    for (const input of inputs) {
      out.push(saveMemory(db, projectKey, input));
    }
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

export function getMemory(db, projectKey, id, { includeSuperseded = false } = {}) {
  const row = db.prepare("SELECT * FROM memories WHERE id=? AND project_key=?").get(id, projectKey);
  if (!row) return null;
  if (row.status === 'deleted') return null;
  if (row.status === 'superseded' && !includeSuperseded) return null;
  // Expiry check
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    return { ...rowToMemory(row), expired: true };
  }
  return rowToMemory(row);
}

export function listMemories(db, projectKey, { type, status = 'active', limit = 50, offset = 0, includeExpired = false } = {}) {
  const where = ['project_key = ?'];
  const params = [projectKey];
  if (type) { where.push('type = ?'); params.push(type); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (!includeExpired) where.push("(expires_at IS NULL OR datetime(expires_at) > datetime('now'))");
  const sql = `SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY priority DESC, datetime(updated_at) DESC LIMIT ? OFFSET ?`;
  params.push(Math.max(1, Math.min(500, limit)), Math.max(0, offset));
  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToMemory);
}

export function deleteMemory(db, projectKey, id, { hard = false } = {}) {
  if (hard) {
    db.prepare("DELETE FROM memories_fts WHERE id=?").run(id);
    const r = db.prepare("DELETE FROM memories WHERE id=? AND project_key=?").run(id, projectKey);
    return r.changes > 0;
  }
  const now = nowIso();
  const r = db.prepare("UPDATE memories SET status='deleted', updated_at=? WHERE id=? AND project_key=?").run(now, id, projectKey);
  if (r.changes) {
    db.prepare("DELETE FROM memories_fts WHERE id=?").run(id);
  }
  return r.changes > 0;
}

export function searchMemories(db, projectKey, query, { type, limit = 20 } = {}) {
  if (!query || !query.trim()) return [];
  // Build a safe FTS5 prefix query from sanitised tokens.
  const tokens = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 16);
  if (tokens.length === 0) return [];
  const fts = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
  const params = [fts, projectKey];
  let typeClause = '';
  if (type) { typeClause = ' AND m.type = ?'; params.push(type); }
  params.push(Math.max(1, Math.min(200, limit)));
  const rows = db.prepare(`
    SELECT m.* FROM memories_fts f
    JOIN memories m ON m.id = f.id
    WHERE memories_fts MATCH ?
      AND m.project_key = ?
      AND m.status = 'active'
      AND (m.expires_at IS NULL OR datetime(m.expires_at) > datetime('now'))${typeClause}
    ORDER BY rank, m.priority DESC
    LIMIT ?
  `).all(...params);
  return rows.map(rowToMemory);
}

// ----- Working memory -----

export function setWorkingMemory(db, projectKey, slot, value) {
  const now = nowIso();
  db.prepare(`
    INSERT INTO working_memory (slot, project_key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_key, slot) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(slot, projectKey, value, now);
  return { slot, value, updated_at: now };
}

export function getWorkingMemory(db, projectKey, slot) {
  const row = db.prepare("SELECT * FROM working_memory WHERE slot=? AND project_key=?").get(slot, projectKey);
  if (!row) return null;
  return { slot: row.slot, value: row.value, updated_at: row.updated_at };
}

export function clearWorkingMemory(db, projectKey, slot) {
  const r = db.prepare("DELETE FROM working_memory WHERE slot=? AND project_key=?").run(slot, projectKey);
  return r.changes > 0;
}

export function listWorkingMemory(db, projectKey) {
  return db.prepare("SELECT slot, value, updated_at FROM working_memory WHERE project_key=? ORDER BY updated_at DESC").all(projectKey);
}

// ----- Conversations -----

export function upsertConversation(db, projectKey, sessionId, cwd) {
  db.prepare(`
    INSERT INTO conversations (session_id, project_key, cwd, last_event_at)
    VALUES (?, ?, ?, NULL)
    ON CONFLICT(session_id, project_key) DO UPDATE SET cwd = COALESCE(conversations.cwd, excluded.cwd)
  `).run(sessionId, projectKey, cwd || null);
  return getConversation(db, projectKey, sessionId);
}

export function getConversation(db, projectKey, sessionId) {
  const row = db.prepare("SELECT * FROM conversations WHERE session_id=? AND project_key=?").get(sessionId, projectKey);
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
  const rows = db.prepare("SELECT * FROM conversations WHERE project_key=? ORDER BY datetime(last_event_at) DESC LIMIT ?").all(projectKey, Math.max(1, Math.min(500, limit)));
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

export function searchConversationEvents(db, projectKey, query, { sessionId, role, limit = 20 } = {}) {
  if (!query || !query.trim()) return [];
  const tokens = query.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 16);
  if (tokens.length === 0) return [];
  const like = '%' + tokens.slice(0, 6).join('%') + '%';
  const where = ['project_key = ?', "(summary LIKE ? OR payload LIKE ?)"];
  const params = [projectKey, like, like];
  if (sessionId) { where.push('session_id = ?'); params.push(sessionId); }
  if (role) { where.push('role = ?'); params.push(role); }
  params.push(Math.max(1, Math.min(200, limit)));
  const rows = db.prepare(`SELECT * FROM conversation_events WHERE ${where.join(' AND ')} ORDER BY datetime(created_at) DESC LIMIT ?`).all(...params);
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
  const rows = db.prepare(`
    SELECT * FROM conversation_events
    WHERE project_key = ? AND session_id = ? AND line_no >= ?
    ORDER BY line_no ASC LIMIT ?
  `).all(projectKey, sessionId, Math.max(0, since), Math.max(1, Math.min(1000, limit)));
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
  db.prepare(`
    INSERT INTO conversation_events (session_id, project_key, line_no, byte_offset, role, kind, payload, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, project_key, line_no) DO UPDATE SET
      byte_offset = excluded.byte_offset,
      role = excluded.role,
      kind = excluded.kind,
      payload = excluded.payload,
      summary = excluded.summary
  `).run(sessionId, projectKey, lineNo, byteOffset, role, kind, payload, summary, createdAt);
}

export function updateConversationProgress(db, projectKey, sessionId, byteOffset, lineCount, lastEventAt) {
  db.prepare(`
    UPDATE conversations
    SET byte_offset = ?, line_count = ?, last_event_at = COALESCE(?, last_event_at), last_import_at = ?
    WHERE session_id = ? AND project_key = ?
  `).run(byteOffset, lineCount, lastEventAt || null, nowIso(), sessionId, projectKey);
}

// ----- Ingest state (per-session cursor, persisted to JSON) -----

export async function loadIngestState(kimiHomeDir, projectKey) {
  try {
    const raw = await fs.readFile(ingestStatePath(kimiHomeDir, projectKey), 'utf8');
    const parsed = safeJsonParse(raw);
    if (parsed.ok && parsed.value && typeof parsed.value === 'object') return parsed.value;
  } catch { /* missing */ }
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
export function memoryCounts(db, projectKey) {
  const total = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE project_key=?").get(projectKey).n;
  const active = db.prepare(
    "SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND status='active' AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))"
  ).get(projectKey).n;
  const expired = db.prepare(
    "SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND status='active' AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')"
  ).get(projectKey).n;
  const superseded = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND status='superseded'").get(projectKey).n;
  const deleted = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND status='deleted'").get(projectKey).n;
  const retained = expired + superseded + deleted;
  const byType = db.prepare(
    "SELECT type, COUNT(*) AS n FROM memories WHERE project_key=? AND status='active' AND (expires_at IS NULL OR datetime(expires_at) > datetime('now')) GROUP BY type"
  ).all(projectKey);
  const byStatus = db.prepare("SELECT status, COUNT(*) AS n FROM memories WHERE project_key=? GROUP BY status").all(projectKey);
  const latestRow = db.prepare("SELECT MAX(updated_at) AS t FROM memories WHERE project_key=?").get(projectKey);
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
  const wm = db.prepare("SELECT COUNT(*) AS n FROM working_memory WHERE project_key=?").get(projectKey).n;
  const conv = db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE project_key=?").get(projectKey).n;
  const events = db.prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?").get(projectKey).n;
  return {
    project_key: projectKey,
    memories: mem,
    working_memory_slots: wm,
    conversations: conv,
    conversation_events: events,
  };
}
