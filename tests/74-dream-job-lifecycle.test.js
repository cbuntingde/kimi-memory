// Dream job lifecycle integrity. Two defects, both reproduced end to
// end against the real pipeline (real DB, real consolidate pass, real
// hook entry points — no stubbed persist layer):
//
//   A. `applyDreamJob` skipped proposals below the confidence floor and
//      then wrote status='applied' unconditionally. The lifecycle path
//      applies at 0.85 while the deterministic pass emitted its
//      conclusion + synthesizes-link proposals at 0.7, so every
//      automatic apply left those rows `pending` forever while the
//      merge proposal (0.85) rewrote a memory body whose synthesis row
//      was never written.
//
//   B. `generateProposalsForJob` guarded only `applied` / `cancelled`,
//      so a second generation over a `ready` job re-inserted the same
//      deterministic proposal ids, collided on the primary key, and
//      `markJobFailed` stranded every proposal it had. `dreaming.js`
//      hits that path whenever a `dreaming_run` finds an existing ready
//      job, and discarded the `{ ok: false }` result.
//
// Coverage:
//   1. the default-floor automatic apply commits the whole deterministic
//      set, so the rewritten body and its conclusion agree
//   2. a floor above the deterministic confidence leaves the job
//      `partially_applied` (not `applied`), keeps the held-back
//      proposals pending and reachable, and leaves the merge it did
//      commit consistent with the memory it rewrote
//   3. a later explicit apply finishes the remainder; re-running an
//      explicit apply neither double-applies nor re-supersedes
//   4. generating over a ready job is a no-op success that leaves the
//      proposal rows byte-identical (including via the runDreaming
//      trigger that used to destroy the job)
//   5. a genuine generation failure reaches the caller as { ok: false }
//   6. the auto-archive sweep bounds settled dream rows without
//      deleting anything `dream_status` still counts as pending
//   7. a stranded `failed` job (defect B's aftermath) is recoverable
//      while nothing on it was applied, and is refused otherwise
//   8. discarding a partially_applied job releases the outstanding-job
//      slot the enqueue guard holds
//   9. a per-call include/exclude narrows a run without rewriting the
//      project's configured pass set
//  10. a floor above every proposal commits nothing, says so, and leaves
//      the whole set reachable
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkTempHome, rmRf } from './_helpers.js';

// src/diagnostics.js resolves its log directory from KIMI_CODE_HOME once,
// at module load, and every src module below reaches it transitively (via
// persist → connection → logPersistError). The temp home therefore has to
// be in place before the first of them is imported, which is why they are
// dynamic imports at the top level. Without this, the failure-path test
// below appends its diagnostic record to the developer's real
// ~/.kimi-code/kimi-memory/_diagnostics/hooks.log.
const TMP_HOME = mkdtempSync(path.join(tmpdir(), 'km-dream-lifecycle-'));
process.env.KIMI_CODE_HOME = TMP_HOME;
after(() => rmRf(TMP_HOME));
const diagLogPath = path.join(TMP_HOME, 'kimi-memory', '_diagnostics', 'hooks.log');

const { openDb, closeDb, saveMemory, linkMemory, mergeMemory } = await import('../src/persist.js');
const { projectDbPath, deriveProjectKey } = await import('../src/project-key.js');
const {
  enqueueDreamJob,
  generateProposalsForJob,
  applyDreamJob,
  discardDreamJob,
  readJob,
  listProposals,
  buildDreamStatus,
} = await import('../src/dream.js');
const { maybeApplyReadyDream } = await import('../src/hooks/handlers/lib/dream-hooks.js');
const { runDreaming, resolveDreamingState, setDreamingState } = await import('../src/dreaming.js');
const { runAutoArchive } = await import('../src/auto-gc.js');
const { DatabaseSync } = await import('node:sqlite');

function freshProject(name) {
  const home = mkTempHome();
  const key = deriveProjectKey(`C:/test/${name}`);
  return { home, key, dbPath: projectDbPath(home, key) };
}

// Deterministic vectors injected straight onto the row. The clusterer,
// the near-dup pass and the tightness gate all read the BLOB, so this
// is the real clustering input — not a stubbed matcher. The vector must
// be EMBEDDING_DIM wide: the real default decoder rejects a short BLOB
// and drops the row, which would silently produce an empty proposal set
// instead of a cluster.
const EMBED_DIM = 384;
function vec384(head) {
  const f = new Float32Array(EMBED_DIM);
  head.forEach((v, i) => {
    f[i] = v;
  });
  return f;
}

function attachEmbedding(db, id, head) {
  const f = vec384(head);
  db.prepare(
    `UPDATE memories SET embedding=?, embedding_model='stub', embedding_dim=?, embedded_at=?
     WHERE id=?`,
  ).run(Buffer.from(f.buffer), f.length, new Date().toISOString(), id);
}

// Builds the fixture the two defects need:
//   - three tight siblings (the "cluster") → conclusion + 3 links + merge
//   - two rows that share a normalised title → title-dedup pair merge
//     at 0.9, i.e. above the deterministic floor
// The pair is orthogonal to the cluster so the two groups never merge
// into one, and the two pair rows form at most a 2-member cluster (below
// MIN_CLUSTER_SIZE), so the pair's only proposal is the dedup merge.
function buildFixture(db, key) {
  const cluster = [];
  for (const [title, vec] of [
    ['cluster one', [1, 0, 0, 0]],
    ['cluster two', [0.99, 0.12, 0, 0]],
    ['cluster three', [0.97, 0.2, 0, 0]],
  ]) {
    const m = saveMemory(db, key, {
      type: 'semantic',
      title,
      content: `${title} body line`,
      tags: ['dream', 'alpha', 'beta'],
      _embed: false,
    });
    attachEmbedding(db, m.id, vec);
    cluster.push(m.id);
  }
  const pair = [];
  for (const [content, confidence, vec] of [
    ['pair duplicate first copy body', 0.9, [0, 1, 0, 0]],
    ['pair duplicate second copy body', 0.6, [0, 0.98, 0.15, 0]],
  ]) {
    // Identical titles, distinct bodies — saveMemory derives a row id
    // from the body, and two identical bodies would collapse into one
    // row instead of being a dedup candidate.
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'pair duplicate',
      content,
      tags: ['duplicate'],
      confidence,
      _embed: false,
    });
    attachEmbedding(db, m.id, vec);
    pair.push(m.id);
  }
  return { cluster, pair };
}

async function enqueueAndGenerate(db, key, jobId = null) {
  const job = jobId || enqueueDreamJob(db, key, { triggered_by: 'test' }).job_id;
  const gen = await generateProposalsForJob(db, key, job, { saveMemory, linkMemory, mergeMemory });
  assert.equal(gen.ok, true, `generation succeeded: ${JSON.stringify(gen)}`);
  return { jobId: job, gen };
}

// Everything an apply is allowed to touch, in a stable order, as a
// single comparable string. Used to prove a re-apply is a no-op.
function stateSnapshot(db, key, jobId) {
  return JSON.stringify({
    memories: db
      .prepare(
        'SELECT id, type, status, content, superseded_by FROM memories WHERE project_key=? ORDER BY id',
      )
      .all(key),
    edges: db.prepare('SELECT * FROM memory_edges WHERE project_key=? ORDER BY id').all(key),
    synthesizes: db
      .prepare('SELECT * FROM memory_synthesizes WHERE project_key=? ORDER BY rowid')
      .all(key),
    proposals: db
      .prepare('SELECT id, status FROM dream_proposals WHERE job_id=? ORDER BY id')
      .all(jobId),
    jobs: db.prepare('SELECT id, status FROM dream_jobs WHERE project_key=? ORDER BY id').all(key),
  });
}

function proposalRows(db, jobId) {
  return JSON.stringify(
    db.prepare('SELECT * FROM dream_proposals WHERE job_id=? ORDER BY id').all(jobId),
  );
}

function activeConclusion(db, key) {
  return (
    db
      .prepare(
        "SELECT id, content FROM memories WHERE project_key=? AND type='conclusion' AND status='active'",
      )
      .get(key) || null
  );
}

async function withAutoApplyFloor(floor, fn) {
  const prev = process.env.KIMI_MEMORY_DREAM_AUTO_APPLY_CONFIDENCE;
  process.env.KIMI_MEMORY_DREAM_AUTO_APPLY_CONFIDENCE = String(floor);
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.KIMI_MEMORY_DREAM_AUTO_APPLY_CONFIDENCE;
    else process.env.KIMI_MEMORY_DREAM_AUTO_APPLY_CONFIDENCE = prev;
  }
}

test('dream lifecycle: the default-floor automatic apply commits the whole deterministic set', async () => {
  const { home, key, dbPath } = freshProject('dream-lifecycle-default');
  try {
    const db = openDb(dbPath);
    buildFixture(db, key);
    const { jobId } = await enqueueAndGenerate(db, key);
    const proposals = listProposals(db, key, jobId);
    // The pass emits conclusion + link at the same confidence as the
    // cluster merge, and the title-dedup pair merge above it.
    assert.equal(proposals.filter((p) => p.kind === 'conclusion').length, 1);
    assert.equal(proposals.filter((p) => p.kind === 'link').length, 3);
    for (const p of proposals) assert.ok(p.confidence >= 0.85, `${p.kind}=${p.confidence}`);

    // The real lifecycle path: the SessionStart hook applies with
    // getAutoApplyConfidence() (0.85 by default).
    const applied = await maybeApplyReadyDream(db, key);
    assert.equal(applied.apply.ok, true, JSON.stringify(applied));
    assert.equal(applied.apply.status, 'applied');
    assert.equal(applied.apply.remaining, 0);
    assert.equal(listProposals(db, key, jobId, { status: 'pending' }).length, 0);

    // The defect: the merge rewrote a memory body while the conclusion
    // that body describes was never written. Both must be present and
    // must agree.
    const merge = proposals.find((p) => p.provenance.proposed_kind === 'merge');
    const target = db.prepare('SELECT content FROM memories WHERE id=?').get(merge.target_ids[0]);
    assert.equal(target.content, merge.proposed_content);
    const conclusion = activeConclusion(db, key);
    assert.ok(conclusion, 'the conclusion that the rewritten body describes exists');
    assert.equal(conclusion.content, merge.proposed_content);
    assert.equal(readJob(db, key, jobId).status, 'applied');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream lifecycle: a floor above the deterministic set leaves the job partially_applied', async () => {
  const { home, key, dbPath } = freshProject('dream-lifecycle-partial');
  try {
    const db = openDb(dbPath);
    buildFixture(db, key);
    const { jobId } = await enqueueAndGenerate(db, key);
    const before = listProposals(db, key, jobId, { status: 'pending' });
    const dedup = before.find((p) => p.provenance.trigger === 'title_dedup');
    assert.ok(dedup, 'the 0.9 title-dedup merge is in the job');
    assert.equal(dedup.confidence, 0.9);
    const heldBack = before.filter((p) => p.id !== dedup.id);
    assert.ok(heldBack.length > 0, 'the 0.85 set is held back at this floor');

    const applied = await withAutoApplyFloor(0.9, () => maybeApplyReadyDream(db, key));
    assert.equal(applied.apply.ok, true, JSON.stringify(applied));
    assert.equal(applied.apply.applied, 1);
    assert.equal(applied.apply.remaining, heldBack.length);

    // 1. The status claims exactly what happened.
    assert.equal(applied.apply.status, 'partially_applied');
    const job = readJob(db, key, jobId);
    assert.equal(job.status, 'partially_applied');
    assert.ok(job.applied_at, 'the apply that did commit is timestamped');

    // 2. The held-back proposals are untouched and still reachable.
    const pending = listProposals(db, key, jobId, { status: 'pending' });
    assert.deepEqual(pending.map((p) => p.id).sort(), heldBack.map((p) => p.id).sort());
    for (const p of pending) assert.equal(p.status, 'pending');

    // 3. The merge that did apply agrees with the memory it rewrote,
    //    and the cluster it does not cover was left alone.
    const dedupRow = db.prepare('SELECT status FROM dream_proposals WHERE id=?').get(dedup.id);
    assert.equal(dedupRow.status, 'applied');
    const target = db
      .prepare('SELECT content, status FROM memories WHERE id=?')
      .get(dedup.target_ids[0]);
    assert.equal(target.content, dedup.proposed_content);
    assert.equal(target.status, 'active');
    const siblingId = dedup.source_ids.find((id) => id !== dedup.target_ids[0]);
    assert.equal(
      db.prepare('SELECT status FROM memories WHERE id=?').get(siblingId).status,
      'superseded',
    );
    assert.equal(activeConclusion(db, key), null, 'no half-applied cluster synthesis');

    // 4. dream_status reports the outstanding work rather than hiding it.
    const status = buildDreamStatus(db, key);
    assert.equal(status.partially_applied, 1);
    assert.equal(status.label, 'partially_applied:1');
    assert.equal(status.applied, 0);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream lifecycle: a floor above every proposal commits nothing and still says so', async () => {
  const { home, key, dbPath } = freshProject('dream-lifecycle-held-all');
  try {
    const db = openDb(dbPath);
    buildFixture(db, key);
    const { jobId } = await enqueueAndGenerate(db, key);
    const all = listProposals(db, key, jobId, { status: 'pending' });

    const held = applyDreamJob(db, key, jobId, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      autoApplyConfidence: 0.95,
    });
    assert.equal(held.ok, true);
    assert.equal(held.applied, 0);
    assert.equal(held.remaining, all.length);
    // "Partially applied" claims no more than the case it describes: the
    // job is not fully applied, and every proposal is still on file.
    assert.equal(held.status, 'partially_applied');
    assert.equal(readJob(db, key, jobId).status, 'partially_applied');
    assert.equal(listProposals(db, key, jobId, { status: 'pending' }).length, all.length);
    assert.equal(activeConclusion(db, key), null);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND status='superseded'")
        .get(key).n,
      0,
      'nothing was merged either',
    );

    // Nothing was abandoned: the same rows are still reachable.
    const finish = applyDreamJob(db, key, jobId, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
    });
    assert.equal(finish.applied, all.length);
    assert.equal(finish.status, 'applied');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream lifecycle: an explicit apply finishes the remainder and is idempotent', async () => {
  const { home, key, dbPath } = freshProject('dream-lifecycle-finish');
  try {
    const db = openDb(dbPath);
    buildFixture(db, key);
    const { jobId } = await enqueueAndGenerate(db, key);
    const proposals = listProposals(db, key, jobId);
    const clusterMerge = proposals.find(
      (p) => p.kind === 'merge' && p.provenance.trigger !== 'title_dedup',
    );
    assert.ok(clusterMerge, 'the cluster merge proposal exists');

    await withAutoApplyFloor(0.9, () => maybeApplyReadyDream(db, key));
    assert.equal(readJob(db, key, jobId).status, 'partially_applied');

    // A repeated explicit apply at the same floor settles nothing and
    // must not double-apply the merge that already ran.
    const midState = stateSnapshot(db, key, jobId);
    const repeat = applyDreamJob(db, key, jobId, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      autoApplyConfidence: 0.9,
    });
    assert.equal(repeat.ok, true);
    assert.equal(repeat.applied, 0);
    assert.equal(repeat.status, 'partially_applied');
    assert.equal(stateSnapshot(db, key, jobId), midState);

    // The explicit apply with no floor commits everything that is left.
    const finish = applyDreamJob(db, key, jobId, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
    });
    assert.equal(finish.ok, true, JSON.stringify(finish));
    assert.ok(finish.applied > 0);
    assert.equal(finish.remaining, 0);
    assert.equal(finish.status, 'applied');
    assert.equal(readJob(db, key, jobId).status, 'applied');
    assert.equal(listProposals(db, key, jobId, { status: 'pending' }).length, 0);

    // The cluster's synthesis and the body its merge wrote are the same
    // thing — the state defect A left inconsistent.
    const conclusion = activeConclusion(db, key);
    assert.ok(conclusion);
    assert.equal(conclusion.content, clusterMerge.proposed_content);
    const clusterTarget = db
      .prepare('SELECT content, status FROM memories WHERE id=?')
      .get(clusterMerge.target_ids[0]);
    assert.equal(clusterTarget.content, clusterMerge.proposed_content);
    assert.equal(clusterTarget.status, 'active');

    // Re-running the finished job changes nothing at all.
    const done = stateSnapshot(db, key, jobId);
    const again = applyDreamJob(db, key, jobId, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
    });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'not_ready');
    assert.equal(stateSnapshot(db, key, jobId), done);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream lifecycle: generating over a ready job is a no-op success that keeps its rows', async () => {
  const { home, key, dbPath } = freshProject('dream-lifecycle-ready-noop');
  try {
    const db = openDb(dbPath);
    buildFixture(db, key);
    const { jobId } = await enqueueAndGenerate(db, key);
    const rowsBefore = proposalRows(db, jobId);
    const jobBefore = readJob(db, key, jobId);

    const regen = await generateProposalsForJob(db, key, jobId, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
    });
    assert.equal(regen.ok, true, JSON.stringify(regen));
    assert.equal(regen.reason, 'already_generated');
    assert.equal(regen.noop, true);
    assert.equal(proposalRows(db, jobId), rowsBefore);
    const jobAfter = readJob(db, key, jobId);
    assert.equal(jobAfter.status, 'ready');
    assert.equal(
      jobAfter.updated_at,
      jobBefore.updated_at,
      'a no-op does not even restamp the job',
    );
    assert.equal(jobAfter.error, null);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream lifecycle: the runDreaming re-run over a ready job no longer fails it', async () => {
  const { home, key, dbPath } = freshProject('dream-lifecycle-dreaming-rerun');
  try {
    const db = openDb(dbPath);
    buildFixture(db, key);
    const { jobId } = await enqueueAndGenerate(db, key);
    const rowsBefore = proposalRows(db, jobId);

    // src/dreaming.js:370 calls generate whenever the enqueue reports a
    // duplicate pointing at a ready job — a `dreaming_run` after the
    // interval, or with force. Before the guard this collided on the
    // proposal primary key and flipped the job to `failed`.
    await setDreamingState({ projectKey: key, include: ['dream'], kimiHomeDir: home });
    const run = await runDreaming({
      db,
      projectKey: key,
      cwd: 'C:/test/dream-lifecycle-dreaming-rerun',
      force: true,
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      kimiHomeDir: home,
    });
    assert.equal(run.fired, true);
    assert.equal(run.passes.dream.generate.ok, true, JSON.stringify(run.passes.dream));
    assert.equal(run.passes.dream.generate.noop, true);
    assert.equal(run.passes.dream.proposal_error, undefined);

    const job = readJob(db, key, jobId);
    assert.notEqual(job.status, 'failed');
    // The dreaming pass applies without a floor, so it settles the job.
    assert.equal(job.status, 'applied');
    assert.equal(listProposals(db, key, jobId, { status: 'pending' }).length, 0);
    const conclusion = activeConclusion(db, key);
    assert.ok(conclusion, 'the proposal set generated before the re-run is still the one applied');
    // The rows the first generation wrote were never rewritten.
    const regenIds = db
      .prepare('SELECT id FROM dream_proposals WHERE job_id=? ORDER BY id')
      .all(jobId)
      .map((r) => r.id);
    const originalIds = JSON.parse(rowsBefore).map((r) => r.id);
    assert.deepEqual(regenIds, originalIds);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream lifecycle: a genuine generation failure surfaces to the caller', async () => {
  const { home, key, dbPath } = freshProject('dream-lifecycle-genfail');
  try {
    const db = openDb(dbPath);
    buildFixture(db, key);
    await setDreamingState({ projectKey: key, include: ['dream'], kimiHomeDir: home });
    // A real DB-level fault, not a stubbed dependency: move the table the
    // insert target lives in. Every line of the pipeline still runs.
    db.exec('ALTER TABLE dream_proposals RENAME TO dream_proposals_missing');

    const run = await runDreaming({
      db,
      projectKey: key,
      cwd: 'C:/test/dream-lifecycle-genfail',
      force: true,
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      kimiHomeDir: home,
    });
    assert.equal(run.fired, true);
    assert.equal(run.passes.dream.generate.ok, false, JSON.stringify(run.passes.dream));
    assert.equal(run.passes.dream.generate.reason, 'persist_threw');
    assert.equal(run.passes.dream.proposal_error, 'persist_threw');
    // The failure is also stamped on the job, so `dream_list_jobs` shows it.
    const jobId = run.passes.dream.enqueued.job_id;
    assert.equal(readJob(db, key, jobId).status, 'failed');

    // And it is diagnosable from the log alone, without a debugger: the
    // pass writes a `hook_diag` record naming the job and the reason.
    // (This is also why the file sets KIMI_CODE_HOME from TMP_HOME at the
    // top — the record must land in the temp home, not the real one.)
    const log = readFileSync(diagLogPath, 'utf8');
    const record = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((r) => r.message === 'proposal generation failed')
      .pop();
    assert.ok(record, 'the pass logged the generation failure');
    assert.equal(record.level, 'warn');
    assert.equal(record.event, 'dreaming');
    assert.equal(record.context.jobId, jobId);
    assert.equal(record.context.reason, 'persist_threw');

    // The same call is the one the MCP/CLI layer returns, so an agent
    // sees it rather than a silent partial run.
    db.exec('ALTER TABLE dream_proposals_missing RENAME TO dream_proposals');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream lifecycle: auto-archive bounds settled dream rows and keeps pending work', () => {
  const { home, key, dbPath } = freshProject('dream-lifecycle-sweep');
  try {
    const db = openDb(dbPath);
    const now = new Date();
    const old = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const insertJob = db.prepare(
      `INSERT INTO dream_jobs (id, project_key, status, triggered_by, input_snapshot, result_counts,
                               enqueued_at, updated_at)
       VALUES (?, ?, ?, 'test', '{}', '{}', ?, ?)`,
    );
    const insertProposal = db.prepare(
      `INSERT INTO dream_proposals (id, job_id, project_key, kind, source_ids, target_ids,
                                    proposed_content, confidence, provenance, source_checksum,
                                    status, created_at, updated_at)
       VALUES (?, ?, ?, 'conclusion', '["m1"]', '[]', 'body', 0.85, '{}', 'sum', ?, ?, ?)`,
    );
    // Settled + old → swept. Settled + recent → kept. Outstanding → kept
    // whatever its age, because its proposals are the operator's queue.
    insertJob.run('job-settled-old', key, 'applied', old, old);
    insertProposal.run('prop-settled-old', 'job-settled-old', key, 'pending', old, old);
    insertJob.run('job-settled-recent', key, 'failed', recent, recent);
    insertProposal.run(
      'prop-settled-recent',
      'job-settled-recent',
      key,
      'rejected',
      recent,
      recent,
    );
    insertJob.run('job-partial', key, 'partially_applied', old, old);
    insertProposal.run('prop-partial', 'job-partial', key, 'pending', old, old);

    const before = buildDreamStatus(db, key);
    assert.equal(before.partially_applied, 1);

    const sweep = runAutoArchive(db, key);
    assert.equal(sweep.archived_dream_jobs, 1);
    assert.equal(sweep.archived_dream_proposals, 1);
    const remainingJobs = db
      .prepare('SELECT id FROM dream_jobs WHERE project_key=? ORDER BY id')
      .all(key)
      .map((r) => r.id);
    const remainingProps = db
      .prepare('SELECT id FROM dream_proposals WHERE project_key=? ORDER BY id')
      .all(key)
      .map((r) => r.id);
    assert.deepEqual(remainingJobs, ['job-partial', 'job-settled-recent']);
    assert.deepEqual(remainingProps, ['prop-partial', 'prop-settled-recent']);

    // Nothing `dream_status` counts as pending work went away.
    const after = buildDreamStatus(db, key);
    assert.equal(after.partially_applied, 1);
    assert.equal(after.failed, 1);
    assert.equal(after.applied, 0);

    // The archive gate still governs the sweep.
    const prev = process.env.KIMI_MEMORY_AUTO_ARCHIVE;
    process.env.KIMI_MEMORY_AUTO_ARCHIVE = 'off';
    try {
      const off = runAutoArchive(db, key);
      assert.equal(off.skipped, 'archive_opt_out');
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM dream_jobs WHERE project_key=?').get(key).n,
        2,
      );
    } finally {
      if (prev === undefined) delete process.env.KIMI_MEMORY_AUTO_ARCHIVE;
      else process.env.KIMI_MEMORY_AUTO_ARCHIVE = prev;
    }
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream lifecycle: a stranded failed job is recoverable while nothing was applied', async () => {
  const { home, key, dbPath } = freshProject('dream-lifecycle-recover');
  try {
    const db = openDb(dbPath);
    buildFixture(db, key);
    const { jobId } = await enqueueAndGenerate(db, key);
    const strandedIds = listProposals(db, key, jobId).map((p) => p.id);
    assert.ok(strandedIds.length > 0);
    // The shape defect B leaves behind on a production DB: the job is
    // `failed` while its proposals sit there unreachable, because a
    // failed job can never be applied.
    db.prepare("UPDATE dream_jobs SET status='failed', error='simulated' WHERE id=?").run(jobId);

    const recovered = await generateProposalsForJob(db, key, jobId, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
    });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(readJob(db, key, jobId).status, 'ready');
    assert.equal(listProposals(db, key, jobId, { status: 'pending' }).length, strandedIds.length);

    // ...but a job that already has an applied proposal is left alone:
    // regenerating it would re-propose committed work.
    db.prepare("UPDATE dream_proposals SET status='applied' WHERE id=?").run(strandedIds[0]);
    db.prepare("UPDATE dream_jobs SET status='failed', error='simulated' WHERE id=?").run(jobId);
    const refused = await generateProposalsForJob(db, key, jobId, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'failed_with_applied_proposals');
    assert.equal(readJob(db, key, jobId).status, 'failed');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream lifecycle: discarding a partially_applied job releases the enqueue slot', async () => {
  const { home, key, dbPath } = freshProject('dream-lifecycle-discard');
  try {
    const db = openDb(dbPath);
    buildFixture(db, key);
    const { jobId } = await enqueueAndGenerate(db, key);
    await withAutoApplyFloor(0.9, () => maybeApplyReadyDream(db, key));
    assert.equal(readJob(db, key, jobId).status, 'partially_applied');

    // One outstanding job per project: the held-back work blocks a
    // second enqueue rather than letting unsettled jobs pile up.
    const blocked = enqueueDreamJob(db, key, { triggered_by: 'test' });
    assert.equal(blocked.status, 'duplicate');
    assert.equal(blocked.job_id, jobId);

    const discarded = discardDreamJob(db, key, jobId, { reason: 'none of the remainder' });
    assert.equal(discarded.ok, true);
    assert.equal(readJob(db, key, jobId).status, 'cancelled');
    assert.equal(listProposals(db, key, jobId, { status: 'pending' }).length, 0);
    assert.equal(buildDreamStatus(db, key).partially_applied, 0);

    const next = enqueueDreamJob(db, key, { triggered_by: 'test' });
    assert.equal(next.status, 'enqueued');
    assert.notEqual(next.job_id, jobId);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream lifecycle: a per-call include/exclude narrows the run without rewriting config', async () => {
  const { home, key, dbPath } = freshProject('dream-lifecycle-include');
  try {
    const db = openDb(dbPath);
    buildFixture(db, key);
    await setDreamingState({
      projectKey: key,
      include: ['consolidate', 'dream', 'gc'],
      kimiHomeDir: home,
    });
    const run = await runDreaming({
      db,
      projectKey: key,
      cwd: 'C:/test/dream-lifecycle-include',
      force: true,
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      kimiHomeDir: home,
      include: ['consolidate', 'dream', 'gc'],
      exclude: ['dream'],
    });
    assert.equal(run.fired, true);
    assert.deepEqual(run.include, ['consolidate', 'gc']);
    assert.equal(run.passes.dream, undefined, 'the excluded pass did not run');
    assert.ok(run.passes.consolidate);
    assert.ok(run.passes.gc);
    // a run never rewrites the configured pass set
    assert.deepEqual(resolveDreamingState({ projectKey: key, kimiHomeDir: home }).include, [
      'consolidate',
      'dream',
      'gc',
    ]);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('dream lifecycle: a pre-v17 DB is rebuilt in place and keeps its rows', () => {
  const home = mkTempHome();
  try {
    const key = deriveProjectKey('C:/test/dream-lifecycle-migrate');
    const dbPath = projectDbPath(home, key);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    // A v16 file, written by the previous build: the old status CHECK
    // (no `partially_applied`), a pending job with a proposal on it, and
    // the child FOREIGN KEY that the rebuild has to keep working.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE dream_jobs (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','running','ready','applied','stale','failed','cancelled')),
        triggered_by TEXT NOT NULL DEFAULT 'lifecycle',
        input_snapshot TEXT NOT NULL DEFAULT '{}',
        result_counts TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        enqueued_at TEXT NOT NULL,
        started_at TEXT,
        ready_at TEXT,
        applied_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_dream_jobs_project ON dream_jobs(project_key, updated_at);
      CREATE UNIQUE INDEX idx_dream_jobs_active ON dream_jobs(project_key) WHERE status = 'running';
      CREATE TABLE dream_proposals (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        project_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('conclusion','merge','supersede','link')),
        source_ids TEXT NOT NULL DEFAULT '[]',
        target_ids TEXT NOT NULL DEFAULT '[]',
        proposed_content TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.7,
        provenance TEXT NOT NULL DEFAULT '{}',
        source_checksum TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','stale','approved','applied','rejected')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES dream_jobs(id)
      );
      CREATE INDEX idx_dream_proposals_job ON dream_proposals(job_id, status);
      CREATE INDEX idx_dream_proposals_project ON dream_proposals(project_key, status);
    `);
    const stamp = new Date().toISOString();
    raw
      .prepare(
        `INSERT INTO dream_jobs (id, project_key, status, triggered_by, input_snapshot,
                                 result_counts, enqueued_at, updated_at)
         VALUES ('old-job', ?, 'ready', 'legacy', '{}', '{}', ?, ?)`,
      )
      .run(key, stamp, stamp);
    raw
      .prepare(
        `INSERT INTO dream_proposals (id, job_id, project_key, kind, source_ids, target_ids,
                                      proposed_content, confidence, provenance, source_checksum,
                                      status, created_at, updated_at)
         VALUES ('old-prop', 'old-job', ?, 'conclusion', '["m1"]', '[]', 'body', 0.7, '{}',
                 'sum', 'pending', ?, ?)`,
      )
      .run(key, stamp, stamp);
    raw.exec('PRAGMA user_version = 16');
    raw.close();

    const db = openDb(dbPath);
    // Rows survive the vocabulary rebuild, proposals still bound to the
    // job (the child FK clause was not rewritten to the temp table name).
    assert.equal(readJob(db, key, 'old-job').status, 'ready');
    assert.equal(listProposals(db, key, 'old-job')[0].id, 'old-prop');
    const fk = db.prepare('PRAGMA foreign_key_list(dream_proposals)').all();
    assert.equal(fk.length, 1);
    assert.equal(fk[0].table, 'dream_jobs');
    // The rebuilt table's indexes are back, the unique-active guard too.
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_dream_jobs_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    assert.deepEqual(indexes, ['idx_dream_jobs_active', 'idx_dream_jobs_project']);
    assert.match(
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_dream_jobs_active'",
        )
        .get().sql,
      /WHERE status = 'running'/,
    );
    // The rebuild produced a temporary table that must be gone, and
    // foreign-key enforcement must be back on.
    assert.equal(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dream_jobs_new'")
        .get(),
      undefined,
    );
    assert.equal(Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 17);
    // The widened vocabulary is actually writable on the rebuilt table.
    db.prepare("UPDATE dream_jobs SET status='partially_applied' WHERE id='old-job'").run();
    assert.equal(readJob(db, key, 'old-job').status, 'partially_applied');
    assert.throws(
      () => db.prepare("UPDATE dream_jobs SET status='nonsense' WHERE id='old-job'").run(),
      /CHECK constraint/i,
    );
    // A second open is a no-op: the probe short-circuits.
    closeDb();
    const again = openDb(dbPath);
    assert.equal(readJob(again, key, 'old-job').status, 'partially_applied');
    assert.equal(Number(again.prepare('PRAGMA user_version').get().user_version), 17);
  } finally {
    closeDb();
    rmRf(home);
  }
});
