// Regression tests for three defects in `saveMemory`
// (src/persist/memories.js).
//
//   1. Silent data loss. saveMemory opened two savepoints in sequence
//      — `save_memory_supersede` (the UPDATE that marks the prior row
//      `superseded`, plus its edge insert) and `save_memory_upsert`
//      (the row write, FTS reseed, synthesizes). `withSavepoint`
//      RELEASEs the savepoint on its success path, and a RELEASE
//      commits, so the supersede UPDATE was durable before the row
//      write began. A throw in the row write left the prior memory
//      `superseded` pointing at an id that was never inserted: no
//      active rows at all, and the replacement does not exist.
//
//   2. FTS index diverging from the row. The reseed fed `input.*`
//      into `memories_fts` while the UPDATE branch used COALESCE, so
//      a partial re-save wrote '' / NULL into the index while
//      `memories` kept the real value — search then cannot find a row
//      that exists. A string `tags` also threw a TypeError from
//      `.join`, and an omitted `type` threw ERR_INVALID_ARG_TYPE out
//      of node:sqlite.
//
//   3. `expires_at` could never be cleared. The UPDATE branch used
//      COALESCE(?, expires_at), and COALESCE cannot write NULL, so an
//      explicit `expires_at: null` kept the old value and
//      memory_update could not drop an expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf } from './_helpers.js';
// Imported from the narrow modules rather than the `src/persist.js`
// barrel: the barrel also pulls in search.js, whose import graph is
// irrelevant to these three defects.
import { openDb, closeDb } from '../src/persist/connection.js';
import { saveMemory, getMemory } from '../src/persist/memories.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

function freshDb() {
  const home = mkTempHome('kimi-59-');
  const key = deriveProjectKey('C:/test/supersede-atomic');
  const dbPath = projectDbPath(home, key);
  return { home, key, dbPath, db: openDb(dbPath) };
}

// ────────────────────────────────────────────────────────────────────
// 1 — the supersede UPDATE and the row write are one atomic unit
// ────────────────────────────────────────────────────────────────────

test('a throw in the row write cannot leave the prior memory superseded', () => {
  const { home, key, dbPath, db } = freshDb();
  try {
    const prior = saveMemory(db, key, {
      type: 'semantic',
      title: 'T',
      content: 'one',
      tags: ['a'],
    });

    // Force the *next* insert of a `memories` row to fail, the same
    // way a UNIQUE collision, an FK violation, or a mid-save I/O
    // error would. A trigger is used rather than a malformed input so
    // the failure lands at a fixed point — after the supersede UPDATE
    // has run — instead of somewhere earlier in the function.
    db.exec(`
      CREATE TRIGGER fail_next_insert BEFORE INSERT ON memories
      WHEN NEW.content = 'two'
      BEGIN SELECT RAISE(ABORT, 'induced row-write failure'); END
    `);

    assert.throws(
      () =>
        saveMemory(db, key, {
          type: 'semantic',
          title: 'T',
          content: 'two',
          tags: ['b'],
          supersede: true,
        }),
      /induced row-write failure/,
    );

    const active = db
      .prepare("SELECT id FROM memories WHERE project_key=? AND status='active'")
      .all(key);
    assert.equal(
      active.length,
      1,
      'the prior row must stay active when its replacement was never written',
    );

    const row = getMemory(db, key, prior.id);
    assert.equal(row.status, 'active');
    assert.equal(row.superseded_by, null, 'no dangling superseded_by backlink');

    // No half-written replacement, and no supersede edge pointing at
    // a row that does not exist.
    const edges = db
      .prepare("SELECT from_id, to_id FROM memory_edges WHERE project_key=? AND kind='supersedes'")
      .all(key);
    assert.equal(edges.length, 0, 'a rolled-back save must leave no supersedes edge');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key=?').get(key).n,
      1,
    );

    // The failed save must not strand an open savepoint on the shared
    // connection: the next write has to succeed.
    const after = saveMemory(db, key, {
      type: 'semantic',
      title: 'T',
      content: 'three',
      tags: ['c'],
      supersede: true,
    });
    assert.equal(getMemory(db, key, after.id).status, 'active');
    const retired = getMemory(db, key, prior.id, { includeSuperseded: true });
    assert.equal(retired.status, 'superseded');
    assert.equal(retired.superseded_by, after.id);
  } finally {
    closeDb(dbPath);
    rmRf(home);
  }
});

// ────────────────────────────────────────────────────────────────────
// 2 — the FTS row mirrors the persisted row
// ────────────────────────────────────────────────────────────────────

test('the FTS index is seeded from the stored row, not from the input', () => {
  const { home, key, dbPath, db } = freshDb();
  try {
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'alpha bravo',
      content: 'charlie delta',
      tags: ['echo', 'foxtrot'],
    });

    // Partial re-save that omits `title` and `tags` but keeps `type`:
    // the COALESCE UPDATE branch keeps the stored title and tags, so
    // the reseed has to agree with what `memories` now holds. Seeding
    // from `input` instead left the index with title='' and tags=''
    // while the row kept 'alpha bravo' / '["echo","foxtrot"]' — a
    // silent divergence rather than a crash.
    saveMemory(db, key, { id: m.id, type: 'semantic', content: 'golf hotel' });

    const stored = db
      .prepare('SELECT type, title, content, tags FROM memories WHERE id=?')
      .get(m.id);
    const fts = db
      .prepare('SELECT type, title, content, tags FROM memories_fts WHERE id=?')
      .get(m.id);

    assert.equal(stored.title, 'alpha bravo');
    assert.equal(stored.tags, '["echo","foxtrot"]');
    assert.equal(fts.title, stored.title, 'FTS title must not diverge from memories.title');
    assert.equal(fts.type, stored.type, 'FTS type must not diverge from memories.type');
    assert.equal(fts.content, stored.content);
    assert.equal(
      fts.tags,
      JSON.parse(stored.tags).join(' '),
      'FTS tags must be seeded from the stored tags JSON',
    );

    // The keyword is still findable through the index.
    const hits = db
      .prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH 'bravo'")
      .all()
      .map((r) => r.id);
    assert.deepEqual(hits, [m.id]);

    // A string `tags` used to throw a TypeError out of `.join`, and an
    // omitted `type` threw ERR_INVALID_ARG_TYPE out of node:sqlite.
    // Both are now tolerated because the seed only ever reads the
    // stored row.
    saveMemory(db, key, {
      id: m.id,
      type: 'semantic',
      content: 'golf hotel',
      tags: 'not-an-array',
    });
    assert.equal(
      db.prepare('SELECT tags FROM memories_fts WHERE id=?').get(m.id).tags,
      '',
      'a non-array tags value degrades to an empty FTS tags column',
    );
    saveMemory(db, key, { id: m.id, content: 'india juliet' });
    assert.equal(
      db.prepare('SELECT type FROM memories_fts WHERE id=?').get(m.id).type,
      'semantic',
      'an omitted type must not blank the FTS column',
    );
  } finally {
    closeDb(dbPath);
    rmRf(home);
  }
});

// ────────────────────────────────────────────────────────────────────
// 3 — an explicit `expires_at: null` clears the column
// ────────────────────────────────────────────────────────────────────

test('an explicit expires_at:null clears the expiry while an omitted key preserves it', () => {
  const { home, key, dbPath, db } = freshDb();
  try {
    const expiry = '2999-01-01T00:00:00.000Z';
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'expiring',
      content: 'expires later',
      expires_at: expiry,
    });
    assert.equal(getMemory(db, key, m.id).expires_at, expiry);

    // Every re-save here carries a full field set (so it isolates the
    // expires_at handling rather than tripping the separate
    // partial-input defect) and an explicit `id`, which keeps the
    // write on the UPDATE branch.

    // Omitting the key leaves the stored value alone — the behaviour
    // every existing caller relies on.
    saveMemory(db, key, {
      id: m.id,
      type: 'semantic',
      title: 'expiring',
      content: 'still expires later',
      tags: [],
    });
    assert.equal(getMemory(db, key, m.id).expires_at, expiry);

    // An explicit null is a request to clear it.
    saveMemory(db, key, {
      id: m.id,
      type: 'semantic',
      title: 'expiring',
      content: 'still expires later',
      tags: [],
      expires_at: null,
    });
    assert.equal(getMemory(db, key, m.id).expires_at, null);

    // And a fresh value still writes normally afterwards.
    saveMemory(db, key, {
      id: m.id,
      type: 'semantic',
      title: 'expiring',
      content: 'still expires later',
      tags: [],
      expires_at: expiry,
    });
    assert.equal(getMemory(db, key, m.id).expires_at, expiry);
  } finally {
    closeDb(dbPath);
    rmRf(home);
  }
});
