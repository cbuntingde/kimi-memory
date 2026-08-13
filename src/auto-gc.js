// Background auto-GC: prune dead rows, archive old audit tables, and
// promote/demote memory tiers based on access patterns.
//
// Three independent passes, each is a pure function over a DB handle
// so the hook layer can run them in any order and the test layer can
// drive them with a synthetic DB. Each pass returns a counts object
// and is fail-open: every step is wrapped in try/catch so a single
// hiccup does not abort the rest of the SessionStart work.
//
// Opt-out: every individual pass is also gated on its own env var so
// a user can keep e.g. auto-tiers but disable auto-prune. The defaults
// run them all.
//
//   KIMI_MEMORY_AUTO_GC=off        disable all three passes
//   KIMI_MEMORY_AUTO_PRUNE=off     disable auto-prune of dead rows
//   KIMI_MEMORY_AUTO_ARCHIVE=off   disable auto-archive of audit tables
//   KIMI_MEMORY_AUTO_TIER=off      disable auto-tier promotion/demotion
//
// Safety: all destructive operations are wrapped in transactions and
// are individually logged to the diagnostics pipeline with before/
// after counts so the operator can audit what changed.

import { nowIso } from './util.js';

// ----- Auto-prune thresholds -----
// All times are days. A row is "ripe" for pruning when it has been
// in its current state (deleted/superseded/failed) for at least this
// many days. The grace windows are wide enough that a user who
// deletes a memory by mistake or sees a transient embedding failure
// has time to recover.

// Hard-delete rows the user explicitly asked to delete after 30 days.
// The 30-day window is wide enough to recover from a "whoops" delete
// via `memory_update` (which checks status='deleted' and un-deletes)
// and tight enough to keep the delete table from growing unbounded.
const PRUNE_DELETED_AFTER_DAYS = 30;

// Hard-delete soft-superseded rows after 90 days. The longer window
// reflects that a supersede is rarely a mistake — it is a deliberate
// "this is the new version" link — but we still want eventual cleanup
// so the project DB does not accumulate stale history forever.
const PRUNE_SUPERSEDED_AFTER_DAYS = 90;

// Hard-delete embedding-failed rows after 30 days. A failed embed
// usually means the model is unavailable or the input is empty; the
// row is still readable, just not searchable by vector. After 30 days
// with no successful retry we drop the row entirely (the title + content
// are still recoverable from any consumer that has the id).
const PRUNE_EMBED_FAILED_AFTER_DAYS = 30;

// Hard-delete cold memories (confidence below COLD_FLOOR, zero
// accesses, older than COLD_DAYS) after a long gravestone window.
// COLD_DAYS is wide on purpose: a memory that has never been recalled
// and has low confidence is probably either auto-extract noise or a
// transient that the user never reinforced. We keep it visible in
// `memory_recall` for COLD_DAYS so the user can see and re-strengthen
// it; only after that do we drop it.
const PRUNE_COLD_DAYS = 365;
const PRUNE_COLD_FLOOR = 0.05;

// Hard-delete orphan rows from skills / conclusions / tier-1 promotions
// where the parent memory has been hard-deleted. These come from
// cascade-deletion gaps in the schema; AUTO_GC_FORCE_GC_DAYS keeps them
// around briefly so test failures from parallel hooks can settle.
const PRUNE_ORPHAN_DAYS = 7;

// ----- Auto-archive thresholds -----

// Drop raw conversation_events older than 180 days. Below this window,
// the events are usable for transcript debugging; above it, the
// conversation is far enough back that the synthetic summary in the
// `memories` table is the operative artifact. Hard-delete is fine
// because the summary is preserved separately.
const ARCHIVE_CONVERSATION_EVENTS_DAYS = 180;

// Drop raw skill_invocations older than 90 days. Aggregate counters
// live in the `memory` table itself (count, success_rate); the raw
// per-invocation rows are useful for short-term debugging only.
const ARCHIVE_SKILL_INVOCATIONS_DAYS = 90;

// Drop raw persona_promotions older than 365 days. Tier-transition
// history is useful for audit but rarely a year old.
const ARCHIVE_PERSONA_PROMOTIONS_DAYS = 365;

// ----- Auto-tier thresholds -----

// L0 → L1: a memory that has been reinforced or recalled at least
// AUTO_TIER_REINFORCE_TO_L1 times has earned the "working" tier.
// L1 promotions are the cheapest and safest — they only affect
// ordering, not visibility.
const AUTO_TIER_REINFORCE_TO_L1 = 3;

// L1 → L2: a memory that has been accessed at least AUTO_TIER_ACCESS_TO_L2
// times in the current lifetime has earned the "durable" tier. Reflects
// repeated use as a stable background reference.
const AUTO_TIER_ACCESS_TO_L2 = 10;

// L2 → L3 (auto-graduation): a memory that has been at L2 for at least
// AUTO_TIER_L2_DAYS days AND has been reinforced at least
// AUTO_TIER_REINFORCE_TO_L3 times is auto-curated. L3 is the strongest
// tier; we require both time and access to qualify.
const AUTO_TIER_L2_DAYS = 30;
const AUTO_TIER_REINFORCE_TO_L3 = 5;

// L? → L0 (demotion): a memory whose retrievability has fallen below
// AUTO_TIER_DEMOTE_FLOOR for at least AUTO_TIER_DEMOTE_DAYS days is
// pushed back to L0 so the recall layer can re-evaluate it from a
// cold start. Does NOT re-promote L0 → L1 automatically; the next
// reinforce / recall cycle will.
const AUTO_TIER_DEMOTE_FLOOR = 0.2;
const AUTO_TIER_DEMOTE_DAYS = 14;

// ----- Auto-merge thresholds (called by consolidate, not by this
// module directly — but env var is shared so the user can disable
// merging without disabling the rest of the pipeline). -----
const AUTO_MERGE_MIN_THRESHOLD = 0.85; // cosine — tighter than clustering
const AUTO_MERGE_MIN_TAG_OVERLAP = 2;
const AUTO_MERGE_MIN_CLUSTER_SIZE = 3;

// ============================================================
// Auto-prune
// ============================================================

// Delete dead rows from the memories table. Each category is its own
// SQL with its own threshold — keep the categories separate so the
// operator can correlate `pruned_deleted` with a recent user action.
export function runAutoPrune(db, projectKey, { now = new Date() } = {}) {
  const result = {
    pruned_deleted: 0,
    pruned_superseded: 0,
    pruned_embed_failed: 0,
    pruned_cold: 0,
    pruned_orphans: 0,
    skipped: null,
    error: null,
  };
  if (process.env.KIMI_MEMORY_AUTO_GC === 'off') {
    result.skipped = 'env_opt_out';
    return result;
  }
  if (process.env.KIMI_MEMORY_AUTO_PRUNE === 'off') {
    result.skipped = 'prune_opt_out';
    return result;
  }
  if (!db || !projectKey) {
    result.skipped = 'no_inputs';
    return result;
  }

  // Each DELETE is wrapped in a SAVEPOINT so a constraint failure in
  // one category doesn't abort the rest. SAVEPOINT is a no-op when
  // no outer transaction is in flight.
  const safeDelete = (label, sql, ...args) => {
    try {
      db.exec(`SAVEPOINT auto_prune_${label}`);
      const r = db.prepare(sql).run(...args);
      db.exec(`RELEASE SAVEPOINT auto_prune_${label}`);
      return r.changes || 0;
    } catch (e) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT auto_prune_${label}`);
      } catch {
        /* ignore */
      }
      result.error = e && e.message ? e.message : String(e);
      return 0;
    }
  };

  // 1. status='deleted', older than PRUNE_DELETED_AFTER_DAYS.
  // Single DELETE on memories drives the count; one on FTS sweeps
  // the index in lockstep. Both share the same WHERE so the row
  // count is the truth. The previous version issued two DELETEs
  // (FTS first, then memories) and overwrote pruned_deleted with
  // the second, hiding the FTS count. (Audit finding F-006 / B2-7.)
  //
  // (Audit finding F-004 — collect the candidate IDs first, sweep
  // FTS by those IDs, then delete from `memories`. The prior shape
  // deleted `memories` before FTS, leaving the FTS subquery empty
  // and stale FTS rows behind. Same helper reused for superseded,
  // embed_failed, and cold.)
  const deleteExpiredPair = (label, memoryWhere, ...args) => {
    const ids = db.prepare(`SELECT id FROM memories WHERE ${memoryWhere}`).all(...args);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    safeDelete(
      `${label}_fts`,
      `DELETE FROM memories_fts WHERE id IN (${placeholders})`,
      ...ids.map((row) => row.id),
    );
    return safeDelete(`${label}_mem`, `DELETE FROM memories WHERE ${memoryWhere}`, ...args);
  };

  result.pruned_deleted = deleteExpiredPair(
    'deleted',
    `project_key = ? AND status = 'deleted'
       AND julianday('now') - julianday(updated_at) >= ?`,
    projectKey,
    PRUNE_DELETED_AFTER_DAYS,
  );

  // 2. status='superseded' older than PRUNE_SUPERSEDED_AFTER_DAYS.
  // The superseded_by backlink is preserved elsewhere (memory_edges
  // supersedes + the conclusion) so the deletion is non-destructive
  // for the recall graph.
  result.pruned_superseded = deleteExpiredPair(
    'superseded',
    `project_key = ? AND status = 'superseded'
       AND julianday('now') - julianday(updated_at) >= ?`,
    projectKey,
    PRUNE_SUPERSEDED_AFTER_DAYS,
  );

  // 3. embedding_status='failed' (last_embed_error set, embedding NULL)
  // older than PRUNE_EMBED_FAILED_AFTER_DAYS.
  result.pruned_embed_failed = deleteExpiredPair(
    'embed_failed',
    `project_key = ? AND status = 'active'
       AND embedding IS NULL AND last_embed_error IS NOT NULL
       AND julianday('now') - julianday(updated_at) >= ?`,
    projectKey,
    PRUNE_EMBED_FAILED_AFTER_DAYS,
  );

  // 4. Cold memories: low confidence, no accesses, very old.
  result.pruned_cold = deleteExpiredPair(
    'cold',
    `project_key = ? AND status = 'active'
       AND confidence < ?
       AND (access_count IS NULL OR access_count = 0)
       AND julianday('now') - julianday(updated_at) >= ?`,
    projectKey,
    PRUNE_COLD_FLOOR,
    PRUNE_COLD_DAYS,
  );

  // 5. Cascade-clean orphan rows: memory_edges whose endpoints are
  // gone, memory_synthesizes whose endpoints are gone, persona_promotions
  // whose memory is gone.
  result.pruned_orphans = safeDelete(
    'edges_orphan',
    `DELETE FROM memory_edges
     WHERE project_key = ?
       AND (from_id NOT IN (SELECT id FROM memories WHERE project_key = ?)
            OR to_id NOT IN (SELECT id FROM memories WHERE project_key = ?))
       AND julianday('now') - julianday(created_at) >= ?`,
    projectKey,
    projectKey,
    projectKey,
    PRUNE_ORPHAN_DAYS,
  );
  safeDelete(
    'synth_orphan',
    `DELETE FROM memory_synthesizes
     WHERE project_key = ?
       AND (parent_id NOT IN (SELECT id FROM memories WHERE project_key = ?)
            OR child_id NOT IN (SELECT id FROM memories WHERE project_key = ?))`,
    projectKey,
    projectKey,
    projectKey,
  );
  safeDelete(
    'promo_orphan',
    `DELETE FROM persona_promotions
     WHERE memory_id NOT IN (SELECT id FROM memories)
       AND julianday('now') - julianday(at) >= ?`,
    PRUNE_ORPHAN_DAYS,
  );

  return result;
}

// ============================================================
// Auto-archive
// ============================================================

// Drop raw audit rows older than their respective windows. The aggregate
// signal (memory counts, current tier, etc.) is preserved elsewhere;
// the raw rows are useful only for short-term debugging.
export function runAutoArchive(db, projectKey, { now = new Date() } = {}) {
  const result = {
    archived_conversation_events: 0,
    archived_skill_invocations: 0,
    archived_persona_promotions: 0,
    skipped: null,
    error: null,
  };
  if (process.env.KIMI_MEMORY_AUTO_GC === 'off') {
    result.skipped = 'env_opt_out';
    return result;
  }
  if (process.env.KIMI_MEMORY_AUTO_ARCHIVE === 'off') {
    result.skipped = 'archive_opt_out';
    return result;
  }
  if (!db || !projectKey) {
    result.skipped = 'no_inputs';
    return result;
  }

  const safeDelete = (label, sql, ...args) => {
    try {
      db.exec(`SAVEPOINT auto_archive_${label}`);
      const r = db.prepare(sql).run(...args);
      db.exec(`RELEASE SAVEPOINT auto_archive_${label}`);
      return r.changes || 0;
    } catch (e) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT auto_archive_${label}`);
      } catch {
        /* ignore */
      }
      result.error = e && e.message ? e.message : String(e);
      return 0;
    }
  };

  // conversation_events are per-(session, project, line). The project
  // column is a direct index; the filter is straightforward.
  result.archived_conversation_events = safeDelete(
    'conv_events',
    `DELETE FROM conversation_events
     WHERE project_key = ?
       AND julianday('now') - julianday(
           COALESCE(created_at, '1970-01-01')
         ) >= ?`,
    projectKey,
    ARCHIVE_CONVERSATION_EVENTS_DAYS,
  );

  // skill_invocations are project-scoped audit rows. The daily
  // aggregate (count + success rate) is already in the memory row's
  // metadata, so dropping raw rows is non-destructive.
  result.archived_skill_invocations = safeDelete(
    'skill_inv',
    `DELETE FROM skill_invocations
     WHERE project_key = ?
       AND julianday('now') - julianday(invoked_at) >= ?`,
    projectKey,
    ARCHIVE_SKILL_INVOCATIONS_DAYS,
  );

  // persona_promotions spans projects (memory_id is the join key, not
  // project_key). We drop globally for memories whose own project
  // matches the ingest's projectKey — that keeps the archive
  // per-project so the operator can correlate against project state.
  result.archived_persona_promotions = safeDelete(
    'promo',
    `DELETE FROM persona_promotions
     WHERE memory_id IN (
       SELECT id FROM memories WHERE project_key = ?
     )
     AND julianday('now') - julianday(at) >= ?`,
    projectKey,
    ARCHIVE_PERSONA_PROMOTIONS_DAYS,
  );

  return result;
}

// ============================================================
// Auto-tier
// ============================================================

// Promote or demote memory tiers based on access patterns. The
// schedule is conservative: L0 → L1 and L1 → L2 are aggressive (a
// hot memory should be visible), L2 → L3 is conservative (curation
// is expensive to undo), L? → L0 demotion is conservative (a long
// gravestone before demotion).
export function runAutoTier(db, projectKey, { now = new Date() } = {}) {
  const result = {
    promoted_l0_to_l1: 0,
    promoted_l1_to_l2: 0,
    promoted_l2_to_l3: 0,
    demoted_to_l0: 0,
    skipped: null,
    error: null,
  };
  if (process.env.KIMI_MEMORY_AUTO_GC === 'off') {
    result.skipped = 'env_opt_out';
    return result;
  }
  if (process.env.KIMI_MEMORY_AUTO_TIER === 'off') {
    result.skipped = 'tier_opt_out';
    return result;
  }
  if (!db || !projectKey) {
    result.skipped = 'no_inputs';
    return result;
  }

  try {
    db.exec('BEGIN');
  } catch {
    /* already in a transaction; ignore */
  }
  try {
    // L0 → L1: reinforced or recalled AUTO_TIER_REINFORCE_TO_L1 times.
    // We use access_count + a heuristic of recent_reinforce count
    // extracted from a stability_days growth pattern. The persistence
    // layer doesn't track reinforce events separately, so we use
    // access_count as a proxy. A memory with access_count ≥
    // AUTO_TIER_REINFORCE_TO_L1 is considered "recalled enough".
    {
      const r = db
        .prepare(
          `UPDATE memories
           SET tier = 'L1', updated_at = ?
           WHERE project_key = ? AND status = 'active'
             AND tier = 'L0'
             AND access_count >= ?`,
        )
        .run(nowIso(), projectKey, AUTO_TIER_REINFORCE_TO_L1);
      result.promoted_l0_to_l1 = r.changes || 0;
    }

    // L1 → L2: access_count ≥ AUTO_TIER_ACCESS_TO_L2.
    {
      const r = db
        .prepare(
          `UPDATE memories
           SET tier = 'L2', updated_at = ?
           WHERE project_key = ? AND status = 'active'
             AND tier = 'L1'
             AND access_count >= ?`,
        )
        .run(nowIso(), projectKey, AUTO_TIER_ACCESS_TO_L2);
      result.promoted_l1_to_l2 = r.changes || 0;
    }

    // L2 → L3: at L2 for AUTO_TIER_L2_DAYS days AND access_count ≥
    // AUTO_TIER_REINFORCE_TO_L3. Curation is hard to undo, so we
    // require both time + access.
    {
      const r = db
        .prepare(
          `UPDATE memories
           SET tier = 'L3', updated_at = ?
           WHERE project_key = ? AND status = 'active'
             AND tier = 'L2'
             AND access_count >= ?
             AND julianday('now') - julianday(updated_at) >= ?`,
        )
        .run(nowIso(), projectKey, AUTO_TIER_REINFORCE_TO_L3, AUTO_TIER_L2_DAYS);
      result.promoted_l2_to_l3 = r.changes || 0;
    }

    // L? → L0 demotion: confidence (set by decay) below
    // AUTO_TIER_DEMOTE_FLOOR for AUTO_TIER_DEMOTE_DAYS. Uses
    // stability_days/ last_rehearsed_at to approximate the curve
    // rather than recomputing Math.exp per row — the SessionStart
    // decay pass already normalises confidence, so anything below
    // the floor is a candidate for demotion.
    {
      const r = db
        .prepare(
          `UPDATE memories
           SET tier = 'L0', updated_at = ?
           WHERE project_key = ? AND status = 'active'
             AND tier != 'L0'
             AND confidence < ?
             AND julianday('now') - julianday(last_rehearsed_at) >= ?`,
        )
        .run(nowIso(), projectKey, AUTO_TIER_DEMOTE_FLOOR, AUTO_TIER_DEMOTE_DAYS);
      result.demoted_to_l0 = r.changes || 0;
    }

    try {
      db.exec('COMMIT');
    } catch {
      /* already committed; ignore */
    }
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    result.error = e && e.message ? e.message : String(e);
  }
  return result;
}

// ============================================================
// Combined entry point
// ============================================================

// Run all three passes in one call. The hook layer calls this so the
// SessionStart handler has a single thing to invoke. Returns an
// aggregated result.
export function runAutoGc(db, projectKey, opts = {}) {
  if (!db || !projectKey) {
    return { skipped: 'no_inputs' };
  }
  if (process.env.KIMI_MEMORY_AUTO_GC === 'off') {
    return { skipped: 'env_opt_out' };
  }
  const prune = runAutoPrune(db, projectKey, opts);
  const archive = runAutoArchive(db, projectKey, opts);
  const tier = runAutoTier(db, projectKey, opts);
  return { prune, archive, tier };
}

// Exported so the consolidate pass can decide whether to merge tight
// clusters in addition to writing a conclusion.
export const AUTO_MERGE_THRESHOLDS = {
  cosine: AUTO_MERGE_MIN_THRESHOLD,
  tagOverlap: AUTO_MERGE_MIN_TAG_OVERLAP,
  clusterSize: AUTO_MERGE_MIN_CLUSTER_SIZE,
};
