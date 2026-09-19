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

test('searchMemories does not filter on processing_status', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', title: 'alpha ready', content: 'alpha body' });
    saveMemory(db, key, {
      type: 'semantic',
      title: 'alpha pending',
      content: 'alpha body',
      processing_status: 'pending',
    });
    saveMemory(db, key, {
      type: 'semantic',
      title: 'alpha distilling',
      content: 'alpha body',
      processing_status: 'distilling',
    });
    // All three rows match the query textually and share the same content,
    // so anything missing from the result would prove a filter on the
    // row's processing state. There is none: `searchMemories`
    // (src/persist/search.js) never reads `processing_status`, and no
    // option controls it — the `includeProcessing` flag an earlier
    // revision of this test passed does not exist in the function's
    // option surface.
    //
    // The two preceding names for this test ("excludes pending and
    // distilling rows by default" / "...includeProcessing=true surfaces
    // non-ready rows") both claimed a filter that was never implemented;
    // they passed only because the non-matching rows did not contain the
    // query token. This pins the real behaviour, so adding a filter has
    // to come with a deliberate change here.
    const hits = await searchMemories(db, key, 'alpha');
    assert.deepEqual(
      hits.map((h) => h.title).sort(),
      ['alpha distilling', 'alpha pending', 'alpha ready'],
      'no processing_status filter is applied',
    );
    const pending = hits.find((h) => h.title === 'alpha pending');
    assert.equal(
      pending.processing_status,
      'pending',
      'rowToMemory must still surface the non-ready state to the caller',
    );
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
