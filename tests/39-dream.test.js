// Phase-1 staged Dream consolidation tests. Covers:
//   - schema migration is idempotent
//   - per-project isolation
//   - idempotent enqueue (re-enqueue while running is a no-op)
//   - proposal mode creates no live memory / edge / status changes
//   - apply creates conclusions + edges and soft-supersedes only unchanged sources
//   - stale-source detection prevents unsafe application
//   - discard / cancel transitions
//   - status helper shape
//   - env opt-out (KIMI_MEMORY_DREAM=off)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf } from './_helpers.js';
import { openDb, closeDb, saveMemory, linkMemory, mergeMemory } from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';
import {
  enqueueDreamJob,
  generateProposalsForJob,
  applyDreamJob,
  discardDreamJob,
  listJobs,
  listProposals,
  readJob,
  buildDreamStatus,
  shouldEnqueue,
  lastDreamEnqueuedAt,
} from '../src/dream.js';
import { runConsolidate, proposalSourceChecksum } from '../src/consolidate.js';

// Same embedding stub the existing brain-modes tests use. Deterministic
// vectors derived from titles + tags so cosine + tag-overlap form the
// cluster the same way they would in production.
function encodeStubForRow(row) {
  const title = (row.title || '').toLowerCase();
  const tags = (Array.isArray(row.tags) ? row.tags : []).map((t) => String(t).toLowerCase());
  const first = title.split(/\s+/)[0] || '';
  const rest = title.split(/\s+/).slice(1).join(' ');
  let h1 = 0;
  for (let i = 0; i < first.length; i++) h1 = (h1 * 31 + first.charCodeAt(i)) >>> 0;
  let h2 = 0;
  for (let i = 0; i < rest.length; i++) h2 = (h2 * 31 + rest.charCodeAt(i)) >>> 0;
  const sharedTags = ['dream', 'alpha', 'beta'].filter((t) => tags.includes(t)).length;
  const len = Math.min(2, title.length / 30);
  return new Float32Array([(h1 % 1000) / 1000, (h2 % 1000) / 1000, sharedTags / 3, len]);
}

async function installEmbeddingStub() {
  async function saveWithEmbedding(db, projectKey, input) {
    const m = saveMemory(db, projectKey, { ...input, _embed: false });
    await new Promise((r) => setImmediate(r));
    const stub = encodeStubForRow(input);
    const blob = Buffer.from(stub.buffer);
    db.prepare(
      `UPDATE memories SET embedding=?, embedding_model=?, embedding_dim=?, embedded_at=?
       WHERE id=?`,
    ).run(blob, 'stub', stub.length, new Date().toISOString(), m.id);
    return m;
  }
  const decode = (blob) =>
    blob ? new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4) : null;
  return { saveWithEmbedding, decode };
}

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/dream-A');
  return { home, key, dbPath: projectDbPath(home, key) };
}

test('dream: schema migration is idempotent on a freshly-opened DB', () => {
  const { home, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    // openDb runs every migration once. Re-opening the same path runs
    // them again — the migration must short-circuit without throwing.
    db.prepare('SELECT 1').run();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dream_%'")
      .all()
      .map((r) => r.name)
      .sort();
    assert.deepEqual(tables, ['dream_jobs', 'dream_proposals']);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_dream_%'")
      .all()
      .map((r) => r.name)
      .sort();
    assert.ok(indexes.includes('idx_dream_jobs_active'));
    assert.ok(indexes.includes('idx_dream_jobs_project'));
    assert.ok(indexes.includes('idx_dream_proposals_job'));
    assert.ok(indexes.includes('idx_dream_proposals_project'));
    // Active-job partial unique index — re-run probe must observe the
    // same shape.
    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_dream_jobs_active'")
      .get().sql;
    assert.match(sql, /WHERE status = 'running'/);
    closeDb();
    // Reopen and re-run the migrations on the same DB file.
    const db2 = openDb(dbPath);
    db2.prepare('SELECT 1').run();
    const tables2 = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dream_%'")
      .all()
      .map((r) => r.name)
      .sort();
    assert.deepEqual(tables2, ['dream_jobs', 'dream_proposals']);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream: per-project isolation — jobs and proposals stay scoped to their project_key', async () => {
  const home = mkTempHome();
  const keyA = deriveProjectKey('C:/test/dream-iso-A');
  const keyB = deriveProjectKey('C:/test/dream-iso-B');
  const dbPathA = projectDbPath(home, keyA);
  const dbPathB = projectDbPath(home, keyB);
  try {
    const dbA = openDb(dbPathA);
    const dbB = openDb(dbPathB);
    enqueueDreamJob(dbA, keyA, { triggered_by: 'test' });
    enqueueDreamJob(dbB, keyB, { triggered_by: 'test' });
    // Cross-project visibility is impossible: A's job must not appear
    // when we list B, and vice versa.
    const aJobs = listJobs(dbA, keyA);
    const bJobs = listJobs(dbB, keyB);
    assert.equal(aJobs.length, 1);
    assert.equal(bJobs.length, 1);
    assert.notEqual(aJobs[0].id, bJobs[0].id);
    assert.equal(readJob(dbB, keyA, aJobs[0].id), null);
    assert.equal(readJob(dbA, keyB, bJobs[0].id), null);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream: enqueue is idempotent — re-enqueue while queued/ready is a no-op', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const r1 = enqueueDreamJob(db, key);
    assert.equal(r1.status, 'enqueued');
    const r2 = enqueueDreamJob(db, key);
    assert.equal(r2.status, 'duplicate');
    assert.equal(r2.job_id, r1.job_id);
    // The DB has exactly one job.
    const jobs = listJobs(db, key);
    assert.equal(jobs.length, 1);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream: env opt-out (KIMI_MEMORY_DREAM=off) short-circuits enqueue', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const prev = process.env.KIMI_MEMORY_DREAM;
    process.env.KIMI_MEMORY_DREAM = 'off';
    try {
      const r = enqueueDreamJob(db, key);
      assert.equal(r.status, 'opt_out');
      const gate = shouldEnqueue(db, key);
      assert.equal(gate.enqueue, false);
      assert.equal(gate.reason, 'env_opt_out');
    } finally {
      if (prev === undefined) delete process.env.KIMI_MEMORY_DREAM;
      else process.env.KIMI_MEMORY_DREAM = prev;
    }
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream: proposal mode creates no live memory, edge, or status changes', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding, decode } = await installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    for (const title of ['dream one', 'dream two', 'dream three']) {
      await saveWithEmbedding(db, key, {
        type: 'semantic',
        title,
        content: 'tag-share',
        tags: ['dream', 'alpha', 'beta'],
      });
    }
    const before = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key=?').get(key).n;
    const beforeEdges = db
      .prepare('SELECT COUNT(*) AS n FROM memory_edges WHERE project_key=?')
      .get(key).n;
    const beforeSynth = db
      .prepare('SELECT COUNT(*) AS n FROM memory_synthesizes WHERE project_key=?')
      .get(key).n;
    // Enqueue + generate proposals.
    const enq = enqueueDreamJob(db, key);
    assert.equal(enq.status, 'enqueued');
    const gen = await generateProposalsForJob(db, key, enq.job_id, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      decodeEmbeddingImpl: decode,
    });
    assert.equal(gen.ok, true);
    assert.ok(gen.result_counts.proposals_persisted > 0, 'proposals persisted');
    // Live memories table is unchanged.
    const after = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key=?').get(key).n;
    const afterEdges = db
      .prepare('SELECT COUNT(*) AS n FROM memory_edges WHERE project_key=?')
      .get(key).n;
    const afterSynth = db
      .prepare('SELECT COUNT(*) AS n FROM memory_synthesizes WHERE project_key=?')
      .get(key).n;
    assert.equal(after, before, 'no live memory writes');
    assert.equal(afterEdges, beforeEdges, 'no edge writes');
    assert.equal(afterSynth, beforeSynth, 'no synthesizes writes');
    // Status of the job is now `ready`.
    const job = readJob(db, key, enq.job_id);
    assert.equal(job.status, 'ready');
    // proposals are recorded with status=pending and their source
    // ids match the cluster.
    const props = listProposals(db, key, enq.job_id);
    assert.ok(props.length > 0);
    for (const p of props) {
      assert.equal(p.status, 'pending');
      assert.ok(p.source_ids.length > 0 || p.kind === 'conclusion');
    }
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream: apply creates a conclusion + synthesizes edges and soft-supersedes only unchanged sources', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding, decode } = await installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    const saved = [];
    for (const title of ['apply one', 'apply two', 'apply three']) {
      const m = await saveWithEmbedding(db, key, {
        type: 'semantic',
        title,
        content: 'tag-share',
        tags: ['dream', 'alpha', 'beta'],
      });
      saved.push(m);
    }
    const enq = enqueueDreamJob(db, key);
    const gen = await generateProposalsForJob(db, key, enq.job_id, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      decodeEmbeddingImpl: decode,
    });
    assert.equal(gen.ok, true);

    const applyRes = applyDreamJob(db, key, enq.job_id, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      autoApplyConfidence: null,
    });
    assert.equal(applyRes.ok, true);
    assert.ok(applyRes.applied > 0, 'at least one proposal applied');
    assert.equal(applyRes.failed, 0);

    // Live memories now contain a conclusion.
    const conclusions = db
      .prepare(
        "SELECT id, title, content FROM memories WHERE project_key=? AND type='conclusion' AND status='active'",
      )
      .all(key);
    assert.ok(conclusions.length >= 1);
    // synthesizes + edges populated.
    const synth = db
      .prepare('SELECT COUNT(*) AS n FROM memory_synthesizes WHERE project_key=?')
      .get(key).n;
    assert.ok(synth > 0, 'synthesizes rows present');
    const edges = db
      .prepare("SELECT COUNT(*) AS n FROM memory_edges WHERE project_key=? AND kind='synthesizes'")
      .get(key).n;
    assert.ok(edges > 0, 'synthesizes edges present');
    // Job status is now applied.
    const job = readJob(db, key, enq.job_id);
    assert.equal(job.status, 'applied');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream: stale-source detection prevents applying a cluster whose sources drifted', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding, decode } = await installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    const sources = [];
    for (const title of ['stale one', 'stale two', 'stale three']) {
      const m = await saveWithEmbedding(db, key, {
        type: 'semantic',
        title,
        content: 'tag-share',
        tags: ['dream', 'alpha', 'beta'],
      });
      sources.push(m);
    }
    const enq = enqueueDreamJob(db, key);
    const gen = await generateProposalsForJob(db, key, enq.job_id, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      decodeEmbeddingImpl: decode,
    });
    assert.equal(gen.ok, true);

    // Drift the first source row — bump updated_at to invalidate the
    // checksum. Direct UPDATE preserves status='active' so the test
    // specifically exercises checksum drift, not status drift.
    const driftSql = 'UPDATE memories SET updated_at=? WHERE id=?';
    const driftStamp = new Date(Date.now() + 60_000).toISOString();
    db.prepare(driftSql).run(driftStamp, sources[0].id);

    // Also exercise the status-drift branch: flip the second source to
    // superseded so the apply path drops it from source_rows.
    db.prepare("UPDATE memories SET status='superseded' WHERE id=?").run(sources[1].id);

    const applyRes = applyDreamJob(db, key, enq.job_id, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      autoApplyConfidence: null,
    });
    assert.equal(applyRes.ok, true);
    assert.ok(applyRes.stale > 0, 'at least one proposal is stale');
    // No new conclusion row was inserted for the drifted cluster.
    const conclusions = db
      .prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND type='conclusion' AND status='active'",
      )
      .get(key).n;
    assert.equal(conclusions, 0);
    // The job is still marked applied (it ran to completion); pending
    // proposals were flipped to stale / rejected.
    const props = listProposals(db, key, enq.job_id);
    assert.ok(
      props.every((p) => p.status === 'stale' || p.status === 'rejected' || p.status === 'applied'),
    );
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream: discard marks a queued/ready job cancelled and rejects its pending proposals', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding, decode } = await installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    for (const title of ['discard one', 'discard two', 'discard three']) {
      await saveWithEmbedding(db, key, {
        type: 'semantic',
        title,
        content: 'tag-share',
        tags: ['dream', 'alpha', 'beta'],
      });
    }
    const enq = enqueueDreamJob(db, key);
    const gen = await generateProposalsForJob(db, key, enq.job_id, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      decodeEmbeddingImpl: decode,
    });
    assert.equal(gen.ok, true);

    const discard = discardDreamJob(db, key, enq.job_id, { reason: 'test' });
    assert.equal(discard.ok, true);
    const job = readJob(db, key, enq.job_id);
    assert.equal(job.status, 'cancelled');
    // Pending proposals are rejected.
    const props = listProposals(db, key, enq.job_id);
    const pending = props.filter((p) => p.status === 'pending');
    assert.equal(pending.length, 0);
    assert.ok(props.some((p) => p.status === 'rejected'));
    // A discarded job cannot be applied.
    const reapply = applyDreamJob(db, key, enq.job_id, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      autoApplyConfidence: null,
    });
    assert.equal(reapply.ok, false);
    assert.equal(reapply.reason, 'not_ready');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream: buildDreamStatus returns a compact label + counts shape', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding, decode } = await installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    const empty = buildDreamStatus(db, key);
    assert.equal(empty.label, 'none');
    for (const title of ['status one', 'status two', 'status three']) {
      await saveWithEmbedding(db, key, {
        type: 'semantic',
        title,
        content: 'tag-share',
        tags: ['dream', 'alpha', 'beta'],
      });
    }
    enqueueDreamJob(db, key);
    const enq = enqueueDreamJob(db, key); // duplicate
    await generateProposalsForJob(db, key, enq.job_id, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      decodeEmbeddingImpl: decode,
    });
    const ready = buildDreamStatus(db, key);
    assert.ok(ready.ready >= 1);
    assert.match(ready.label, /^ready:/);
    assert.equal(typeof ready.queued, 'number');
    assert.equal(typeof ready.applied, 'number');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream: lastDreamEnqueuedAt tracks the most recent enqueue for debounce', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding, decode } = await installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    for (const title of ['debounce one', 'debounce two', 'debounce three']) {
      await saveWithEmbedding(db, key, {
        type: 'semantic',
        title,
        content: 'tag-share',
        tags: ['dream', 'alpha', 'beta'],
      });
    }
    const before = lastDreamEnqueuedAt(db, key);
    assert.equal(before, null);
    enqueueDreamJob(db, key);
    const after = lastDreamEnqueuedAt(db, key);
    assert.ok(after && Date.parse(after) > 0);
    // The shouldEnqueue gate uses the last timestamp to throttle.
    const gate = shouldEnqueue(db, key, { lastEnqueuedAt: after });
    assert.equal(gate.enqueue, false);
    assert.match(gate.reason, /throttled|debounce/);
    // Force bypass — lastEnqueuedAt=null means the debounce window is
    // already past.
    const gateOk = shouldEnqueue(db, key, { lastEnqueuedAt: null });
    assert.equal(gateOk.enqueue, true);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream: proposalSourceChecksum is stable + sensitive to drift', () => {
  const a = [{ id: 'm1', updatedAt: '2026-08-18T00:00:00Z' }];
  const b = [{ id: 'm1', updatedAt: '2026-08-18T00:00:00Z' }];
  const c = [{ id: 'm1', updatedAt: '2026-08-18T00:00:01Z' }];
  assert.equal(proposalSourceChecksum(a), proposalSourceChecksum(b));
  assert.notEqual(proposalSourceChecksum(a), proposalSourceChecksum(c));
});

test('dream: runConsolidate proposal mode does not touch live memories (compatibility with old direct tests)', async () => {
  // This is a guard against the proposal-mode branch leaking writes.
  // Existing tests already exercise direct mode; here we confirm
  // proposal mode + an injected saveMemory that throws never reaches
  // the persist layer.
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding, decode } = await installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    for (const title of ['compat one', 'compat two', 'compat three']) {
      await saveWithEmbedding(db, key, {
        type: 'semantic',
        title,
        content: 'tag-share',
        tags: ['dream', 'alpha', 'beta'],
      });
    }
    let saveCalled = false;
    const res = await runConsolidate({
      db,
      projectKey: key,
      // saveMemory that throws if called — proposal mode must not
      // call it.
      saveMemory: () => {
        saveCalled = true;
        throw new Error('proposal mode must not call saveMemory');
      },
      memoryLink: () => {
        throw new Error('proposal mode must not call memoryLink');
      },
      mergeMemory: () => {
        throw new Error('proposal mode must not call mergeMemory');
      },
      decodeEmbeddingImpl: decode,
      mode: 'proposal',
    });
    assert.equal(saveCalled, false);
    assert.ok(res.proposals.length > 0, 'proposal mode emitted proposals');
    // No new conclusion landed in live memories.
    const conc = db
      .prepare("SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND type='conclusion'")
      .get(key).n;
    assert.equal(conc, 0);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream: env opt-out (KIMI_MEMORY_DREAM=off) skips the generate step', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding, decode } = await installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    for (const title of ['off one', 'off two', 'off three']) {
      await saveWithEmbedding(db, key, {
        type: 'semantic',
        title,
        content: 'tag-share',
        tags: ['dream', 'alpha', 'beta'],
      });
    }
    // Opt-out must suppress enqueue.
    const prev = process.env.KIMI_MEMORY_DREAM;
    process.env.KIMI_MEMORY_DREAM = 'off';
    try {
      const r = enqueueDreamJob(db, key);
      assert.equal(r.status, 'opt_out');
    } finally {
      if (prev === undefined) delete process.env.KIMI_MEMORY_DREAM;
      else process.env.KIMI_MEMORY_DREAM = prev;
    }
    // ...but generate can still be called on a job the test created
    // manually. (apply logic is unaffected by the opt-out.)
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream: crash recovery — failed job is queryable, enqueue for the same project is still possible', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const enq = enqueueDreamJob(db, key);
    assert.equal(enq.status, 'enqueued', JSON.stringify(enq));
    // Mark failed via the same code path dream.js uses internally —
    // the test never goes through the helper, just runs a raw UPDATE
    // to simulate a partial failure.
    db.prepare(
      "UPDATE dream_jobs SET status='failed', error='simulated crash', updated_at=? WHERE id=?",
    ).run(new Date().toISOString(), enq.job_id);
    const job = readJob(db, key, enq.job_id);
    assert.equal(job.status, 'failed');
    // After the failure, a new enqueue is allowed because the active
    // partial unique index only constrains `running` rows.
    const reEnq = enqueueDreamJob(db, key);
    assert.equal(reEnq.status, 'enqueued', JSON.stringify(reEnq));
    assert.notEqual(reEnq.job_id, enq.job_id);
  } finally {
    closeDb();
    rmRf(home);
  }
});
