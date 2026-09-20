// Project-scoped data: per-project paths, working memory, conversations,
// and the ingest-state cursor file.
//
// These all live in the same project DB but are conceptually distinct
// from the memories table that the rest of the package operates on.
import { promises as fs } from 'node:fs';
import { statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { nowIso, safeJsonParse } from '../util.js';
import { ensureProjectDir, ingestStatePath } from '../project-key.js';
import { assertNoSecret } from './memories.js';
import { redactSecrets, redactPayload } from '../secrets.js';

// ----- Working memory -----

export function setWorkingMemory(db, projectKey, slot, value) {
  // Secret screen: the slot value lands verbatim in working_memory.value
  // and is recalled into the agent context on the next prompt (via the
  // SessionStart working-memory preview). A user paste of "remember my
  // API key is api_key = abcdefghijklmnop" would otherwise bypass the
  // memory_save gate and reach the agent on the next session. Run the
  // same predicate the durable write path uses.
  // (Production-readiness review finding F-1.)
  if (typeof value === 'string' && value.length > 0) {
    assertNoSecret({ content: value });
  }
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
  // FTS5 path: the conversation_events_fts mirror is the fast read
  // surface for keyword search. The mirror is populated lazily by
  // mirrorConversationEventsFts(); a row that was just ingested but
  // not yet mirrored is still findable via the LIKE fallback below.
  // (Audit fix H4.)
  let rows = [];
  try {
    const ftsQuery = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    // Every predicate must be qualified with the `f.` alias: the joined
    // conversation_events source table exposes session_id / project_key /
    // role as well, and an unqualified name is an ambiguous-column error
    // that the catch below would swallow into the slow LIKE path.
    const ftsWhere = ['f.project_key = ?'];
    const ftsParams = [projectKey];
    if (sessionId) {
      ftsWhere.push('f.session_id = ?');
      ftsParams.push(sessionId);
    }
    if (role) {
      ftsWhere.push('f.role = ?');
      ftsParams.push(role);
    }
    ftsParams.push(Math.max(1, Math.min(200, limit)));
    rows = db
      .prepare(
        `SELECT m.* FROM conversation_events_fts f
         JOIN conversation_events m
           ON m.session_id = f.session_id
          AND m.project_key = f.project_key
          AND m.line_no = f.line_no
         WHERE conversation_events_fts MATCH ?
           AND ${ftsWhere.join(' AND ')}
         ORDER BY datetime(m.created_at) DESC LIMIT ?`,
      )
      .all(ftsQuery, ...ftsParams);
    // Lazy mirror backfill: the FTS5 query returned nothing, so check
    // whether this project simply has no mirrored rows yet. That is the
    // normal first-search state — recordConversationEvent deliberately
    // does not write the mirror (WAL contention under ingest loads) — so
    // backfill once from the source table and retry the same query.
    if (rows.length === 0) {
      const sourceCount = db
        .prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE project_key = ?')
        .get(projectKey).n;
      const mirrorCount = db
        .prepare('SELECT COUNT(*) AS n FROM conversation_events_fts WHERE project_key = ?')
        .get(projectKey).n;
      if (sourceCount > 0 && mirrorCount === 0) {
        mirrorConversationEventsFts(db, projectKey);
        rows = db
          .prepare(
            `SELECT m.* FROM conversation_events_fts f
             JOIN conversation_events m
               ON m.session_id = f.session_id
              AND m.project_key = f.project_key
              AND m.line_no = f.line_no
             WHERE conversation_events_fts MATCH ?
               AND ${ftsWhere.join(' AND ')}
             ORDER BY datetime(m.created_at) DESC LIMIT ?`,
          )
          .all(ftsQuery, ...ftsParams);
      }
    }
  } catch {
    /* FTS5 mirror missing or stale — fall through to LIKE. */
    rows = [];
  }
  // LIKE fallback covers freshly-ingested rows the mirror hasn't seen
  // yet, and the case where the FTS5 mirror was never populated.
  if (rows.length === 0) {
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
    rows = db
      .prepare(
        `SELECT * FROM conversation_events WHERE ${where.join(' AND ')} ORDER BY datetime(created_at) DESC LIMIT ?`,
      )
      .all(...params);
  }
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
  // The session archive is the highest-volume channel into the store and
  // it captures whatever was typed or read into the conversation —
  // including credentials. Redact before the row is written so a secret
  // pasted in chat is never persisted, and never surfaced back through
  // conversation_get / conversation_search.
  //
  // `payload` must stay parseable JSON: session-focus.js re-parses it to
  // recover a summary the wire walker could not extract, so we redact the
  // string values in place rather than the serialised text.
  const payload = redactPayload(
    typeof event.raw === 'string' ? event.raw : JSON.stringify(event.parsed || {}),
  );
  const summary = event.summary ? redactSecrets(event.summary) : null;
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
  // Note: the conversation_events_fts mirror is intentionally NOT
  // written here. Doing so per-event caused WAL+busy_timeout
  // contention between the hook and MCP processes under realistic
  // ingest loads — the test suite hung at this exact point. The
  // mirror is rebuilt lazily by searchConversationEvents (see below)
  // when a search hits an empty/stale mirror. (Audit fix H4 —
  // revised to lazy backfill.)
}

// Rebuild the FTS5 mirror from scratch for one project. Cheap on
// healthy DBs; on a 50k-event archive it runs once, on the first
// searchConversationEvents call that finds an empty mirror for the
// project, and every later search is served from the mirror.
// (Audit fix H4.)
export function mirrorConversationEventsFts(db, projectKey) {
  if (!db || !projectKey) return { mirrored: 0 };
  try {
    const rows = db
      .prepare(
        `SELECT session_id, project_key, line_no, role, summary, payload
         FROM conversation_events
         WHERE project_key = ?`,
      )
      .all(projectKey);
    let mirrored = 0;
    const insert = db.prepare(
      `INSERT OR REPLACE INTO conversation_events_fts (session_id, project_key, line_no, role, summary, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        insert.run(
          r.session_id,
          r.project_key,
          r.line_no,
          r.role || '',
          r.summary || '',
          r.payload || '',
        );
        mirrored += 1;
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
    return { mirrored };
  } catch {
    return { mirrored: 0 };
  }
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
  const dest = path.join(dir, 'ingest-state.json');
  // The temp name must be unique per write. A Stop hook can still be
  // running when the next UserPromptSubmit fires, so two hook processes
  // read-modify-write this file for one project at the same time; a fixed
  // temp name lets them write each other's staging file, and then one
  // rename publishes the other's bytes (or raises EPERM on Windows while
  // the path is held open) — silently dropping the loser's session cursor
  // and the latest_extract / latest_work_log / latest_session_focus
  // entries. `rename` is atomic within one directory, so the destination
  // is never observed half-written.
  const tmp = `${dest}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, dest);
  } catch (err) {
    // Best-effort cleanup: the failed write must not leave staging files
    // behind for the next pass to trip over.
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
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
//   - It clears the FTS5 mirrors that shadow the rows it deletes
//     (memories_fts, conversation_events_fts) so a search after the
//     reset cannot hit a stale index.
//   - It clears the per-memory ACL grants (memories_acl) and tier audit
//     rows (persona_promotions) plus the project's skill invocations, so
//     a "wiped" project carries no rows keyed to it.
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
    memories_acl_deleted: 0,
    persona_promotions_deleted: 0,
    skill_invocations_deleted: 0,
    project_path_preserved: false,
  };
  // node:sqlite does not expose a `db.transaction()` helper, so we run
  // BEGIN / COMMIT manually and roll back on any error. Every statement is
  // scoped to project_key, so the transaction touches one project's rows
  // and nothing else: cheap on a small project, and on a large one the
  // work is bounded by that project's own row count (33k memories measure
  // ~0.5 s). That cost is the price of the all-or-nothing reset the dry
  // run promises — the previous row-per-placeholder FTS sweep could not
  // complete at that size at all.
  db.exec('BEGIN');
  try {
    // memories_acl and persona_promotions have no project_key column (see
    // the schema in connection.js): a row is keyed on memory_id alone, so
    // "belongs to this project" means "its memory_id names a memories row
    // in this project DB". Both therefore use the same subquery, and both
    // must run BEFORE the memories DELETE below empties that subquery's
    // source. (A row whose memory was hard-deleted by an earlier prune is
    // already orphaned and has no project_key to scope it by.)
    summary.memories_acl_deleted = db
      .prepare(
        'DELETE FROM memories_acl WHERE memory_id IN (SELECT id FROM memories WHERE project_key=?)',
      )
      .run(projectKey).changes;
    summary.persona_promotions_deleted = db
      .prepare(
        'DELETE FROM persona_promotions WHERE memory_id IN (SELECT id FROM memories WHERE project_key=?)',
      )
      .run(projectKey).changes;
    // skill_invocations carries project_key directly, so it is scoped like
    // working_memory / conversations.
    summary.skill_invocations_deleted = db
      .prepare('DELETE FROM skill_invocations WHERE project_key=?')
      .run(projectKey).changes;
    // The FTS5 mirror carries `id` but no column to scope a project by, so
    // it is swept with the same subquery as the two ACL / tier deletes
    // above — and, like them, before the memories DELETE empties the
    // subquery's source. The previous shape listed one placeholder per row,
    // which hits SQLite's 32766-variable ceiling on a large project: the
    // whole reset threw and rolled back, so `--confirm` could never succeed
    // even though the dry run did. One parameter now, however many rows.
    db.prepare(
      'DELETE FROM memories_fts WHERE id IN (SELECT id FROM memories WHERE project_key=?)',
    ).run(projectKey);
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
    // The conversation_events mirror is not touched by any other path, so
    // without this the archived rows stay searchable after the reset. It
    // carries project_key as an UNINDEXED column, so it is deletable
    // directly.
    db.prepare('DELETE FROM conversation_events_fts WHERE project_key=?').run(projectKey);
    summary.memory_edges_deleted = db
      .prepare('DELETE FROM memory_edges WHERE project_key=?')
      .run(projectKey).changes;
    summary.memory_synthesizes_deleted = db
      .prepare('DELETE FROM memory_synthesizes WHERE project_key=?')
      .run(projectKey).changes;
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

// Wipe per-project lifecycle log tables that the manual resetProject
// deliberately leaves in place (so the manual MCP tool keeps its
// audit trail). The auto-reset-on-reclone hook path calls this
// after resetProject so a re-cloned project lands at literally
// zero state: no memories, no dream_jobs, no dream_proposals, no
// consolidation_runs.
//
// Scope is strict: every DELETE matches project_key=? so a multi-
// project DB (and the future shared-DB design) keeps its sibling
// project rows intact. Throws on any error, and the deletes run inside
// one transaction so a failure leaves every row in place.
export function wipeProjectLifecycleLogs(db, projectKey) {
  if (!db || !projectKey) {
    throw new Error('wipeProjectLifecycleLogs: db and projectKey are required');
  }
  // Children before parents: dream_proposals.job_id REFERENCES
  // dream_jobs(id) and there is no ON DELETE CASCADE, so with
  // PRAGMA foreign_keys = ON (set on every open) deleting a job whose
  // proposals are still present raises FOREIGN KEY constraint failed.
  // consolidation_runs has no foreign key of its own but is wiped in the
  // same pass.
  db.exec('BEGIN');
  try {
    const proposals = db
      .prepare('DELETE FROM dream_proposals WHERE project_key=?')
      .run(projectKey).changes;
    const runs = db
      .prepare('DELETE FROM consolidation_runs WHERE project_key=?')
      .run(projectKey).changes;
    const jobs = db.prepare('DELETE FROM dream_jobs WHERE project_key=?').run(projectKey).changes;
    db.exec('COMMIT');
    return {
      dream_jobs_deleted: jobs,
      dream_proposals_deleted: proposals,
      consolidation_runs_deleted: runs,
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}
