// Regression: acl_share_memory with to_shared_pool=true must preserve
// every durable column on the row, including the metadata.processing_status
// flag the v10 pipeline writes. A bug in the move path could leave the
// shared-DB row with a stale or missing flag, breaking the pending/ready
// pipeline the dashboard relies on.
//
// (Audit fix C4 — the move path inserts every column verbatim, but
// nothing tests it round-trips a non-trivial metadata object.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  shareMemory,
  openSharedDb,
  listMemories,
  getMemory,
} from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';
import { SHARED_PROJECT_KEY } from '../src/persist/connection.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/share-move-metadata');
  return { home, key, dbPath: projectDbPath(home, key) };
}

test('acl_share_memory to_shared_pool preserves metadata.processing_status on the shared row', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'pipeline row',
      content: 'a row with a processing_status flag',
      metadata: { processing_status: 'ready', extra: 'data' },
    });
    // Move into the cross-project shared pool.
    const r = shareMemory(db, key, [m.id], {
      visibility: 'team',
      toSharedPool: true,
      kimiHomeDir: home,
    });
    assert.equal(r.moved, 1);
    // Source DB row deleted.
    const srcGone = getMemory(db, key, m.id);
    assert.equal(srcGone, null, 'source row should be deleted after move');
    // Shared DB row carries the metadata.processing_status intact.
    const sharedDb = openSharedDb(home);
    const shared = listMemories(sharedDb, SHARED_PROJECT_KEY, { includeExpired: true }).find(
      (r) => r.id === m.id,
    );
    assert.ok(shared, 'shared row should exist');
    assert.equal(shared.metadata.processing_status, 'ready');
    assert.equal(shared.metadata.extra, 'data');
    assert.equal(shared.visibility, 'team');
    // rowToMemory does not surface project_key; confirm the row landed
    // in the shared DB via a direct query against the source table.
    const src = sharedDb.prepare('SELECT project_key FROM memories WHERE id = ?').get(m.id);
    assert.equal(src.project_key, SHARED_PROJECT_KEY);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('acl_share_memory to_shared_pool is a no-op when the row already exists in the shared DB', () => {
  // The INSERT OR IGNORE path means a re-share is safe: the shared
  // row keeps its prior content (the "target stays at the version it
  // already had" contract from share.js). This test pins that contract
  // so a future refactor doesn't silently start clobbering.
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'first version',
      content: 'original content',
    });
    const r1 = shareMemory(db, key, [m.id], {
      visibility: 'team',
      toSharedPool: true,
      kimiHomeDir: home,
    });
    assert.equal(r1.moved, 1);
    // Save a NEW row with the SAME id (simulate: an external re-save
    // created a row in the source DB with the shared row's id). In
    // practice this is rare, but the move path's "INSERT OR IGNORE"
    // contract must hold — the shared row keeps its existing content.
    db.prepare(
      'INSERT INTO memories (id, project_key, type, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      m.id,
      key,
      'semantic',
      'newer version',
      'newer content',
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const r2 = shareMemory(db, key, [m.id], {
      visibility: 'private',
      toSharedPool: true,
      kimiHomeDir: home,
    });
    assert.equal(r2.moved, 1, 'move still counts even when INSERT no-ops');
    const sharedDb = openSharedDb(home);
    const shared = listMemories(sharedDb, SHARED_PROJECT_KEY, { includeExpired: true }).find(
      (r) => r.id === m.id,
    );
    assert.ok(shared, 'shared row should still exist');
    // Original version is preserved (the shared row was not clobbered).
    assert.equal(shared.content, 'original content');
    assert.equal(shared.visibility, 'team', 'visibility is NOT downgraded on no-op INSERT');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('acl_share_memory to_shared_pool round-trips tags as space-joined tokens in FTS', () => {
  // The audit comment at share.js:222 documents that tags must be
  // written as space-joined tokens (not the JSON literal) so FTS5
  // matches them. This test verifies that contract by running a
  // hybrid recall over the shared DB and confirming the tag tokens
  // participate in the FTS match.
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'fts tag row',
      content: 'recallable via tag',
      tags: ['build-orchestrator', 'recall-target'],
    });
    const r = shareMemory(db, key, [m.id], {
      visibility: 'team',
      toSharedPool: true,
      kimiHomeDir: home,
    });
    assert.equal(r.moved, 1);
    const sharedDb = openSharedDb(home);
    // Confirm the FTS row in the shared DB carries the tokens
    // (space-joined), not the JSON literal. Inspect via the
    // memories_fts virtual table directly.
    const ftsRow = sharedDb.prepare('SELECT tags FROM memories_fts WHERE id = ?').get(m.id);
    assert.ok(ftsRow, 'shared FTS row should exist');
    assert.match(ftsRow.tags, /build-orchestrator/, 'tag token must be in FTS');
    assert.match(ftsRow.tags, /recall-target/, 'tag token must be in FTS');
    assert.doesNotMatch(ftsRow.tags, /\[\"|\",/, 'FTS row must NOT carry the JSON literal');
  } finally {
    closeDb();
    rmRf(home);
  }
});
