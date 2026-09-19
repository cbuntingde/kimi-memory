// Reinforcement + decay (Ebbinghaus).
//
// Per-row "this memory helped" bumps (memory_reinforce) and the
// SessionStart decay pass that re-derives confidence from the
// stability / rehearsal-time curve.
import { nowIso } from '../util.js';
import { derivedConfidence, growStability } from '../decay.js';
import { getMemory } from './memories.js';

// ----- Importance + decay (signal-driven reinforcement) -----

// Single-row bump for "this memory helped". On top of the legacy
// +0.05 confidence nudge, this v9 update grows the row's stability
// (so the next decay pass demotes it more slowly) and stamps
// last_rehearsed_at (so the Ebbinghaus timer resets). The growth
// factor lives in src/decay.js so the formula has a single home.
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
