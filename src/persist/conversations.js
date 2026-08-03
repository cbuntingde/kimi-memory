// Conversations + ingest state + project_paths. The `conversations`
// table holds one row per session, `conversation_events` holds the
// raw JSONL lines Kimi writes, and `project_paths` records every
// project_key → canonical_root the DB has ever seen (drives
// memory_prune). Ingest state lives in a JSON file next to the SQLite
// DB so a process restart can resume mid-session without re-walking
// the entire wire.jsonl.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nowIso, safeJsonParse } from '../util.js';
import { ensureProjectDir, ingestStatePath } from '../project-key.js';

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

// ----- Project paths (drives memory_prune) -----

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
