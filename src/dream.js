// Phase-1 staged Dream consolidation.
//
// The lifecycle hook layer (src/hooks/run.js) enqueues a Dream job
// after Stop / SessionEnd once the project's activity threshold and
// the debounce window both allow. A job is durable: it lives in the
// `dream_jobs` table until it is applied, cancelled, or marked stale.
//
// Lifecycle:
//   queued → running → ready → applied (or stale / failed / cancelled)
//
// `running` is exclusive per-project: a partial unique index
// (`idx_dream_jobs_active`) enforces "one running job per project"
// at the SQL layer, so a concurrent enqueue is a no-op rather than a
// crash. The SessionStart hook opportunistically drives one ready →
// applied cycle inside its 8s budget; everything else goes through
// `applyDreamJob` / `discardDreamJob` so the operator is always in
// the loop.
//
// Safety: apply runs every proposed write inside a single SAVEPOINT so
// a mid-flight crash leaves the project DB untouched. Each proposal is
// re-validated against the live rows (status='active', checksum
// unchanged, ids intact); anything stale is marked `status='stale'`
// and skipped instead of being applied.
//
// Project scope only: this module is intentionally never called with
// the global project key. There is no global-memory Dream surface in
// Phase 1 — the global store stays curated by the user via MCP /
// `memory_save`.
import { nowIso, hashId, shortId, safeJsonParse } from './util.js';
import { runConsolidate, proposalSourceChecksum } from './consolidate.js';
import { decodeVector as decodeEmbedding } from './embedding.js';
import { linkMemory } from './persist/edges.js';

// Tunables (env-overridable so tests + operators can dial them).
// Defaults are conservative: short debounce so a busy session can keep
// up with new activity, modest cap on proposal count so a runaway
// project does not pin the SessionStart hook.
const DEFAULT_DEBOUNCE_MS = 30 * 60 * 1000; // 30 minutes between Dream runs
const DEFAULT_ACTIVITY_MIN = 4; // need >=N new events in the window to enqueue
const DEFAULT_PROPOSAL_CAP = 32; // hard cap on persisted proposals per job
const DEFAULT_AUTO_APPLY_CONFIDENCE = 0.85; // auto-apply proposals with confidence >= this

function debounceMs() {
  const raw = Number(process.env.KIMI_MEMORY_DREAM_DEBOUNCE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DEBOUNCE_MS;
}
function activityMin() {
  const raw = Number(process.env.KIMI_MEMORY_DREAM_ACTIVITY_MIN);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : DEFAULT_ACTIVITY_MIN;
}
function proposalCap() {
  const raw = Number(process.env.KIMI_MEMORY_DREAM_PROPOSAL_CAP);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : DEFAULT_PROPOSAL_CAP;
}
function autoApplyConfidence() {
  const raw = Number(process.env.KIMI_MEMORY_DREAM_AUTO_APPLY_CONFIDENCE);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_AUTO_APPLY_CONFIDENCE;
}

// Master opt-out. Set KIMI_MEMORY_DREAM=off to disable the entire
// pipeline (enqueue + apply). Individual phases are also gated below.
function dreamOptOut() {
  return process.env.KIMI_MEMORY_DREAM === 'off';
}

// Generate a stable, time-ordered id for a job. The ms-suffix lets the
// dashboard read the queue order without an extra column. A monotonic
// counter breaks ties when two enqueues land in the same millisecond
// (the hook layer runs them back-to-back on a busy project).
let jobIdCounter = 0;
function newJobId(projectKey, now = nowIso()) {
  const seq = ++jobIdCounter;
  return shortId(hashId('dream-job', projectKey, now, String(seq)), 16);
}
function newProposalId(jobId, kind, n) {
  return shortId(hashId('dream-prop', jobId, kind, n), 16);
}

// Cheap snapshot of the project state at enqueue time. Stored on the
// job so apply can detect "inputs drifted" without re-walking the
// entire memory table.
function buildInputSnapshot(db, projectKey) {
  let memoryCount = 0;
  let activeCount = 0;
  let recentSessions = 0;
  try {
    memoryCount = db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key=?')
      .get(projectKey).n;
    activeCount = db
      .prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND status='active' AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))",
      )
      .get(projectKey).n;
    recentSessions = db
      .prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_key=?')
      .get(projectKey).n;
  } catch {
    /* DB read failures are non-fatal; the snapshot stays empty */
  }
  return {
    captured_at: nowIso(),
    memory_count: memoryCount,
    active_count: activeCount,
    recent_sessions: recentSessions,
  };
}

// Persisted enqueue. Returns { status, job, reason } where status is
// one of 'enqueued', 'throttled', 'duplicate', 'opt_out', 'error'.
// Idempotent: re-enqueueing while a `running` job exists for the
// project is a no-op (the partial unique index trips first; we
// catch it here). A previously `ready` job is returned as `duplicate`
// so the caller can skip re-generation.
export function enqueueDreamJob(db, projectKey, opts = {}) {
  if (!db || !projectKey) return { status: 'error', reason: 'no_inputs' };
  if (dreamOptOut()) return { status: 'opt_out', reason: 'env_opt_out' };

  const now = nowIso();
  try {
    // Bail early if a job is already running for this project.
    const existing = db
      .prepare(
        "SELECT id, status FROM dream_jobs WHERE project_key=? AND status IN ('queued','running','ready') ORDER BY updated_at DESC LIMIT 1",
      )
      .get(projectKey);
    if (existing) {
      if (existing.status === 'running') return { status: 'duplicate', job_id: existing.id };
      if (existing.status === 'queued' || existing.status === 'ready') {
        return { status: 'duplicate', job_id: existing.id };
      }
    }

    const jobId = newJobId(projectKey, now);
    const snapshot = opts.snapshot || buildInputSnapshot(db, projectKey);
    db.prepare(
      `INSERT INTO dream_jobs (id, project_key, status, triggered_by, input_snapshot, result_counts, enqueued_at, updated_at)
       VALUES (?, ?, 'queued', ?, ?, '{}', ?, ?)`,
    ).run(jobId, projectKey, opts.triggered_by || 'lifecycle', JSON.stringify(snapshot), now, now);
    return { status: 'enqueued', job_id: jobId, snapshot };
  } catch (e) {
    // The partial unique index can fire if a concurrent enqueue raced
    // us. Treat that as a duplicate so callers can move on.
    if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { status: 'duplicate', reason: 'unique_active_index' };
    }
    return { status: 'error', reason: e && e.message ? e.message : String(e) };
  }
}

// Should the lifecycle hook enqueue right now? Encapsulates the
// "enough new activity + debounce window elapsed" gate so callers do
// not duplicate the policy. Returns { enqueue, reason }.
export function shouldEnqueue(db, projectKey, { lastEnqueuedAt = null, eventCount = 0 } = {}) {
  if (dreamOptOut()) return { enqueue: false, reason: 'env_opt_out' };
  if (!db || !projectKey) return { enqueue: false, reason: 'no_inputs' };
  const min = activityMin();
  if (eventCount > 0 && eventCount < min) {
    return { enqueue: false, reason: 'below_activity_min', activity_min: min };
  }
  const debounce = debounceMs();
  if (lastEnqueuedAt) {
    const t = Date.parse(lastEnqueuedAt);
    if (Number.isFinite(t) && Date.now() - t < debounce) {
      return { enqueue: false, reason: 'throttled', debounce_ms: debounce };
    }
  }
  return { enqueue: true };
}

// Read the most-recent enqueue timestamp for the project. Cheap —
// a single-row lookup against idx_dream_jobs_project. null when no
// prior job exists.
export function lastDreamEnqueuedAt(db, projectKey) {
  if (!db || !projectKey) return null;
  try {
    const row = db
      .prepare(
        'SELECT enqueued_at FROM dream_jobs WHERE project_key=? ORDER BY datetime(enqueued_at) DESC LIMIT 1',
      )
      .get(projectKey);
    return row ? row.enqueued_at : null;
  } catch {
    return null;
  }
}

// Generate proposals for a queued job. Marks the job `ready` and
// persists the proposal rows. Re-runs against an already-ready job
// are no-ops via the status guard. Returns the consolidate result
// object so callers can surface counts.
//
// db is the project DB. saveMemory / memoryLink / mergeMemory are
// injected so tests can stub them; default to the real implementations.
export async function generateProposalsForJob(
  db,
  projectKey,
  jobId,
  {
    saveMemory,
    memoryLink,
    mergeMemory,
    decodeEmbeddingImpl = decodeEmbedding,
    now = nowIso(),
  } = {},
) {
  if (!db || !projectKey || !jobId) {
    return { ok: false, reason: 'no_inputs' };
  }

  const job = readJob(db, projectKey, jobId);
  if (!job) return { ok: false, reason: 'not_found' };
  if (job.status === 'applied') return { ok: false, reason: 'already_applied' };
  if (job.status === 'cancelled') return { ok: false, reason: 'cancelled' };

  // Mark `running` so a concurrent generate is a no-op. The partial
  // unique index catches cross-process races; the status guard above
  // catches in-process re-runs.
  try {
    db.prepare(
      "UPDATE dream_jobs SET status='running', started_at=?, updated_at=? WHERE id=? AND project_key=?",
    ).run(now, now, jobId, projectKey);
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }

  // Reuse the deterministic consolidate logic in proposal mode. The
  // live memories table is untouched — proposals are written to
  // `dream_proposals` instead.
  const cap = proposalCap();
  let result;
  try {
    result = await runConsolidate({
      db,
      projectKey,
      // proposal mode does not require saveMemory/link/mergeMemory
      saveMemory,
      memoryLink,
      mergeMemory,
      decodeEmbeddingImpl,
      mode: 'proposal',
    });
  } catch (e) {
    markJobFailed(db, projectKey, jobId, e && e.message ? e.message : String(e));
    return { ok: false, reason: 'consolidate_threw', error: e && e.message };
  }

  const all = Array.isArray(result.proposals) ? result.proposals : [];
  // Persist a bounded number of proposals. Cap protects the project
  // DB against runaway projects.
  const accepted = all.slice(0, cap);
  const dropped = all.length - accepted.length;

  let proposalIds = [];
  try {
    db.exec('SAVEPOINT dream_proposals_insert');
    const insertStmt = db.prepare(
      `INSERT INTO dream_proposals (id, job_id, project_key, kind, source_ids, target_ids, proposed_content, confidence, provenance, source_checksum, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    );
    for (let i = 0; i < accepted.length; i++) {
      const p = accepted[i];
      const id = newProposalId(jobId, p.kind, i);
      // Carry title + tags inside `proposed_content` is impractical
      // (proposed_content holds body), so we stash the title/tags in
      // the provenance JSON for the apply step. This keeps the schema
      // additive without a column change.
      const provenanceBlob = {
        ...(p.provenance || {}),
        proposed_title: p.proposed_title || '',
        proposed_tags: p.proposed_tags || [],
        proposed_kind: p.provenance?.proposed_kind || p.kind,
      };
      insertStmt.run(
        id,
        jobId,
        projectKey,
        p.kind,
        JSON.stringify(p.source_ids || []),
        JSON.stringify(p.target_ids || []),
        p.proposed_content || '',
        p.confidence ?? 0.7,
        JSON.stringify(provenanceBlob),
        p.source_checksum || '',
        now,
        now,
      );
      proposalIds.push(id);
    }
    db.exec('RELEASE dream_proposals_insert');
  } catch (e) {
    try {
      db.exec('ROLLBACK TO dream_proposals_insert');
    } catch {
      /* ignore */
    }
    markJobFailed(db, projectKey, jobId, e && e.message ? e.message : String(e));
    return { ok: false, reason: 'persist_threw', error: e && e.message };
  }

  const resultCounts = {
    scanned: result.scanned || 0,
    clusters: result.clusters || 0,
    proposals_total: all.length,
    proposals_persisted: accepted.length,
    proposals_dropped: dropped,
    saved: result.saved || 0,
    skipped: result.skipped || 0,
    errors: result.errors || 0,
    merged: result.merged || 0,
    mergeSkipped: result.mergeSkipped || 0,
  };

  try {
    db.prepare(
      "UPDATE dream_jobs SET status='ready', ready_at=?, result_counts=?, updated_at=? WHERE id=? AND project_key=?",
    ).run(now, JSON.stringify(resultCounts), now, jobId, projectKey);
  } catch (e) {
    markJobFailed(db, projectKey, jobId, e && e.message ? e.message : String(e));
    return { ok: false, reason: 'finalize_threw', error: e && e.message };
  }

  return {
    ok: true,
    job_id: jobId,
    proposal_ids: proposalIds,
    result_counts: resultCounts,
    consolidate: result,
  };
}

function markJobFailed(db, projectKey, jobId, message) {
  try {
    db.prepare(
      "UPDATE dream_jobs SET status='failed', error=?, updated_at=? WHERE id=? AND project_key=?",
    ).run(String(message).slice(0, 500), nowIso(), jobId, projectKey);
  } catch {
    /* swallow — best-effort */
  }
}

// Apply a ready job. Validates each proposal against the live rows
// (status='active', id intact, source_checksum matches), then writes
// the conclusions / edges / merges inside a single SAVEPOINT. Stale
// proposals are flipped to status='stale' and skipped.
//
// Returns { ok, applied, stale, failed, error } where each count
// names a proposal class. Empty job (no pending proposals) is a
// no-op success.
export function applyDreamJob(db, projectKey, jobId, opts = {}) {
  if (!db || !projectKey || !jobId) return { ok: false, reason: 'no_inputs' };
  const job = readJob(db, projectKey, jobId);
  if (!job) return { ok: false, reason: 'not_found' };
  if (job.status !== 'ready') return { ok: false, reason: 'not_ready', status: job.status };

  const proposals = listProposals(db, projectKey, jobId, { status: 'pending' });
  if (proposals.length === 0) {
    // Nothing to do — mark applied so the lifecycle can move on.
    const now = nowIso();
    try {
      db.prepare(
        "UPDATE dream_jobs SET status='applied', applied_at=?, updated_at=? WHERE id=? AND project_key=?",
      ).run(now, now, jobId, projectKey);
    } catch {
      /* swallow */
    }
    return { ok: true, applied: 0, stale: 0, failed: 0 };
  }

  // Optional auto-apply: proposals above the confidence floor apply
  // immediately; everything else stays pending for an explicit call.
  const floor = typeof opts.autoApplyConfidence === 'number' ? opts.autoApplyConfidence : null;

  const saveMemory = opts.saveMemory;
  const memoryLink = opts.memoryLink;
  const mergeMemory = opts.mergeMemory;
  const now = nowIso();
  let applied = 0;
  let stale = 0;
  let failed = 0;

  db.exec('SAVEPOINT dream_apply');
  try {
    // Build a checksum → full cluster source map so a link proposal's
    // checksum (computed against the cluster, not the single child)
    // validates correctly. Without this map, the link proposal would
    // be flagged stale because its source_ids only contains the
    // single child id.
    const checksumClusters = new Map();
    for (const p of proposals) {
      if (!checksumClusters.has(p.source_checksum)) {
        checksumClusters.set(p.source_checksum, new Set(p.source_ids));
      } else {
        for (const id of p.source_ids) checksumClusters.get(p.source_checksum).add(id);
      }
    }

    for (const p of proposals) {
      // Auto-apply gate: skip proposals that don't meet the floor.
      if (floor != null && (p.confidence || 0) < floor) continue;

      // Resolve source rows. The "cluster" used for the checksum is
      // every distinct source id across every proposal that shares the
      // same source_checksum — otherwise a single-child proposal would
      // never validate against a multi-child cluster checksum.
      const clusterIds = [...(checksumClusters.get(p.source_checksum) || new Set())];
      const clusterRows = clusterIds.map((id) => rowById(db, projectKey, id)).filter(Boolean);
      if (clusterRows.length !== clusterIds.length) {
        markProposal(db, p.id, projectKey, 'stale', now);
        stale += 1;
        continue;
      }

      // Re-derive the source checksum across the full cluster; mismatch
      // → stale.
      const liveChecksum = proposalSourceChecksum(
        clusterRows.map((r) => ({
          id: r.id,
          updatedAt: r.updated_at,
        })),
      );
      if (liveChecksum !== p.source_checksum) {
        markProposal(db, p.id, projectKey, 'stale', now);
        stale += 1;
        continue;
      }

      // All cluster rows must still be active. If any drifted to
      // superseded / deleted, the cluster is unsafe to synthesise.
      const stillActive = clusterRows.every((r) => r.status === 'active');
      if (!stillActive) {
        markProposal(db, p.id, projectKey, 'stale', now);
        stale += 1;
        continue;
      }

      try {
        const appliedFlag = applyProposal(db, projectKey, jobId, p, {
          saveMemory,
          memoryLink,
          mergeMemory,
        });
        if (appliedFlag === 'ok') {
          markProposal(db, p.id, projectKey, 'applied', now);
          applied += 1;
        } else {
          markProposal(db, p.id, projectKey, 'rejected', now);
          failed += 1;
        }
      } catch (e) {
        // Per-proposal failure: mark stale so the lifecycle can
        // re-enqueue a fresh job without looping on the same row.
        markProposal(db, p.id, projectKey, 'stale', now);
        failed += 1;
      }
    }
    db.exec('RELEASE dream_apply');
  } catch (e) {
    try {
      db.exec('ROLLBACK TO dream_apply');
    } catch {
      /* ignore */
    }
    markJobFailed(db, projectKey, jobId, e && e.message ? e.message : String(e));
    return { ok: false, reason: 'apply_threw', error: e && e.message };
  }

  // Mark the job applied when every pending proposal is settled.
  const remaining = listProposals(db, projectKey, jobId, { status: 'pending' });
  try {
    db.prepare(
      "UPDATE dream_jobs SET status='applied', applied_at=?, updated_at=? WHERE id=? AND project_key=?",
    ).run(now, now, jobId, projectKey);
  } catch {
    /* best-effort */
  }

  return {
    ok: true,
    applied,
    stale,
    failed,
    remaining: remaining.length,
    auto_apply_floor: floor,
  };
}

function rowById(db, projectKey, id) {
  try {
    return (
      db
        .prepare('SELECT id, status, updated_at FROM memories WHERE id=? AND project_key=?')
        .get(id, projectKey) || null
    );
  } catch {
    return null;
  }
}

function markProposal(db, proposalId, projectKey, status, now) {
  try {
    db.prepare(
      'UPDATE dream_proposals SET status=?, updated_at=? WHERE id=? AND project_key=?',
    ).run(status, now, proposalId, projectKey);
  } catch {
    /* best-effort */
  }
}

// Apply one proposal. The conclusion / merge / link branches each
// delegate to the same persist-layer primitives runConsolidate uses
// in direct mode, so the on-disk shape is identical.
function applyProposal(db, projectKey, jobId, proposal, deps) {
  const { saveMemory, memoryLink, mergeMemory } = deps;
  const provenance = proposal.provenance || {};
  const title = provenance.proposed_title || '';
  const tags = Array.isArray(provenance.proposed_tags) ? provenance.proposed_tags : [];
  const clusterSize = (provenance.cluster_size || proposal.source_ids.length) + 0;

  if (proposal.kind === 'conclusion') {
    if (!saveMemory) return 'reject';
    const row = saveMemory(db, projectKey, {
      type: 'conclusion',
      title: title || 'Synthesis',
      content: proposal.proposed_content || '',
      tags,
      confidence: proposal.confidence || 0.7,
      priority: 0,
      provenance: {
        ...provenance,
        source: 'dream_apply',
        job_id: jobId,
        cluster_size: clusterSize,
        applied_at: nowIso(),
      },
      synthesizes: proposal.source_ids.slice(),
      _embed: false,
    });
    if (!row || !row.id) return 'reject';
    return 'ok';
  }

  if (proposal.kind === 'link') {
    if (!memoryLink) return 'reject';
    // The synthesizes-link proposal carries only a source id; the
    // conclusion id is resolved by walking the live memories table for
    // an active `conclusion` row that already covers the cluster. The
    // conclusion was inserted by an earlier proposal in the same
    // apply pass and carries `provenance.job_id` (set on apply) plus
    // `provenance.child_ids` (the cluster sources). Match the link's
    // single source id against that child_ids list.
    let targetId = null;
    try {
      const candidates = db
        .prepare(
          "SELECT id, provenance FROM memories WHERE project_key=? AND type='conclusion' AND status='active'",
        )
        .all(projectKey);
      const sourceId = proposal.source_ids && proposal.source_ids[0];
      for (const c of candidates) {
        let prov = {};
        try {
          prov = JSON.parse(c.provenance || '{}');
        } catch {
          prov = {};
        }
        if (prov.job_id !== jobId) continue;
        if (!Array.isArray(prov.child_ids)) continue;
        if (sourceId && prov.child_ids.includes(sourceId)) {
          targetId = c.id;
          break;
        }
      }
    } catch {
      /* fall through to reject */
    }
    if (!targetId) return 'reject';
    try {
      memoryLink(db, projectKey, proposal.source_ids[0], targetId, 'synthesizes', {
        weight: 1.0,
      });
      return 'ok';
    } catch {
      return 'reject';
    }
  }

  if (proposal.kind === 'merge') {
    if (!mergeMemory) return 'reject';
    const targetId = proposal.target_ids && proposal.target_ids[0];
    if (!targetId) return 'reject';
    // Soft-supersede each non-target sibling into the target. Order
    // does not matter — mergeMemory is non-destructive and idempotent
    // for repeated merges of the same pair.
    let ok = true;
    for (const sid of proposal.source_ids) {
      if (sid === targetId) continue;
      try {
        mergeMemory(db, projectKey, targetId, sid, {
          mergedContent: proposal.proposed_content || '',
          weight: 1.0,
        });
      } catch {
        ok = false;
      }
    }
    return ok ? 'ok' : 'reject';
  }

  if (proposal.kind === 'supersede') {
    if (!linkMemory) return 'reject';
    if (
      !proposal.target_ids ||
      proposal.target_ids.length !== 1 ||
      proposal.source_ids.length !== 1
    ) {
      return 'reject';
    }
    try {
      linkMemory(db, projectKey, proposal.source_ids[0], proposal.target_ids[0], 'supersedes', {
        weight: proposal.confidence || 1.0,
      });
      return 'ok';
    } catch {
      return 'reject';
    }
  }

  return 'reject';
}

// Cancel / discard a queued or ready job. Proposals are marked
// rejected so re-enqueue is clean. Returns { ok, reason }.
export function discardDreamJob(db, projectKey, jobId, { reason = 'cancelled' } = {}) {
  if (!db || !projectKey || !jobId) return { ok: false, reason: 'no_inputs' };
  const job = readJob(db, projectKey, jobId);
  if (!job) return { ok: false, reason: 'not_found' };
  if (job.status === 'applied') return { ok: false, reason: 'already_applied' };
  const now = nowIso();
  try {
    db.exec('SAVEPOINT dream_discard');
    try {
      db.prepare(
        "UPDATE dream_proposals SET status='rejected', updated_at=? WHERE job_id=? AND project_key=? AND status='pending'",
      ).run(now, jobId, projectKey);
    } catch {
      /* best-effort */
    }
    db.prepare(
      "UPDATE dream_jobs SET status='cancelled', error=?, updated_at=? WHERE id=? AND project_key=?",
    ).run(reason.slice(0, 500), now, jobId, projectKey);
    db.exec('RELEASE dream_discard');
  } catch (e) {
    try {
      db.exec('ROLLBACK TO dream_discard');
    } catch {
      /* ignore */
    }
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
  return { ok: true, status: 'cancelled', reason };
}

// ---- Read helpers ----

export function readJob(db, projectKey, jobId) {
  try {
    const row = db
      .prepare('SELECT * FROM dream_jobs WHERE id=? AND project_key=?')
      .get(jobId, projectKey);
    return row ? rowToJob(row) : null;
  } catch {
    return null;
  }
}

export function listJobs(db, projectKey, { status = null, limit = 20 } = {}) {
  const where = ['project_key = ?'];
  const params = [projectKey];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  params.push(Math.max(1, Math.min(100, limit)));
  try {
    const rows = db
      .prepare(
        `SELECT * FROM dream_jobs WHERE ${where.join(' AND ')}
         ORDER BY datetime(updated_at) DESC LIMIT ?`,
      )
      .all(...params);
    return rows.map(rowToJob);
  } catch {
    return [];
  }
}

export function listProposals(db, projectKey, jobId, { status = null } = {}) {
  if (!jobId) return [];
  const where = ['project_key = ?', 'job_id = ?'];
  const params = [projectKey, jobId];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  try {
    const rows = db
      .prepare(
        `SELECT * FROM dream_proposals WHERE ${where.join(' AND ')}
         ORDER BY kind ASC, created_at ASC`,
      )
      .all(...params);
    return rows.map(rowToProposal);
  } catch {
    return [];
  }
}

export function readProposal(db, projectKey, proposalId) {
  try {
    const row = db
      .prepare('SELECT * FROM dream_proposals WHERE id=? AND project_key=?')
      .get(proposalId, projectKey);
    return row ? rowToProposal(row) : null;
  } catch {
    return null;
  }
}

function rowToJob(row) {
  return {
    id: row.id,
    project_key: row.project_key,
    status: row.status,
    triggered_by: row.triggered_by,
    input_snapshot: parseJson(row.input_snapshot, {}),
    result_counts: parseJson(row.result_counts, {}),
    error: row.error,
    enqueued_at: row.enqueued_at,
    started_at: row.started_at,
    ready_at: row.ready_at,
    applied_at: row.applied_at,
    updated_at: row.updated_at,
  };
}

function rowToProposal(row) {
  const provenance = parseJson(row.provenance, {});
  return {
    id: row.id,
    job_id: row.job_id,
    project_key: row.project_key,
    kind: row.kind,
    source_ids: parseJson(row.source_ids, []),
    target_ids: parseJson(row.target_ids, []),
    proposed_content: row.proposed_content || '',
    proposed_title: provenance.proposed_title || '',
    proposed_tags: Array.isArray(provenance.proposed_tags) ? provenance.proposed_tags : [],
    confidence: row.confidence,
    provenance,
    source_checksum: row.source_checksum || '',
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseJson(text, fallback) {
  const r = safeJsonParse(typeof text === 'string' ? text : JSON.stringify(text || ''));
  if (!r.ok) return fallback;
  return r.value;
}

// ---- Lifecycle helpers ----

// Find the next ready job for the project (oldest first). Used by the
// SessionStart hook to opportunistically apply pending proposals.
export function findReadyJob(db, projectKey) {
  try {
    const row = db
      .prepare(
        "SELECT id FROM dream_jobs WHERE project_key=? AND status='ready' ORDER BY datetime(updated_at) ASC LIMIT 1",
      )
      .get(projectKey);
    return row ? row.id : null;
  } catch {
    return null;
  }
}

// Compact status shape for the hook status line. Bounded counts + a
// single short label; never echoes memory ids or proposal bodies.
export function buildDreamStatus(db, projectKey) {
  const empty = { label: 'none', queued: 0, ready: 0, applied: 0, failed: 0, cancelled: 0 };
  if (!db || !projectKey) return empty;
  try {
    const counts = db
      .prepare('SELECT status, COUNT(*) AS n FROM dream_jobs WHERE project_key=? GROUP BY status')
      .all(projectKey);
    const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.n]));
    const queued = byStatus.queued || 0;
    const running = byStatus.running || 0;
    const ready = byStatus.ready || 0;
    const applied = byStatus.applied || 0;
    const failed = byStatus.failed || 0;
    const cancelled = byStatus.cancelled || 0;
    const stale = byStatus.stale || 0;
    let label = 'none';
    if (failed > 0) label = `failed:${failed}`;
    else if (ready > 0) label = `ready:${ready}`;
    else if (running > 0) label = `running:${running}`;
    else if (queued > 0) label = `queued:${queued}`;
    else if (applied > 0) label = `applied:${applied}`;
    else if (cancelled > 0) label = `cancelled:${cancelled}`;
    else if (stale > 0) label = `stale:${stale}`;
    return { label, queued, ready, applied, failed, cancelled };
  } catch {
    return empty;
  }
}

// Re-export the auto-apply threshold so the hook + CLI can display
// the current value without re-deriving it.
export function getAutoApplyConfidence() {
  return autoApplyConfidence();
}
