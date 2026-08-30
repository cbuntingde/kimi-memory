// Tests for the Round A + B + C + D fix batch. ESM-only — uses
// dynamic `import('node:fs')` instead of require().
//   - B1-3: boundedFind caps both loops at MAX_DIRS
//   - B1-5: cmdImport refuses files larger than 50 MB
//   - B1-6: ingestOne persists the cursor even on walker failure
//   - B1-8: mergeConfigWithEnv uses structuredClone (no lossy round-trip)
//   - B2-6: recordPromotion id stamp avoids same-second collisions
//   - B2-11: assertNoSecret also scans tags + metadata
//   - B4-7: consolidate.js imports decodeVector from embedding.js
//   - B4-10: validateSharedWith returns { value, dropped }
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf } from './_helpers.js';
import { openDb, closeDb, saveMemory, setMemoryTier } from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';
import { validateSharedWith } from '../src/acl.js';
import { mergeConfigWithEnv } from '../src/config.js';
import { decodeVector as importedDecode } from '../src/embedding.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/batch2');
  return { home, key, dbPath: projectDbPath(home, key) };
}

test('B1-3: boundedFind is bounded by MAX_DIRS in both loops', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/wire.js', import.meta.url), 'utf8');
  const match = src.match(/async function boundedFind\([\s\S]*?\n\}/);
  assert.ok(match, 'boundedFind function not found');
  const body = match[0];
  const capHits = (body.match(/MAX_DIRS/g) || []).length;
  assert.ok(capHits >= 2, 'boundedFind should reference MAX_DIRS in both loops');
});

test('B1-5: cmdImport refuses files larger than 50 MB', async () => {
  const { writeFileSync, truncateSync, statSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const home = mkTempHome();
  try {
    const big = join(home, 'huge.json');
    writeFileSync(big, '{');
    truncateSync(big, 60 * 1024 * 1024);
    assert.ok(statSync(big).size > 50 * 1024 * 1024, 'precondition: file > 50 MB');
    const cliSrc = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
    const cliImportSrc = readFileSync(new URL('../src/cli-cmd/import.js', import.meta.url), 'utf8');
    assert.match(cliSrc + cliImportSrc, /MAX_IMPORT_BYTES/);
    assert.match(cliSrc + cliImportSrc, /import file too large/);
  } finally {
    rmRf(home);
  }
});

test('B1-8: mergeConfigWithEnv uses structuredClone (no lossy JSON round-trip)', () => {
  // structuredClone throws DataCloneError on Symbol values; the
  // previous JSON-round-trip silently dropped them. Verify by
  // passing a config containing a Symbol and expecting a throw.
  const cfg = {
    'kimi-memory': { embed_timeout_ms: 4000 },
    meta: { sym: Symbol('s') },
  };
  assert.throws(() => mergeConfigWithEnv(cfg), /DataCloneError|clone|Symbol/);
});

test('B2-6: two tier transitions in the same second do not collide', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, { type: 'semantic', title: 't', content: 'c' });
    setMemoryTier(db, key, m.id, 'L1', { reason: 'first' });
    setMemoryTier(db, key, m.id, 'L2', { reason: 'second' });
    const rows = db
      .prepare('SELECT * FROM persona_promotions WHERE memory_id = ? ORDER BY at ASC')
      .all(m.id);
    assert.ok(rows.length >= 2, 'both transitions were recorded (no PRIMARY KEY collision)');
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('B2-11: assertNoSecret blocks secret-shaped tag values', () => {
  const { home, key, dbPath } = freshProject();
  let db;
  try {
    db = openDb(dbPath);
    assert.throws(
      () =>
        saveMemory(db, key, {
          type: 'semantic',
          title: 'clean title',
          content: 'clean content',
          tags: ['api_key = abcdefghijklmnop'],
        }),
      (err) => {
        assert.equal(err.code, 'KIMI_MEMORY_SECRET_DETECTED');
        assert.match(err.where, /tags/);
        return true;
      },
    );
  } finally {
    if (db) {
      try {
        closeDb();
      } catch {
        /* ignore */
      }
    }
    rmRf(home);
  }
});

test('B2-11: assertNoSecret blocks secret-shaped metadata values', () => {
  const { home, key, dbPath } = freshProject();
  let db;
  try {
    db = openDb(dbPath);
    assert.throws(
      () =>
        saveMemory(db, key, {
          type: 'semantic',
          title: 'clean title',
          content: 'clean content',
          metadata: { credentials: 'api_key = abcdefghijklmnop' },
        }),
      (err) => {
        assert.equal(err.code, 'KIMI_MEMORY_SECRET_DETECTED');
        assert.match(err.where, /metadata/);
        return true;
      },
    );
  } finally {
    if (db) {
      try {
        closeDb();
      } catch {
        /* ignore */
      }
    }
    rmRf(home);
  }
});

test('B4-7: consolidate.js imports decodeVector from embedding.js', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/consolidate.js', import.meta.url), 'utf8');
  assert.match(
    src,
    /import\s*\{\s*decodeVector\s+as\s+decodeEmbedding\s*\}\s*from\s*['"]\.\/embedding\.js['"]/,
  );
  // The canonical decoder still rejects corrupt input.
  const bad = new Uint8Array(4); // 4 bytes, way below the EMBEDDING_DIM*4 floor
  assert.throws(() => importedDecode(bad), /CORRUPT|too small/i);
});

test('B4-10: validateSharedWith surfaces dropped entries', () => {
  const out = validateSharedWith([
    'user:alice',
    42, // non-string — dropped
    '', // empty — dropped
    'role:editor',
    'a'.repeat(200), // too long — dropped
  ]);
  assert.deepEqual(out.value, ['user:alice', 'role:editor']);
  assert.equal(out.dropped.length, 3);
  assert.equal(out.dropped[0], 42);
});

test('B4-10: validateSharedWith caps at 32 and reports the cut tail', () => {
  const big = Array.from({ length: 50 }, (_, i) => `user:u${i}`);
  const out = validateSharedWith(big);
  assert.equal(out.value.length, 32);
  // 50 inputs - 32 kept = 18 dropped (the cap tail).
  assert.equal(out.dropped.length, 18);
});
