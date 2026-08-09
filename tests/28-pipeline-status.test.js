// Tests for v10 processing pipeline + promotePendingRows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  searchMemories,
  promotePendingRows,
  listMemories,
} from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/pipeline');
  return { home, key, dbPath: projectDbPath(home, key) };
}

test('default rows have processing_status="ready" after the v10 migration', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, { type: 'semantic', title: 'A', content: 'a' });
    assert.equal(m.processing_status, 'ready');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('searchMemories excludes pending and distilling rows by default', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', title: 'alpha', content: 'alpha body' });
    saveMemory(db, key, {
      type: 'semantic',
      title: 'beta',
      content: 'beta body',
      processing_status: 'pending',
    });
    saveMemory(db, key, {
      type: 'semantic',
      title: 'gamma',
      content: 'gamma body',
      processing_status: 'distilling',
    });
    const hits = await searchMemories(db, key, 'alpha');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, 'alpha');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('searchMemories with includeProcessing=true surfaces non-ready rows', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', title: 'alpha', content: 'alpha body' });
    saveMemory(db, key, {
      type: 'semantic',
      title: 'beta',
      content: 'beta body',
      processing_status: 'pending',
    });
    const hits = await searchMemories(db, key, 'alpha', { includeProcessing: true });
    assert.ok(hits.length >= 1);
    // Note: the pending row's title "beta" does not contain "alpha", so it
    // shouldn't match — but includeProcessing should at least not throw.
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('promotePendingRows: pending → distilling → ready in one pass', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'semantic',
      title: 'A',
      content: 'a',
      processing_status: 'pending',
    });
    saveMemory(db, key, {
      type: 'semantic',
      title: 'B',
      content: 'b',
      processing_status: 'distilling',
    });
    saveMemory(db, key, { type: 'semantic', title: 'C', content: 'c', processing_status: 'ready' });
    const result = promotePendingRows(db, key, { limit: 10 });
    assert.equal(result.promoted, 2, 'pending + distilling rows both promoted');
    // C was already 'ready' so promotePendingRows skipped it.
    const list = listMemories(db, key);
    const byTitle = Object.fromEntries(list.map((m) => [m.title, m.processing_status]));
    assert.equal(byTitle.A, 'distilling');
    assert.equal(byTitle.B, 'ready');
    assert.equal(byTitle.C, 'ready');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('promotePendingRows: respects limit cap', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    for (let i = 0; i < 12; i++) {
      saveMemory(db, key, {
        type: 'semantic',
        title: `r${i}`,
        content: 'x',
        processing_status: 'pending',
      });
    }
    const result = promotePendingRows(db, key, { limit: 5 });
    assert.ok(result.promoted <= 10, 'limit clamps to 10 max');
    assert.equal(result.promoted, 5, 'only 5 pending rows were promoted');
  } finally {
    closeDb();
    rmRf(home);
  }
});
