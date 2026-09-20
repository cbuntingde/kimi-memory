// Regression tests for four persist-layer defects fixed together:
//
//   1. searchMemories bound a caller-supplied limit straight to
//      `LIMIT ?` without truncating it, so `recall q --limit 2.5`
//      (src/cli-cmd/recall.js does `Number(args.flags.limit)`) reached
//      node:sqlite as a float and raised "datatype mismatch".
//   2. searchMemories / similarMemories decoded stored embedding BLOBs
//      with decodeVector(), which THROWS on a short or non-finite BLOB.
//      One corrupt row — a restored backup, an older format, a
//      degenerate normalize — failed the whole recall instead of
//      degrading, contradicting the channel's "best-effort, fail-open"
//      promise.
//   3. linkMemory did a read-then-INSERT, so losing a cross-process race
//      on the deterministic edge id raised a PRIMARY KEY error that
//      aborted mergeMemory's savepoint.
//   4. The v16 table rebuild dropped idx_memories_session_focus (v12)
//      without recreating it, so session-focus reads full-scanned until
//      the next openDb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { mkTempHome, rmRf } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  searchMemories,
  similarMemories,
  linkMemory,
} from '../src/persist.js';
import {
  EMBEDDING_DIM,
  encodeVector,
  _setPipelineStubForTests,
  _resetForTests,
} from '../src/embedding.js';
import { hashId, shortId } from '../src/util.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/persist-limits-edges');
  return { home, key, dbPath: projectDbPath(home, key) };
}

// Temporarily flip the env var so embedText() reaches the pipeline stub
// instead of short-circuiting to null. Mirrors tests/20-embed-retry.
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

// A pipeline stub whose vectors are finite and of the expected length, so
// embedRaw() accepts them and searchMemories takes the vector branch.
function stubEmbeddings() {
  _setPipelineStubForTests(async () => async (_text, _opts) => ({
    data: new Float32Array(EMBEDDING_DIM).fill(0.02),
  }));
}

function seed(db, key, title, content) {
  return saveMemory(db, key, { type: 'semantic', title, content, _embed: false });
}

// Overwrite a row's embedding with a deliberately truncated BLOB while
// leaving embedding_dim at the expected 384, so the recall scan's
// `embedding_dim = ?` filter still selects it.
function corruptEmbedding(db, id, bytes = 8) {
  db.prepare('UPDATE memories SET embedding=?, embedding_dim=? WHERE id=?').run(
    new Uint8Array(bytes),
    EMBEDDING_DIM,
    id,
  );
}

test('searchMemories: a fractional limit is truncated instead of bound as a float', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    seed(db, key, 'tabs one', 'we use tabs everywhere');
    seed(db, key, 'tabs two', 'tabs in the editor');
    seed(db, key, 'tabs three', 'more about tabs');
    // Before the fix this threw SQLITE_ERROR "datatype mismatch" out of
    // the FTS branch's `LIMIT ?` bind.
    const hits = await searchMemories(db, key, 'tabs', { limit: 2.5, minScore: 0 });
    assert.equal(hits.length, 2, 'limit 2.5 truncates to 2 rows');
    closeDb(dbPath);
  } finally {
    rmRf(home);
  }
});

test('searchMemories: a truncated embedding BLOB degrades instead of failing the recall', async () => {
  const { home, key, dbPath } = freshProject();
  stubEmbeddings();
  try {
    await withEmbeddingsOn(async () => {
      const db = openDb(dbPath);
      const good = seed(db, key, 'tabs policy', 'we use tabs');
      const bad = seed(db, key, 'tabs note', 'thoughts about tabs');
      corruptEmbedding(db, bad.id);
      // Before the fix decodeVector() threw KIMI_MEMORY_EMBED_CORRUPT out
      // of the vector loop and the entire recall call rejected.
      const hits = await searchMemories(db, key, 'tabs', { limit: 10, minScore: 0 });
      assert.ok(
        hits.some((h) => h.id === good.id),
        'the clean, keyword-matched row is still returned',
      );
      closeDb(dbPath);
    });
  } finally {
    _resetForTests();
    rmRf(home);
  }
});

test('similarMemories: a corrupt candidate embedding is skipped, not fatal', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const target = seed(db, key, 'reference', 'the row we search from');
    db.prepare('UPDATE memories SET embedding=?, embedding_dim=? WHERE id=?').run(
      encodeVector(new Float32Array(EMBEDDING_DIM).fill(0.1)),
      EMBEDDING_DIM,
      target.id,
    );
    const bad = seed(db, key, 'corrupt candidate', 'has a short embedding blob');
    corruptEmbedding(db, bad.id);
    const hits = await similarMemories(db, key, target.id, { limit: 5, threshold: 0 });
    assert.deepEqual(hits, [], 'the only candidate is corrupt, so nothing is returned');
    closeDb(dbPath);
  } finally {
    rmRf(home);
  }
});

test('similarMemories: a corrupt target embedding returns [] instead of throwing', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const bad = seed(db, key, 'corrupt target', 'the row we search from');
    corruptEmbedding(db, bad.id);
    seed(db, key, 'healthy neighbour', 'a fine row with no embedding');
    const hits = await similarMemories(db, key, bad.id, { limit: 5, threshold: 0 });
    assert.deepEqual(hits, [], 'no embedding to search from -> empty result, no throw');
    closeDb(dbPath);
  } finally {
    rmRf(home);
  }
});

test('linkMemory: re-linking the same quadruple is idempotent and updates weight in place', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const a = seed(db, key, 'from row', 'a');
    const b = seed(db, key, 'to row', 'b');
    const first = linkMemory(db, key, a.id, b.id, 'related');
    const second = linkMemory(db, key, a.id, b.id, 'related');
    assert.equal(second.id, first.id, 'the same quadruple maps to the same edge id');
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM memory_edges WHERE project_key=?')
      .get(key).n;
    assert.equal(count, 1, 'no duplicate edge row');
    const heavy = linkMemory(db, key, a.id, b.id, 'related', { weight: 4.5 });
    assert.equal(heavy.id, first.id, 'weight change reuses the existing edge');
    assert.equal(heavy.weight, 4.5);
    const stored = db.prepare('SELECT weight FROM memory_edges WHERE id=?').get(first.id);
    assert.equal(stored.weight, 4.5, 'the weight update was persisted');
    closeDb(dbPath);
  } finally {
    rmRf(home);
  }
});

test('linkMemory: a lost cross-process race returns the winner row instead of throwing', () => {
  const { home, key, dbPath } = freshProject();
  let other;
  try {
    const db = openDb(dbPath);
    const a = seed(db, key, 'racer from', 'a');
    const b = seed(db, key, 'racer to', 'b');
    const id = shortId(hashId('edge', key, a.id, b.id, 'related'), 16);
    // A second connection stands in for the other process. It commits the
    // winning row in the window between our read (which misses it) and our
    // INSERT — the interleaving the deterministic id makes possible. The
    // pre-fix read-then-INSERT loses that race with a PRIMARY KEY error
    // that escapes mergeMemory's savepoint; INSERT OR IGNORE absorbs it.
    other = new DatabaseSync(dbPath);
    let armed = true;
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (sql, ...rest) => {
          const st = target.prepare(sql, ...rest);
          if (armed && String(sql).includes('INTO memory_edges')) {
            armed = false;
            other
              .prepare(
                'INSERT INTO memory_edges (id, project_key, from_id, to_id, kind, weight, created_at) ' +
                  'VALUES (?, ?, ?, ?, ?, ?, ?)',
              )
              .run(id, key, a.id, b.id, 'related', 1.0, new Date().toISOString());
          }
          return st;
        };
      },
    });

    const edge = linkMemory(racing, key, a.id, b.id, 'related');
    assert.equal(edge.id, id, 'the winner row is returned');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_edges').get().n, 1);
    closeDb(dbPath);
  } finally {
    if (other) {
      try {
        other.close();
      } catch {
        /* ignore */
      }
    }
    rmRf(home);
  }
});

test('v16 rebuild recreates idx_memories_session_focus', () => {
  // Behavioural, not source-level. The v16 probe ("does the memories CHECK
  // list context_snapshot?") short-circuits on a fresh DB, so this seeds a
  // database file with a pre-v16 memories table (everything through v12's
  // is_session_focus column, CHECK without context_snapshot) and then
  // opens it. The v16 rebuild runs for real, DROP TABLE memories destroys
  // the v12 index, and the assertion below fails if the migration does not
  // recreate it.
  const { home, dbPath } = freshProject();
  try {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE memories (
        id            TEXT PRIMARY KEY,
        project_key   TEXT NOT NULL,
        type          TEXT NOT NULL CHECK (type IN ('working','episodic','semantic','procedural','conclusion','skill')),
        title         TEXT,
        content       TEXT NOT NULL,
        tags          TEXT NOT NULL DEFAULT '[]',
        metadata      TEXT NOT NULL DEFAULT '{}',
        provenance    TEXT NOT NULL DEFAULT '{}',
        confidence    REAL NOT NULL DEFAULT 0.8,
        status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','deleted')),
        priority      INTEGER NOT NULL DEFAULT 0,
        supersedes    TEXT,
        superseded_by TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        expires_at    TEXT,
        embedding       BLOB,
        embedding_model TEXT,
        embedding_dim   INTEGER,
        embedded_at     TEXT,
        access_count     INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        last_embed_error TEXT,
        stability_days    REAL NOT NULL DEFAULT 30,
        last_rehearsed_at TEXT,
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','team','restricted','agent','task')),
        shared_with TEXT NOT NULL DEFAULT '[]',
        team_id     TEXT,
        agent_id    TEXT,
        user_id     TEXT,
        session_id  TEXT,
        task_id     TEXT,
        tier        TEXT NOT NULL DEFAULT 'L0' CHECK (tier IN ('L0','L1','L2','L3')),
        persona_id  TEXT,
        is_session_focus INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO memories (id, project_key, type, title, content, created_at, updated_at)
        VALUES ('pre-v16-row', 'p', 'semantic', 'kept', 'survives the rebuild', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `);
    raw.close();

    const db = openDb(dbPath);
    const indexCount = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_memories_session_focus'",
      )
      .get().n;
    assert.equal(
      indexCount,
      1,
      'the v16 rebuild must recreate idx_memories_session_focus it dropped',
    );
    // The rebuild itself must have succeeded: the CHECK now accepts
    // context_snapshot and the copied column survived.
    const createSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'")
      .get().sql;
    assert.match(createSql, /context_snapshot/, 'rebuild restored the v16 CHECK');
    const row = db
      .prepare('SELECT title, is_session_focus FROM memories WHERE id=?')
      .get('pre-v16-row');
    assert.equal(row.title, 'kept', 'the row survived the rebuild');
    assert.equal(row.is_session_focus, 0, 'the v12 column survived the copy');
    closeDb(dbPath);
  } finally {
    rmRf(home);
  }
});
