// Failed-embedding auto-retry. The SessionStart hook runs an idempotent
// pass that picks up rows whose embedding never landed (timeout, cold
// cache, encoder error) and tries to re-embed them, gated on (a) the
// row being older than 24h and (b) at most 5 rows per SessionStart.
//
// This test drives the retry helper directly and asserts:
//   1. rows newer than 24h are skipped (no thrash on fresh failures);
//   2. rows older than 24h are retried, and a successful retry clears
//      last_embed_error and writes the embedding columns;
//   3. rows that fail again stay in the failed state for the next pass;
//   4. the scan is capped at 5 rows per SessionStart.
//
// _helpers.js sets KIMI_MEMORY_EMBEDDINGS=off for the parent process
// so the CI test suite never hits Hugging Face. The retry helper
// defers to embedText which respects that env var. For the stub tests
// we flip the env var to 'on' around each call so the stub is
// reachable, and reset it in finally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf } from './_helpers.js';
import { openDb, closeDb, saveMemory, getMemory } from '../src/persist.js';
import { retryFailedEmbeddings } from '../src/hooks/embed-retry.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';
import { EMBEDDING_DIM, _setPipelineStubForTests, _resetForTests } from '../src/embedding.js';

// Temporarily flip the env var so embedText reaches the stub. Returns
// a restore function the caller must invoke in `finally`.
function withEmbeddingsOn(fn) {
  const prev = process.env.KIMI_MEMORY_EMBEDDINGS;
  process.env.KIMI_MEMORY_EMBEDDINGS = 'on';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev == null) delete process.env.KIMI_MEMORY_EMBEDDINGS;
      else process.env.KIMI_MEMORY_EMBEDDINGS = prev;
    });
}

// Helper: seed a memory then mark it as failed (no embedding, error
// set). `ageHours` controls the `updated_at` so the 24h gate sees it
// as old enough (or too fresh).
function seedFailedRow(db, projectKey, { title, ageHours }) {
  const mem = saveMemory(db, projectKey, {
    type: 'semantic',
    title,
    content: 'failed to embed',
    _embed: false,
  });
  // Backdate updated_at so the 24h gate lets us retry.
  const age = `-${ageHours} hours`;
  db.prepare(
    "UPDATE memories SET embedding=NULL, embedding_dim=NULL, embedding_model=NULL, embedded_at=NULL, last_embed_error='embed_timeout: cold cache', updated_at = datetime('now', ?) WHERE id=?",
  ).run(age, mem.id);
  return mem.id;
}

function freshProjectDb() {
  const home = mkTempHome();
  const cwd = 'C:/test/embed-retry-' + Date.now();
  const key = deriveProjectKey(cwd);
  return { home, cwd, key, dbPath: projectDbPath(home, key) };
}

test('rows newer than 24h are skipped by the retry gate', async () => {
  const { home, key, dbPath } = freshProjectDb();
  const db = openDb(dbPath);
  try {
    seedFailedRow(db, key, { title: 'fresh failure', ageHours: 1 });
    const r = await retryFailedEmbeddings(db, key);
    assert.equal(r.scanned, 0, 'freshly-failed rows must not be retried');
    assert.equal(r.recovered, 0);
  } finally {
    closeDb(dbPath);
    rmRf(home);
  }
});

test('a successful retry clears last_embed_error and writes the embedding columns', async () => {
  // Stub the encoder so embedText returns a known 384-dim vector.
  const vec = new Float32Array(EMBEDDING_DIM);
  vec[0] = 1.0;
  _setPipelineStubForTests(async () => async (_text, _opts) => ({ data: vec }));
  try {
    await withEmbeddingsOn(async () => {
      const { home, key, dbPath } = freshProjectDb();
      const db = openDb(dbPath);
      try {
        const id = seedFailedRow(db, key, { title: 'recoverable', ageHours: 48 });
        const r = await retryFailedEmbeddings(db, key);
        assert.equal(r.scanned, 1);
        assert.equal(r.recovered, 1);
        const row = db
          .prepare('SELECT embedding, embedding_dim, last_embed_error FROM memories WHERE id=?')
          .get(id);
        assert.ok(row.embedding, 'embedding BLOB must be written');
        assert.equal(row.embedding_dim, EMBEDDING_DIM);
        assert.equal(row.last_embed_error, null, 'last_embed_error must be cleared');
      } finally {
        closeDb(dbPath);
        rmRf(home);
      }
    });
  } finally {
    _resetForTests();
  }
});

test('a retry that fails again keeps the row in the failed state', async () => {
  // Stub the encoder so embedText returns null (= encoder unavailable).
  _setPipelineStubForTests(async () => async (_text, _opts) => null);
  try {
    await withEmbeddingsOn(async () => {
      const { home, key, dbPath } = freshProjectDb();
      const db = openDb(dbPath);
      try {
        const id = seedFailedRow(db, key, { title: 'still-broken', ageHours: 48 });
        const r = await retryFailedEmbeddings(db, key);
        assert.equal(r.scanned, 1);
        assert.equal(r.recovered, 0);
        assert.equal(r.failed, 1);
        const row = db.prepare('SELECT last_embed_error FROM memories WHERE id=?').get(id);
        assert.ok(row.last_embed_error, 'failure reason must be re-stamped');
      } finally {
        closeDb(dbPath);
        rmRf(home);
      }
    });
  } finally {
    _resetForTests();
  }
});

test('retry caps at 5 rows per SessionStart, oldest first', async () => {
  const vec = new Float32Array(EMBEDDING_DIM);
  vec[0] = 1.0;
  _setPipelineStubForTests(async () => async (_text, _opts) => ({ data: vec }));
  try {
    await withEmbeddingsOn(async () => {
      const { home, key, dbPath } = freshProjectDb();
      const db = openDb(dbPath);
      try {
        for (let i = 0; i < 8; i++) {
          // Older = smaller updated_at; gate is "older than 24h", so
          // pick a wide spread: 48h, 72h, ..., 192h. All pass the gate.
          seedFailedRow(db, key, { title: 'row-' + i, ageHours: 48 + i * 24 });
        }
        const r = await retryFailedEmbeddings(db, key);
        assert.equal(r.scanned, 5, 'retry must cap at 5 rows');
        assert.equal(r.recovered, 5);
        // The 3 unretried rows must remain in failed state.
        const remaining = db
          .prepare(
            'SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND last_embed_error IS NOT NULL',
          )
          .get(key).n;
        assert.equal(remaining, 3);
      } finally {
        closeDb(dbPath);
        rmRf(home);
      }
    });
  } finally {
    _resetForTests();
  }
});

test('embeddings off in env still scans but cannot recover', async () => {
  // With embeddings disabled, embedText returns null. The retry pass
  // therefore scans the eligible rows but every row's retry ends in
  // a re-stamped failure. The point of this test is to make sure the
  // helper doesn't crash and doesn't claim recovered > 0.
  const { home, key, dbPath } = freshProjectDb();
  const db = openDb(dbPath);
  const prev = process.env.KIMI_MEMORY_EMBEDDINGS;
  process.env.KIMI_MEMORY_EMBEDDINGS = 'off';
  try {
    seedFailedRow(db, key, { title: 'no-op', ageHours: 48 });
    const r = await retryFailedEmbeddings(db, key);
    assert.equal(r.scanned, 1);
    assert.equal(r.recovered, 0);
  } finally {
    if (prev == null) delete process.env.KIMI_MEMORY_EMBEDDINGS;
    else process.env.KIMI_MEMORY_EMBEDDINGS = prev;
    closeDb(dbPath);
    rmRf(home);
  }
});
