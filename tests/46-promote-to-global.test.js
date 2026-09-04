// Regression: promoteMemoryToGlobal moves a row from the project DB
// to the _global DB with id preservation, two-phase commit, and
// source-deletion. Mirrors the existing share-move-metadata suite
// (tests/37) but targets the cross-project _global store rather than
// the deprecated _shared pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkTempHome, rmRf } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  listMemories,
  getMemory,
  promoteMemoryToGlobal,
  searchMemories,
} from '../src/persist.js';
import {
  projectDbPath,
  deriveProjectKey,
  globalDbPath,
  GLOBAL_PROJECT_KEY,
} from '../src/project-key.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/promote-to-global');
  return { home, key, dbPath: projectDbPath(home, key) };
}

test('promoteMemoryToGlobal: moves a row from project DB to _global DB, source deleted', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'user prefers dark mode',
      content: 'cross-project user preference',
      tags: ['user-preference', 'theme'],
      confidence: 0.85,
      priority: 5,
    });
    const r = promoteMemoryToGlobal(db, key, [m.id], { kimiHomeDir: home });
    assert.equal(r.moved.length, 1);
    assert.equal(r.moved[0].id, m.id);
    assert.equal(r.moved[0].new_global_id, m.id);
    assert.deepEqual(r.skipped, []);
    // Source DB no longer has the row.
    const srcGone = getMemory(db, key, m.id);
    assert.equal(srcGone, null, 'source row should be deleted after move');
    // Global DB has the row under project_key='_global'.
    const globalDb = openDb(globalDbPath(home));
    const globalRow = getMemory(globalDb, GLOBAL_PROJECT_KEY, m.id);
    assert.ok(globalRow, 'global row should exist');
    assert.equal(globalRow.title, 'user prefers dark mode');
    assert.equal(globalRow.type, 'semantic');
    assert.deepEqual(globalRow.tags, ['user-preference', 'theme']);
    assert.equal(globalRow.confidence, 0.85);
    assert.equal(globalRow.priority, 5);
    // Direct query confirms project_key is _global.
    const directRow = globalDb.prepare('SELECT project_key FROM memories WHERE id=?').get(m.id);
    assert.equal(directRow.project_key, GLOBAL_PROJECT_KEY);
    // Provenance carries the promotion trail.
    assert.equal(globalRow.provenance.promoted_from, key);
    assert.ok(globalRow.provenance.promoted_at, 'promoted_at is set');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('promoteMemoryToGlobal: missing ids land in skipped, not moved', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const r = promoteMemoryToGlobal(db, key, ['nonexistent-id-1234'], { kimiHomeDir: home });
    assert.deepEqual(r.moved, []);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].id, 'nonexistent-id-1234');
    assert.equal(r.skipped[0].reason, 'not_found');
    // Global DB was never touched (the lazy create flag still opens it,
    // but no memory row exists).
    const globalDb = openDb(globalDbPath(home));
    assert.equal(listMemories(globalDb, GLOBAL_PROJECT_KEY, {}).length, 0);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('promoteMemoryToGlobal: secret-shaped content is skipped, not moved', () => {
  // Defence-in-depth: the save-time assertNoSecret gate already blocks
  // most secret-shaped rows from ever being saved, but a row could
  // have been imported via the legacy bulk path under an older scanner
  // revision. The promote-time check refuses the move.
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    // Bypass the save-time secret gate by inserting the row directly
    // via SQL, simulating an older import path that predates the
    // secret-shape check.
    const id = 'legacy-imported-secret-row-1234';
    db.prepare(
      `INSERT INTO memories (id, project_key, type, title, content, tags, created_at, updated_at)
       VALUES (?, ?, 'semantic', 'credential note', 'token is sk-abcdefghijklmnopqrstuvwxyz1234', '[]', ?, ?)`,
    ).run(id, key, new Date().toISOString(), new Date().toISOString());
    const r = promoteMemoryToGlobal(db, key, [id], { kimiHomeDir: home });
    assert.deepEqual(r.moved, []);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].id, id);
    assert.equal(r.skipped[0].reason, 'secret_detected');
    // Source row was NOT deleted (we refused the move).
    const stillThere = getMemory(db, key, id);
    assert.ok(stillThere, 'secret-shaped source row stays in the project DB');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('promoteMemoryToGlobal: moved row is recallable from scope=global', async () => {
  // End-to-end: after a move, searchMemories on the global DB finds
  // the row by content. This is the contract the user relies on —
  // promote then recall from any project.
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'user prefers dark mode',
      content: 'cross-project user preference',
      tags: ['user-preference'],
    });
    promoteMemoryToGlobal(db, key, [m.id], { kimiHomeDir: home });
    const globalDb = openDb(globalDbPath(home));
    const hits = await searchMemories(globalDb, GLOBAL_PROJECT_KEY, 'dark mode', {
      limit: 5,
    });
    assert.ok(hits.length >= 1, 'recall should surface the promoted row');
    const hit = hits.find((h) => h.id === m.id);
    assert.ok(hit, 'the specific row id should be in the recall hits');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('promoteMemoryToGlobal: empty ids array returns empty result without touching the DB', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const r = promoteMemoryToGlobal(db, key, [], { kimiHomeDir: home });
    assert.deepEqual(r.moved, []);
    assert.deepEqual(r.skipped, []);
    // No project rows were touched.
    assert.equal(listMemories(db, key, {}).length, 0);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('promoteMemoryToGlobal: requires kimiHomeDir', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    assert.throws(() => promoteMemoryToGlobal(db, key, ['some-id'], {}), /kimiHomeDir is required/);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('promoteMemoryToGlobal: round-trips a non-trivial metadata object', () => {
  // Mirrors tests/37-share-move-metadata: the move path must preserve
  // metadata exactly. A bug in the new path that dropped or mangled
  // metadata would silently break the pending/ready pipeline that
  // downstream consumers depend on.
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'metadata round-trip',
      content: 'a row with rich metadata',
      metadata: { processing_status: 'ready', custom_flag: true, nested: { ok: 1 } },
    });
    promoteMemoryToGlobal(db, key, [m.id], { kimiHomeDir: home });
    const globalDb = openDb(globalDbPath(home));
    const globalRow = getMemory(globalDb, GLOBAL_PROJECT_KEY, m.id);
    assert.ok(globalRow);
    assert.equal(globalRow.metadata.processing_status, 'ready');
    assert.equal(globalRow.metadata.custom_flag, true);
    assert.deepEqual(globalRow.metadata.nested, { ok: 1 });
  } finally {
    closeDb();
    rmRf(home);
  }
});
