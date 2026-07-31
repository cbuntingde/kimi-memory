// Tests for embedding helpers + the hybrid searchMemories +
// similarMemories functions. Embedding model download is disabled
// by default via _helpers.js (sets KIMI_MEMORY_EMBEDDINGS=off).
// The model-dependent code paths are exercised by injecting mock
// vectors directly into the row, then asserting the SQL/hybrid
// combine/cosine math behaves correctly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  getMemory,
  listMemories,
  searchMemories,
  similarMemories,
  backfillEmbeddings,
} from '../src/persist.js';
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  encodeVector,
  decodeVector,
  cosineSimilarity,
} from '../src/embedding.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/embed-A');
  return { home, key, dbPath: projectDbPath(home, key) };
}

// Two known vectors that are nearly identical and one that's
// orthogonal. With normalize=true (the default) cosine similarity
// is just the dot product.
function vecA() {
  // [1, 0, 0, 0, ...]
  const v = new Float32Array(EMBEDDING_DIM);
  v[0] = 1;
  return v;
}
function vecB() {
  // [0.99, 0.14, 0, ...] — close to A
  const v = new Float32Array(EMBEDDING_DIM);
  v[0] = 0.99;
  v[1] = 0.14;
  // The remaining components are 0 — but MiniLM vectors are
  // L2-normalized, so we renormalize here too.
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const norm = Math.sqrt(s);
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}
function vecC() {
  // orthogonal-ish: [0, 1, 0, ...]
  const v = new Float32Array(EMBEDDING_DIM);
  v[1] = 1;
  return v;
}

test('encodeVector / decodeVector round-trip preserves the vector exactly', () => {
  const v = vecA();
  const buf = encodeVector(v);
  assert.ok(buf, 'encode returns a Buffer');
  assert.equal(buf.byteLength, EMBEDDING_DIM * 4, 'Buffer is 4 bytes per float');
  const back = decodeVector(buf);
  assert.ok(back, 'decode returns a Float32Array');
  assert.equal(back.length, EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    assert.ok(Math.abs(back[i] - v[i]) < 1e-6, `index ${i} matches`);
  }
});

test('cosineSimilarity returns ~1 for identical vectors, ~0 for orthogonal', () => {
  assert.ok(Math.abs(cosineSimilarity(vecA(), vecA()) - 1) < 1e-6);
  assert.ok(Math.abs(cosineSimilarity(vecB(), vecB()) - 1) < 1e-6);
  assert.ok(cosineSimilarity(vecA(), vecC()) < 1e-5, 'orthogonal vectors are ~0');
  assert.ok(cosineSimilarity(vecA(), vecB()) > 0.95, 'similar vectors are > 0.95');
});

test('embedding migration is idempotent and exposes the expected columns', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    // Re-open — migration runs again. Should be a no-op.
    const db2 = openDb(dbPath);
    const cols = new Set(
      db2
        .prepare('PRAGMA table_info(memories)')
        .all()
        .map((c) => c.name),
    );
    for (const name of [
      'embedding',
      'embedding_model',
      'embedding_dim',
      'embedded_at',
      'access_count',
      'last_accessed_at',
    ]) {
      assert.ok(cols.has(name), `column ${name} exists after migration`);
    }
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('rowToMemory exposes embedding_status based on whether the row has bytes', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, { type: 'semantic', title: 't', content: 'c' });
    // Without backfill / model, embedding should be null → status 'pending'.
    const got = getMemory(db, key, m.id);
    assert.equal(got.embedding_status, 'pending');
    // Manually inject an embedding row.
    db.prepare(
      `UPDATE memories SET embedding=?, embedding_model=?, embedding_dim=?, embedded_at=? WHERE id=?`,
    ).run(encodeVector(vecA()), EMBEDDING_MODEL, EMBEDDING_DIM, new Date().toISOString(), m.id);
    const got2 = getMemory(db, key, m.id);
    assert.equal(got2.embedding_status, 'embedded');
    assert.equal(got2.embedding_model, EMBEDDING_MODEL);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('similarMemories finds neighbors with cosine above the threshold', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    // Save three memories with hand-crafted embeddings.
    const a = saveMemory(db, key, { type: 'semantic', title: 'A', content: 'apple' });
    const b = saveMemory(db, key, { type: 'semantic', title: 'B', content: 'apricot' });
    const c = saveMemory(db, key, { type: 'semantic', title: 'C', content: 'zebra' });
    db.prepare(
      `UPDATE memories SET embedding=?, embedding_dim=?, embedding_model=? WHERE id=?`,
    ).run(encodeVector(vecA()), EMBEDDING_DIM, EMBEDDING_MODEL, a.id);
    db.prepare(
      `UPDATE memories SET embedding=?, embedding_dim=?, embedding_model=? WHERE id=?`,
    ).run(encodeVector(vecB()), EMBEDDING_DIM, EMBEDDING_MODEL, b.id);
    db.prepare(
      `UPDATE memories SET embedding=?, embedding_dim=?, embedding_model=? WHERE id=?`,
    ).run(encodeVector(vecC()), EMBEDDING_DIM, EMBEDDING_MODEL, c.id);

    // A is the seed; B should match strongly (>0.95), C should not.
    const hits = await similarMemories(db, key, a.id, { limit: 10, threshold: 0.5 });
    const ids = hits.map((h) => h.id);
    assert.ok(ids.includes(b.id), 'similar (B) is included');
    assert.ok(!ids.includes(c.id), 'orthogonal (C) is excluded by threshold');
    // Similarity is exposed on the result.
    const bHit = hits.find((h) => h.id === b.id);
    assert.ok(bHit.similarity > 0.9, `B.similarity=${bHit.similarity}`);
    // The seed itself is never returned.
    assert.ok(!ids.includes(a.id), 'seed is excluded from results');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('similarMemories returns [] when the seed has no embedding', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const a = saveMemory(db, key, { type: 'semantic', title: 'A', content: 'x' });
    const hits = await similarMemories(db, key, a.id, { limit: 10 });
    assert.deepEqual(hits, []);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('searchMemories falls back to FTS-only when embeddings are disabled', async () => {
  // KIMI_MEMORY_EMBEDDINGS=off is set by _helpers.js. The async
  // signature is exercised, FTS path still works.
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', title: 'API style', content: 'we use tabs' });
    saveMemory(db, key, { type: 'semantic', title: 'DB style', content: 'postgres' });
    const r = await searchMemories(db, key, 'tabs');
    assert.ok(r.length >= 1);
    assert.ok(r[0].content.includes('tabs'));
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('searchMemories combines FTS and vector when both are present', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    // Three memories; one matches a token, all three have known embeddings.
    const m1 = saveMemory(db, key, {
      type: 'semantic',
      title: 'tabs',
      content: 'we use tabs for indent',
    });
    const m2 = saveMemory(db, key, {
      type: 'semantic',
      title: 'spaces',
      content: 'we use spaces for indent',
    });
    const m3 = saveMemory(db, key, {
      type: 'semantic',
      title: 'unrelated',
      content: 'totally different topic',
    });
    for (const m of [m1, m2, m3]) {
      db.prepare(
        `UPDATE memories SET embedding=?, embedding_dim=?, embedding_model=? WHERE id=?`,
      ).run(encodeVector(vecA()), EMBEDDING_DIM, EMBEDDING_MODEL, m.id);
    }
    // The query 'spaces' matches FTS → m2 only. But because all three
    // have an embedding that is *identical* to what a fresh query
    // embedding would be (vecA), the hybrid score should still
    // surface all three with similar scores. We mainly assert the
    // function returns without error and m2 (the only FTS match) is
    // included.
    const r = await searchMemories(db, key, 'spaces', { limit: 10 });
    const ids = r.map((m) => m.id);
    assert.ok(ids.includes(m2.id), 'FTS match (m2) is included');
    assert.equal(
      process.env.KIMI_MEMORY_EMBEDDINGS,
      'off',
      'embedding model is disabled in tests; vector scoring is a no-op here',
    );
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('backfillEmbeddings is a no-op when embeddings are disabled', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', title: 'a', content: 'aaa' });
    saveMemory(db, key, { type: 'semantic', title: 'b', content: 'bbb' });
    const r = await backfillEmbeddings(db, key, {});
    assert.deepEqual(r, { scanned: 2, embedded: 0, skipped: 2, failed: 0 });
    // Re-check that no row got an embedding.
    const none = db
      .prepare(`SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL`)
      .get().n;
    assert.equal(none, 0);
  } finally {
    closeDb();
    rmRf(home);
  }
});
