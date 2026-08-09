// Tests for v10 visibility / ACL + memory_share + _shared DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  shareMemory,
  openSharedDb,
  sharedDbPath,
  searchMemories,
  listMemories,
  getMemory,
} from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/visibility');
  return { home, key, dbPath: projectDbPath(home, key) };
}

test('default visibility is "private"', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, { type: 'semantic', title: 'A', content: 'a' });
    assert.equal(m.visibility, 'private');
    assert.deepEqual(m.shared_with, []);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('saveMemory accepts visibility and shared_with', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'Restricted',
      content: 'secret',
      visibility: 'restricted',
      shared_with: ['user:alice', 'role:editor'],
    });
    assert.equal(m.visibility, 'restricted');
    assert.deepEqual(m.shared_with, ['user:alice', 'role:editor']);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('searchMemories visibility filter narrows results', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'semantic',
      title: 'private row',
      content: 'secret',
      visibility: 'private',
    });
    saveMemory(db, key, {
      type: 'semantic',
      title: 'team row',
      content: 'team',
      visibility: 'team',
    });
    saveMemory(db, key, {
      type: 'semantic',
      title: 'restricted row',
      content: 'restricted',
      visibility: 'restricted',
    });
    const all = await searchMemories(db, key, 'row');
    assert.equal(all.length, 3, 'default scope sees every visibility');
    const onlyPrivate = await searchMemories(db, key, 'row', { visibility: 'private' });
    assert.equal(onlyPrivate.length, 1);
    assert.equal(onlyPrivate[0].title, 'private row');
    const pubAndTeam = await searchMemories(db, key, 'row', { visibility: ['private', 'team'] });
    assert.equal(pubAndTeam.length, 2);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('memory_share promotes visibility in place (no move)', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, { type: 'semantic', title: 'A', content: 'a' });
    const result = shareMemory(db, key, [m.id], {
      visibility: 'team',
      sharedWith: ['role:dev'],
      toSharedPool: false,
      kimiHomeDir: home,
    });
    assert.equal(result.moved, 0, 'in-place promotion does not move');
    assert.equal(result.updated, 1);
    const updated = getMemory(db, key, m.id);
    assert.equal(updated.visibility, 'team');
    assert.deepEqual(updated.shared_with, ['role:dev']);
    // Still in the project DB.
    const projHits = listMemories(db, key);
    assert.equal(projHits.length, 1);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('memory_share with toSharedPool=true moves row into _shared DB', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const projectDb = openDb(dbPath);
    const m = saveMemory(projectDb, key, {
      type: 'semantic',
      title: 'Shared row',
      content: 'shared',
    });
    const result = shareMemory(projectDb, key, [m.id], {
      visibility: 'team',
      toSharedPool: true,
      kimiHomeDir: home,
    });
    assert.equal(result.moved, 1, 'row was moved into _shared');
    assert.equal(result.updated, 0);
    // Source DB no longer has the row.
    const stillThere = getMemory(projectDb, key, m.id);
    assert.equal(stillThere, null, 'row removed from project DB after move');
    // Target _shared DB has it under project_key='_shared'.
    const sharedDb = openSharedDb(home);
    const moved = getMemory(sharedDb, '_shared', m.id);
    assert.ok(moved, 'row present in _shared DB');
    assert.equal(moved.visibility, 'team');
    assert.equal(moved.title, 'Shared row');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('openSharedDb + sharedDbPath point at _shared/memory.sqlite', () => {
  const { home } = freshProject();
  try {
    const expected = sharedDbPath(home).replace(/\\/g, '/');
    assert.match(expected, /_shared[\\\/]memory\.sqlite$/);
    // openSharedDb is idempotent — second call returns the same cached handle.
    const a = openSharedDb(home);
    const b = openSharedDb(home);
    assert.equal(a, b);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('CLI: invalid visibility is rejected by shareMemory', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, { type: 'semantic', title: 'A', content: 'a' });
    assert.throws(() => {
      shareMemory(db, key, [m.id], {
        visibility: 'bogus',
        kimiHomeDir: home,
      });
    }, /invalid visibility/);
  } finally {
    closeDb();
    rmRf(home);
  }
});
