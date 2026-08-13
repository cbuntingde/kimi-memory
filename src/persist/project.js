// Project-scoped data: per-project paths, working memory, conversations,
// and the ingest-state cursor file.
//
// These all live in the same project DB but are conceptually distinct
// from the memories table that the rest of the package operates on.
import { promises as fs } from 'node:fs';
import { statSync } from 'node:fs';
import path from 'node:path';
import { nowIso, safeJsonParse } from '../util.js';
import { ensureProjectDir, ingestStatePath } from '../project-key.js';
import { rowToMemory } from './memories.js';

// ----- Working memory -----

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

// ----- Project paths (per-DB registry, re-clone detection, reset) -----

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
export function resetProject(db, projectKey, { canonicalRoot = '' } = {}) {
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
    //
    // canonicalRoot is preserved when the caller does not supply one:
    // overwriting it with '' would mark the just-reset project as a
    // self-orphan on the next `memory_prune` run, until the next
    // SessionStart hook re-stamps it. (Audit flag F-102.)
    const r = db
      .prepare(
        `UPDATE project_paths
         SET first_seen_at = ?, last_seen_at = ?,
             canonical_root = COALESCE(NULLIF(?, ''), canonical_root)
         WHERE project_key = ?`,
      )
      .run(nowIso(), nowIso(), canonicalRoot, projectKey);
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
