// Tests for project-key canonicalization, isolation, and DB path layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkTempHome, rmRf, pluginRoot } from './_helpers.js';
import {
  canonicalizeRoot,
  deriveProjectKey,
  projectDbPath,
  globalDbPath,
  globalDataDir,
  ensureProjectDir,
  ensureGlobalDir,
  ingestStatePath,
  GLOBAL_PROJECT_KEY,
  GLOBAL_DIR_NAME,
} from '../src/project-key.js';

test('canonicalizeRoot accepts absolute paths and rejects the rest', () => {
  const winFoo = 'C:\\foo\\bar';
  const posixLocal = path.resolve('/usr/local');
  assert.equal(canonicalizeRoot('C:/foo/bar'), winFoo);
  assert.equal(canonicalizeRoot('/usr/local'), posixLocal);
  assert.equal(canonicalizeRoot(''), null);
  assert.equal(canonicalizeRoot('relative/path'), null);
  assert.equal(canonicalizeRoot(null), null);
  assert.equal(canonicalizeRoot(undefined), null);
  assert.equal(canonicalizeRoot(42), null);
  // Drive-letter case insensitivity.
  assert.equal(canonicalizeRoot('c:/foo/bar'), winFoo);
});

test('deriveProjectKey is deterministic and isolating', () => {
  const a = deriveProjectKey(canonicalizeRoot('C:/projects/alpha'));
  const b = deriveProjectKey(canonicalizeRoot('C:/projects/alpha'));
  const c = deriveProjectKey(canonicalizeRoot('C:/projects/beta'));
  assert.equal(a, b, 'same root produces same key');
  assert.notEqual(a, c, 'different roots produce different keys');
  assert.equal(a.length, 16);
});

test('per-project data layout uses the project key under kimi home', () => {
  const home = mkTempHome();
  try {
    const root = canonicalizeRoot('C:/projects/gamma');
    const key = deriveProjectKey(root);
    const expected = path.join(home, 'kimi-memory', key, 'memory.sqlite');
    assert.equal(projectDbPath(home, key), expected);
    assert.equal(
      ingestStatePath(home, key),
      path.join(home, 'kimi-memory', key, 'ingest-state.json'),
    );
  } finally {
    rmRf(home);
  }
});

test('ensureProjectDir creates a real directory', async () => {
  const home = mkTempHome();
  try {
    const key = deriveProjectKey(canonicalizeRoot('C:/x'));
    const dir = await ensureProjectDir(home, key);
    assert.ok(dir.endsWith(key));
  } finally {
    rmRf(home);
  }
});

test('global path layout is stable under kimi home and never conflicts with hashed project keys', () => {
  const home = mkTempHome();
  try {
    const expected = path.join(home, 'kimi-memory', GLOBAL_DIR_NAME, 'memory.sqlite');
    assert.equal(globalDbPath(home), expected);
    assert.equal(globalDataDir(home), path.join(home, 'kimi-memory', GLOBAL_DIR_NAME));
    // The literal "_global" project_key never collides with a 16-char hex key.
    assert.equal(GLOBAL_PROJECT_KEY, '_global');
    const projectKey = deriveProjectKey(canonicalizeRoot('C:/projects/gamma'));
    assert.notEqual(projectKey, GLOBAL_PROJECT_KEY);
    assert.equal(projectKey.length, 16);
    assert.equal(/^[0-9a-f]+$/.test(projectKey), true);
  } finally {
    rmRf(home);
  }
});

test('ensureGlobalDir creates a real directory', async () => {
  const home = mkTempHome();
  try {
    const dir = await ensureGlobalDir(home);
    assert.ok(dir.endsWith(GLOBAL_DIR_NAME));
  } finally {
    rmRf(home);
  }
});
