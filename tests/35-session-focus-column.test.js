// Tests for the v12 session-focus column migration.
//
// (Audit flag — session-focus indexability. The prior path used
// `instr(metadata, '"session_focus":true') > 0`, which is a function
// predicate that cannot ride any B-tree index. The v12 migration adds
// a dedicated `is_session_focus` column + composite index so the hook
// thread's lookup is a small range scan over the working-set prefix.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf } from './_helpers.js';
import { openDb, closeDb, saveMemory } from '../src/persist.js';
import { readLatestSessionFocus } from '../src/session-focus.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

function freshProject() {
  const home = mkTempHome();
  const cwd = 'C:/test/session-focus-col';
  const key = deriveProjectKey(cwd);
  return { home, cwd, key, dbPath: projectDbPath(home, key) };
}

test('v12 migration: is_session_focus column is stamped on metadata.session_focus:true', () => {
  const { home, cwd, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'working',
      title: 'Pick up the audit cycle',
      content: 'Continue with the flagged items.',
      tags: ['focus', 'session-focus', 'in-flight'],
      metadata: { session_focus: true, session_id: 'sess-1' },
      provenance: { source: 'session_focus_auto', session_id: 'sess-1' },
      confidence: 0.7,
      priority: 1,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      supersede: false,
      _embed: false,
    });
    const row = db.prepare('SELECT is_session_focus FROM memories WHERE project_key=?').get(key);
    assert.equal(row.is_session_focus, 1, 'dedicated column stamped from metadata flag');
    // The read path uses the column, not instr().
    const focus = readLatestSessionFocus(db, key);
    assert.ok(focus, 'readLatestSessionFocus picks the row up via the column');
    assert.equal(focus.title, 'Pick up the audit cycle');
    closeDb(dbPath);
  } finally {
    rmRf(home);
  }
});

test('v12 migration: legacy rows are backfilled on first open', () => {
  // Simulate a pre-v12 DB by inserting a row whose metadata carries the
  // canonical flag, then dropping the is_session_focus column to
  // zero, then re-opening so the migration backfills it. The migration
  // also tolerates a fresh DB with the column already present
  // (idempotent on re-open).
  const { home, cwd, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'working',
      title: 'Legacy focus row',
      content: 'Captured before the v12 column existed.',
      tags: [],
      metadata: { session_focus: true, session_id: 'sess-legacy' },
      provenance: { source: 'session_focus_auto' },
      confidence: 0.7,
      priority: 1,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      supersede: false,
      _embed: false,
    });
    // Force a "legacy" state — the row exists, metadata has the flag,
    // but the column was never written (we simulate by zeroing it).
    db.prepare('UPDATE memories SET is_session_focus = 0').run();
    closeDb(dbPath);

    // Re-open — the migration's backfill must stamp the column.
    const db2 = openDb(dbPath);
    const row = db2.prepare('SELECT is_session_focus FROM memories WHERE project_key=?').get(key);
    assert.equal(
      row.is_session_focus,
      1,
      'migration backfill stamps is_session_focus=1 from the metadata flag',
    );
    closeDb(dbPath);
  } finally {
    rmRf(home);
  }
});

test('v12 migration: idempotent — second open does not alter rows', () => {
  const { home, cwd, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'working',
      title: 'Stable focus',
      content: 'Same row across two opens.',
      tags: [],
      metadata: { session_focus: true, session_id: 'sess-2' },
      provenance: { source: 'session_focus_auto' },
      confidence: 0.7,
      priority: 1,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      supersede: false,
      _embed: false,
    });
    closeDb(dbPath);
    // Re-open twice — neither run may rewrite the column or insert a
    // duplicate index.
    openDb(dbPath);
    openDb(dbPath);
    const db3 = openDb(dbPath);
    const idxCount = db3
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_memories_session_focus'",
      )
      .get();
    assert.equal(idxCount.n, 1, 'index created exactly once');
    const row = db3.prepare('SELECT is_session_focus FROM memories WHERE project_key=?').get(key);
    assert.equal(row.is_session_focus, 1, 'column stays 1 across re-opens');
    closeDb(dbPath);
  } finally {
    rmRf(home);
  }
});

test('v12 migration: non-focus rows stay is_session_focus=0', () => {
  const { home, cwd, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'working',
      title: 'A note, not a focus',
      content: 'Plain working memory, no session_focus metadata flag.',
      tags: [],
      metadata: { other_flag: 'unrelated' },
      provenance: {},
      confidence: 0.8,
      priority: 0,
      expires_at: null,
      supersede: false,
      _embed: false,
    });
    const row = db.prepare('SELECT is_session_focus FROM memories WHERE project_key=?').get(key);
    assert.equal(row.is_session_focus, 0, 'rows without the metadata flag stay 0');
    closeDb(dbPath);
  } finally {
    rmRf(home);
  }
});
