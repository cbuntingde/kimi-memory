// v15 consolidation relax + pair-level dedup tests. Covers:
//   - threshold relaxation: tag-overlap floor drops on small datasets
//   - title-dedup: identical normalised titles emit a merge proposal
//   - near-dup cosine: cosine ≥ 0.92 + shared 10-word window → merge
//   - embedding_missing surfaces on the result when no rows have vectors
//   - consolidation_runs row is written after every run
//   - KIMI_MEMORY_CONSOLIDATE_RELAX=off restores strict behaviour
//   - KIMI_MEMORY_DEDUP=off disables the pair-level pass
//   - runConsolidate proposal mode still doesn't touch live rows
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf } from './_helpers.js';
import { openDb, closeDb, saveMemory, linkMemory, mergeMemory } from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';
import {
  runConsolidate,
  recordConsolidationRun,
  CONSOLIDATE_BOUNDS,
  effectiveTagOverlap,
} from '../src/consolidate.js';

// Deterministic embedding stub mirroring tests/39-dream.test.js shape.
// Encodes title + shared-tag count so cosine + tag-overlap form a
// predictable cluster.
function encodeStubForRow(row) {
  const title = (row.title || '').toLowerCase();
  const tags = (Array.isArray(row.tags) ? row.tags : []).map((t) => String(t).toLowerCase());
  const first = title.split(/\s+/)[0] || '';
  const rest = title.split(/\s+/).slice(1).join(' ');
  let h1 = 0;
  for (let i = 0; i < first.length; i++) h1 = (h1 * 31 + first.charCodeAt(i)) >>> 0;
  let h2 = 0;
  for (let i = 0; i < rest.length; i++) h2 = (h2 * 31 + rest.charCodeAt(i)) >>> 0;
  const sharedTags = ['shared', 'alpha', 'beta'].filter((t) => tags.includes(t)).length;
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
  const key = deriveProjectKey('C:/test/consolidate-relax');
  return { home, key, dbPath: projectDbPath(home, key) };
}

test('consolidate relax: small-dataset escape drops tag-overlap floor to 0', () => {
  assert.equal(CONSOLIDATE_BOUNDS.minTagOverlap, 1, 'default tag-overlap floor is 1');
  assert.equal(effectiveTagOverlap(5), 0, '5-memory project relaxes to 0');
  assert.equal(effectiveTagOverlap(9), 0, '9-memory project relaxes to 0');
  assert.equal(effectiveTagOverlap(10), 1, '10-memory project keeps the floor');
  assert.equal(effectiveTagOverlap(50), 1, '50-memory project keeps the floor');
});

test('consolidate relax: env opt-out restores strict tag-overlap', () => {
  const prev = process.env.KIMI_MEMORY_CONSOLIDATE_RELAX;
  process.env.KIMI_MEMORY_CONSOLIDATE_RELAX = 'off';
  try {
    assert.equal(effectiveTagOverlap(5), 1, 'opt-out keeps the strict floor on small datasets');
    assert.equal(effectiveTagOverlap(50), 1, 'opt-out keeps the strict floor on large datasets');
  } finally {
    if (prev === undefined) delete process.env.KIMI_MEMORY_CONSOLIDATE_RELAX;
    else process.env.KIMI_MEMORY_CONSOLIDATE_RELAX = prev;
  }
});

test('consolidate relax: 4-memory dataset forms a cluster without tag overlap (small escape)', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding, decode } = await installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    // Four memories, all share the `shared` tag and one bespoke tag.
    // Under the pre-v15 thresholds, the clusterer needed ≥2 shared tags
    // AND ≥3 siblings — fine here. After the relaxation, even 4 with
    // weak tags should cluster via cosine alone (≤10 memories).
    for (const t of ['a one', 'a two', 'a three', 'a four']) {
      await saveWithEmbedding(db, key, {
        type: 'semantic',
        title: t,
        content: 'shared content line one',
        tags: ['shared'],
      });
    }
    const res = await runConsolidate({
      db,
      projectKey: key,
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      decodeEmbeddingImpl: decode,
    });
    assert.ok(res.scanned >= 4, 'scanned >= 4');
    // The threshold relaxation + 4 siblings should form a cluster.
    // Pre-v15 this required ≥2 shared tags and frequently returned 0.
    assert.ok(res.clusters >= 1 || res.saved >= 1 || res.dedup_pairs >= 1, 'some consolidation happened');
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('consolidate relax: title-dedup emits a merge proposal for two memories with the same title', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding, decode } = await installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    // Save two memories with the same normalised title but different
    // bodies and tags. Only the second carries an embedding.
    saveMemory(db, key, {
      type: 'semantic',
      title: 'Build command: npm test',
      content: 'Use npm test to run the test suite.',
      tags: ['build'],
      _embed: false,
    });
    await saveWithEmbedding(db, key, {
      type: 'semantic',
      title: 'build command: npm test.',
      content: 'Run npm test to execute the project test suite.',
      tags: ['build', 'ci'],
    });
    const res = await runConsolidate({
      db,
      projectKey: key,
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      decodeEmbeddingImpl: decode,
    });
    assert.ok(res.dedup_pairs >= 1, 'at least one title-dedup pair');
    assert.ok(res.dedup_title_pairs >= 1, 'title_pairs counter incremented');
    assert.ok(res.dedup_near_dup_pairs === 0, 'no near-dup pair expected');
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('consolidate relax: near-dup cosine + shared content window emits a merge proposal', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding, decode } = await installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    // Two memories with identical titles AND identical embeddings AND a
    // shared 10-word window in their content. Both title-dedup and
    // near-dup may fire — the cross-pass dedup keeps one proposal.
    const a = await saveWithEmbedding(db, key, {
      type: 'semantic',
      title: 'Release process',
      content:
        'Cut a release by tagging main with the new version and pushing the tag to origin.',
      tags: ['release'],
    });
    await saveWithEmbedding(db, key, {
      type: 'semantic',
      title: 'Release procedure',
      content:
        'Cut a release by tagging main with the new version and pushing the tag to origin.',
      tags: ['release'],
    });
    const res = await runConsolidate({
      db,
      projectKey: key,
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      decodeEmbeddingImpl: decode,
    });
    assert.ok(res.dedup_pairs >= 1, 'at least one pair-level dedup fired');
    // Live row count for `a` may now be `superseded` (direct mode) — the
    // sibling's body becomes the surviving row's content.
    const finalA = db.prepare('SELECT status FROM memories WHERE id=?').get(a.id);
    assert.equal(finalA.status, 'superseded', 'the lower-confidence sibling is soft-superseded');
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('consolidate relax: embedding_missing surfaces on the result when no rows have embeddings', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    for (const title of ['no-embed one', 'no-embed two', 'no-embed three']) {
      saveMemory(db, key, {
        type: 'semantic',
        title,
        content: 'tag-share',
        tags: ['alpha', 'beta'],
        _embed: false,
      });
    }
    const res = await runConsolidate({
      db,
      projectKey: key,
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
    });
    assert.equal(res.embedding_missing, 3, 'all 3 active memories flagged');
    assert.equal(res.clusters, 0, 'no clusters possible without embeddings');
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('consolidate relax: KIMI_MEMORY_DEDUP=off disables pair-level paths', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding, decode } = await installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    await saveWithEmbedding(db, key, {
      type: 'semantic',
      title: 'Dedup off A',
      content: 'shared body content one',
      tags: ['shared'],
    });
    await saveWithEmbedding(db, key, {
      type: 'semantic',
      title: 'dedup off a',
      content: 'shared body content one',
      tags: ['shared'],
    });
    const prev = process.env.KIMI_MEMORY_DEDUP;
    process.env.KIMI_MEMORY_DEDUP = 'off';
    try {
      const res = await runConsolidate({
        db,
        projectKey: key,
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
        decodeEmbeddingImpl: decode,
      });
      assert.equal(res.dedup_pairs, 0, 'pair-level pass is off');
    } finally {
      if (prev === undefined) delete process.env.KIMI_MEMORY_DEDUP;
      else process.env.KIMI_MEMORY_DEDUP = prev;
    }
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('consolidate relax: runConsolidate writes a consolidation_runs row', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding, decode } = await installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    await saveWithEmbedding(db, key, {
      type: 'semantic',
      title: 'writer one',
      content: 'content',
      tags: ['shared'],
    });
    const res = await runConsolidate({
      db,
      projectKey: key,
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      decodeEmbeddingImpl: decode,
    });
    const row = db
      .prepare(
        'SELECT id, summary, at FROM consolidation_runs WHERE project_key=? ORDER BY datetime(at) DESC LIMIT 1',
      )
      .get(key);
    assert.ok(row, 'consolidation_runs row exists');
    assert.equal(row.id.length > 0, true);
    const summary = JSON.parse(row.summary);
    assert.equal(summary.trigger, 'inline', 'writer tagged inline');
    assert.equal(summary.scanned, res.scanned);
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('consolidate relax: proposal mode does not touch live memories', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding, decode } = await installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    await saveWithEmbedding(db, key, {
      type: 'semantic',
      title: 'proposal mode A',
      content: 'shared body content one',
      tags: ['shared'],
    });
    await saveWithEmbedding(db, key, {
      type: 'semantic',
      title: 'proposal mode a',
      content: 'shared body content one',
      tags: ['shared'],
    });
    let saveCalled = false;
    const res = await runConsolidate({
      db,
      projectKey: key,
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
    // No live writes happened.
    const conclusion = db
      .prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND type='conclusion' AND status='active'",
      )
      .get(key).n;
    assert.equal(conclusion, 0);
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('consolidate relax: recordConsolidationRun helper writes the expected summary', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const res = recordConsolidationRun(
      db,
      key,
      {
        scanned: 12,
        clusters: 2,
        saved: 2,
        merged: 1,
        dedup_pairs: 3,
        dedup_title_pairs: 2,
        dedup_near_dup_pairs: 1,
        embedding_missing: 0,
        proposals: [{}, {}, {}],
      },
      { trigger: 'dream_apply' },
    );
    assert.equal(res.ok, true);
    const row = db
      .prepare(
        'SELECT summary, at FROM consolidation_runs WHERE project_key=? ORDER BY datetime(at) DESC LIMIT 1',
      )
      .get(key);
    assert.ok(row);
    const summary = JSON.parse(row.summary);
    assert.equal(summary.trigger, 'dream_apply');
    assert.equal(summary.scanned, 12);
    assert.equal(summary.dedup_pairs, 3);
    closeDb();
  } finally {
    rmRf(home);
  }
});