// Stop-path helpers: idempotent wire ingest, auto-GC throttling, and
// the auto-extract cost-guard chain.
//
// `safeHandleStop` is the shared snapshot ingest used by SessionStart,
// UserPromptSubmit, and Stop; the remaining helpers are Stop-specific.

import path from 'node:path';
import { nowIso } from '../../../util.js';
import {
  deriveProjectKey,
  ensureProjectDir,
  GLOBAL_PROJECT_KEY,
  globalDbPath,
} from '../../../project-key.js';
import {
  openDb,
  loadIngestState,
  saveIngestState,
  recordConversationEvent,
  updateConversationProgress,
  upsertConversation,
  recordProjectPath,
  saveMemory,
  searchMemories,
} from '../../../persist.js';
import { locateSessionArchive, walkWire, readSessionIndex } from '../../../wire.js';
import { runAutoExtract } from '../../../extract.js';
import { runAutoGc, runAutoTier } from '../../../auto-gc.js';
import {
  HOME,
  AUTO_GC_THROTTLE_HOURS,
  EXTRACT_MIN_EVENTS,
  EXTRACT_MAX_LATENCY_MS,
} from './constants.js';
import { payloadSessionId, logDiag } from './payload.js';

// ---- Snapshot ingest (shared by SessionStart / UserPromptSubmit / Stop) ----
//
// Idempotent wire.jsonl ingest. Used by every event that wants the
// project's archive to be up to date before reading from it.
export async function safeHandleStop(payload, cwd) {
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  const sessionId = payloadSessionId(payload);
  if (!sessionId) return { ok: true, skipped: 'no_session_id', session_id: null, project_key: key };
  const state = await loadIngestState(HOME, key);
  if (!state.sessions) state.sessions = {};
  const prev = state.sessions[sessionId] || {};
  let wdk = prev.work_dir_key || null;
  if (!wdk) {
    const idx = await readSessionIndex(HOME);
    const hit = idx.find(
      (e) => e && (e.sessionId === sessionId || e.session_id === sessionId || e.id === sessionId),
    );
    if (hit && (hit.work_dir_key || hit.workDirKey)) wdk = hit.work_dir_key || hit.workDirKey;
  }
  const archive = await locateSessionArchive(HOME, wdk, sessionId);
  if (!archive) {
    return {
      ok: true,
      skipped: 'archive_not_found',
      session_id: sessionId,
      work_dir_key: wdk,
      project_key: key,
    };
  }
  const db = openDb(path.join(HOME, 'kimi-memory', key, 'memory.sqlite'));
  if (cwd) recordProjectPath(db, key, cwd);
  upsertConversation(db, key, sessionId, cwd);
  const startByte = prev.byte_offset || 0;
  let lineNo = prev.line_count || 0;
  let lastEventAt = prev.last_event_at || null;
  let finalOffset = startByte;
  let newEvents = 0;
  const lineBase = lineNo;
  for await (const ev of walkWire(archive, startByte, lineBase)) {
    finalOffset = ev.nextByteOffset;
    lineNo = ev.lineNo;
    recordConversationEvent(db, key, sessionId, ev.lineNo, ev.byteOffset, ev);
    newEvents += 1;
    if (ev.created_at) lastEventAt = ev.created_at;
  }
  updateConversationProgress(db, key, sessionId, finalOffset, lineNo, lastEventAt);
  state.sessions[sessionId] = {
    work_dir_key: wdk,
    byte_offset: finalOffset,
    line_count: lineNo,
    last_event_at: lastEventAt,
    last_import_at: nowIso(),
  };
  await saveIngestState(HOME, key, state);
  return { ok: true, ingested: newEvents, session_id: sessionId, archive, project_key: key };
}

// Run auto-GC, with the heavy passes (prune + archive) gated on a
// per-project timestamp stored in schema_meta. Tier promotion runs
// every open. Wraps the read + bypass check + run + stamp in a single
// `BEGIN IMMEDIATE` so two SessionStart invocations cannot both run
// and double-stamp.
export function runAutoGcThrottled(db, projectKey) {
  if (!db || !projectKey) return { skipped: 'no_inputs' };
  if (process.env.KIMI_MEMORY_AUTO_GC === 'off') {
    return { skipped: 'env_opt_out' };
  }

  const now = new Date();
  const tier = runAutoTier(db, projectKey, { now });

  let prune = null;
  let archive = null;
  // Tracks whether *this* call opened the transaction. `BEGIN IMMEDIATE`
  // throws when the connection already has a transaction open, and a
  // blind ROLLBACK in the catch would then discard the caller's work.
  let began = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    began = true;
    let lastRun = null;
    try {
      const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('auto_gc_last_run');
      if (row && row.value) {
        const t = Date.parse(row.value);
        if (Number.isFinite(t)) lastRun = new Date(t);
      }
    } catch {
      /* missing — first run */
    }
    const throttleMs = AUTO_GC_THROTTLE_HOURS * 60 * 60 * 1000;
    const isThrottled = lastRun && now - lastRun < throttleMs;
    if (isThrottled) {
      prune = { skipped: 'throttled' };
      archive = { skipped: 'throttled' };
    } else {
      try {
        const r = runAutoGc(db, projectKey, { now });
        prune = r.prune || { skipped: 'no_db' };
        archive = r.archive || { skipped: 'no_db' };
        db.prepare(
          `INSERT INTO schema_meta (key, value) VALUES ('auto_gc_last_run', ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        ).run(new Date().toISOString());
      } catch (e) {
        prune = { error: e && e.message ? e.message : String(e) };
        archive = { error: e && e.message ? e.message : String(e) };
      }
    }
    db.exec('COMMIT');
    began = false;
  } catch (e) {
    if (began) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
    }
    prune = { error: e && e.message ? e.message : String(e) };
    archive = { error: e && e.message ? e.message : String(e) };
  }

  return { prune, archive, tier };
}

// ---- Auto-extract transcript helpers ----

// Build a short transcript from the most recent conversation events.
// Uses the pre-extracted `summary` field; falls back to a snippet of
// the raw payload for events that have no summary.
export function buildTranscript(db, projectKey, sessionId, { limit = 6 } = {}) {
  const rows = db
    .prepare(
      `
    SELECT role, summary, payload, kind, created_at
    FROM conversation_events
    WHERE project_key = ? AND session_id = ?
    ORDER BY line_no DESC LIMIT ?
  `,
    )
    .all(projectKey, sessionId, limit);
  rows.reverse();
  const out = [];
  for (const r of rows) {
    if (!r.summary) continue;
    const who =
      r.role === 'user'
        ? 'USER'
        : r.role === 'assistant'
          ? 'ASSISTANT'
          : (r.role || 'SYSTEM').toUpperCase();
    out.push(`${who}: ${r.summary}`);
  }
  return out.join('\n\n');
}

// Pull the most-recent event timestamp for the session. Used by the
// cost guard: if the latest exchange is older than EXTRACT_MAX_LATENCY_MS
// the user is no longer in flight, so we skip extraction.
export function latestEventAgeMs(db, projectKey, sessionId) {
  const row = db
    .prepare(
      `
    SELECT created_at FROM conversation_events
    WHERE project_key = ? AND session_id = ?
    ORDER BY line_no DESC LIMIT 1
  `,
    )
    .get(projectKey, sessionId);
  if (!row || !row.created_at) return Infinity;
  const t = Date.parse(row.created_at);
  if (!Number.isFinite(t)) return Infinity;
  return Date.now() - t;
}

// Triggered after the ingest pass. Cost guards:
//   - env opt-out (KIMI_MEMORY_AUTO_EXTRACT=off) → no-op
//   - session has fewer than EXTRACT_MIN_EVENTS events → skip
//   - latest event older than EXTRACT_MAX_LATENCY_MS → skip
export async function handleAutoExtract(cwd, sessionId) {
  if (!cwd || !sessionId) return { skipped: 'missing_cwd_or_session', saved: 0 };
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  const db = openDb(path.join(HOME, 'kimi-memory', key, 'memory.sqlite'));
  // Global DB is opened alongside the project DB so the auto-extract
  // dispatcher can route cross-project candidates to the right store.
  // The global DB may not exist on a fresh install — `openDb` is
  // called with the default create flag because `saveMemory` may need
  // to lazy-create it when the first global candidate lands. The
  // dispatcher itself tolerates a null handle: it treats the candidate
  // as a soft error rather than a save.
  let globalDb = null;
  try {
    globalDb = openDb(globalDbPath(HOME));
  } catch {
    globalDb = null;
  }
  try {
    const count = db
      .prepare(
        'SELECT COUNT(*) AS n FROM conversation_events WHERE project_key = ? AND session_id = ?',
      )
      .get(key, sessionId).n;
    if (count < EXTRACT_MIN_EVENTS) return { skipped: 'too_few_events', count };
    const age = latestEventAgeMs(db, key, sessionId);
    if (age > EXTRACT_MAX_LATENCY_MS) return { skipped: 'stale_session', age_ms: age };
    const transcript = buildTranscript(db, key, sessionId, { limit: 6 });
    if (!transcript) return { skipped: 'no_summary_text' };
    const existingTitles = db
      .prepare(
        "SELECT title FROM memories WHERE project_key = ? AND status = 'active' AND (title IS NOT NULL AND title != '') ORDER BY updated_at DESC LIMIT 50",
      )
      .all(key)
      .map((r) => r.title);
    const r = await runAutoExtract({
      homeDir: HOME,
      cwd,
      projectKey: key,
      db,
      globalDb,
      globalProjectKey: GLOBAL_PROJECT_KEY,
      transcript,
      existingTitles,
      saveMemory,
      searchMemories,
    });
    return r;
  } catch (e) {
    await logDiag('warn', 'auto_extract threw', { error: e && e.message });
    return { skipped: 'extract_threw', error: e && e.message };
  }
}
