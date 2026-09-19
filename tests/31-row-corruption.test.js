// Tests for rowToMemory's resilience to corrupt JSON columns. A single
// bad tags / metadata / provenance column should not crash the entire
// `memory_recall` result set. (Audit finding B2-3.)
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
} from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/corrupt-json');
  return { home, key, dbPath: projectDbPath(home, key) };
}

test('rowToMemory: corrupt tags column degrades to []', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, { type: 'semantic', title: 't', content: 'c' });
    db.prepare("UPDATE memories SET tags='{not valid json' WHERE id=?").run(m.id);
    const got = getMemory(db, key, m.id);
    assert.ok(got, 'row was still returned');
    assert.deepEqual(got.tags, [], 'corrupt tags degraded to []');
    assert.equal(got.content, 'c', 'other fields unaffected');
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('rowToMemory: corrupt provenance column degrades to {}', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, { type: 'semantic', title: 't', content: 'c' });
    db.prepare("UPDATE memories SET provenance='oops not json' WHERE id=?").run(m.id);
    const got = getMemory(db, key, m.id);
    assert.ok(got);
    assert.deepEqual(got.provenance, {}, 'corrupt provenance degraded to {}');
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('rowToMemory: corrupt metadata column degrades to {}', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, { type: 'semantic', title: 't', content: 'c' });
    db.prepare("UPDATE memories SET metadata='not json {' WHERE id=?").run(m.id);
    const got = getMemory(db, key, m.id);
    assert.ok(got);
    assert.deepEqual(got.metadata, {}, 'corrupt metadata degraded to {}');
    // processing_status is normally surfaced from metadata; on
    // corruption it should fall back to the documented default.
    assert.equal(got.processing_status, 'ready', 'processing_status defaulted to ready');
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('listMemories: a corrupt row does not break the rest of the result set', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', title: 'clean-1', content: 'ok' });
    const bad = saveMemory(db, key, { type: 'semantic', title: 'bad', content: 'ok' });
    saveMemory(db, key, { type: 'semantic', title: 'clean-2', content: 'ok' });
    db.prepare("UPDATE memories SET tags='[' WHERE id=?").run(bad.id);
    const rows = listMemories(db, key, { limit: 50 });
    assert.equal(rows.length, 3, 'all three rows returned despite one corrupt');
    const titles = rows.map((r) => r.title).sort();
    assert.deepEqual(titles, ['bad', 'clean-1', 'clean-2']);
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('searchMemories: a corrupt row does not break the recall result set', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', title: 'tabs policy', content: 'we use tabs' });
    const bad = saveMemory(db, key, {
      type: 'semantic',
      title: 'tabs note',
      content: 'something about tabs',
    });
    saveMemory(db, key, { type: 'semantic', title: 'spaces note', content: 'spaces info' });
    db.prepare("UPDATE memories SET tags='{garbage' WHERE id=?").run(bad.id);
    const hits = await searchMemories(db, key, 'tabs', { limit: 10, minScore: 0 });
    assert.ok(hits.length >= 2, 'the two non-corrupt tabs rows still surfaced');
    closeDb();
  } finally {
    rmRf(home);
  }
});
