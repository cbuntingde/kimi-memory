// Defect 1: schema-version gating in src/persist/connection.js. Before
// the fix `schema_version` was write-only — MIGRATIONS ran on every
// open, `PRAGMA user_version` was never read or written, and an older
// build happily mutated a newer DB. This pins the CONSERVATIVE variant:
// `PRAGMA user_version` is stamped and read, a newer file is refused
// before any write, and the idempotent migration loop still runs at the
// current version (v12's is_session_focus pass is a deliberate per-open
// reconcile). Also covers the new KIMI_MEMORY_BUSY_TIMEOUT_MS override.
//
// Defect 2: src/project-key.js canonicalization gaps — Windows '.'/'..'
// segments, silently-hashed relative inputs, symlink/junction targets,
// and case folding on Darwin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from '../src/persist.js';
import { deriveProjectKey, projectDbPath } from '../src/project-key.js';
import { mkTempHome, rmRf } from './_helpers.js';

function freshProject(label) {
  const home = mkTempHome();
  const dbPath = projectDbPath(home, deriveProjectKey(`C:/test/${label}`));
  // openDb creates the parent directory itself, but the tests that open
  // the file on a raw connection need it to exist first.
  mkdirSync(path.dirname(dbPath), { recursive: true });
  return { home, dbPath };
}

// Open the file on a separate connection so the assertions do not
// depend on whatever openDb has cached.
function rawPragma(dbPath, pragma) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(pragma).get();
  } finally {
    db.close();
  }
}

function readUserVersion(dbPath) {
  return Number(rawPragma(dbPath, 'PRAGMA user_version').user_version);
}

function writeUserVersion(dbPath, value) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA user_version = ${value}`);
  } finally {
    db.close();
  }
}

function tableExists(db, name) {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name),
  );
}

test('openDb stamps PRAGMA user_version and keeps schema_meta in sync', () => {
  const { home, dbPath } = freshProject('version-stamp');
  try {
    const db = openDb(dbPath);
    const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
    const meta = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get();
    assert.ok(userVersion > 0, `user_version must be stamped, got ${userVersion}`);
    assert.ok(meta, 'schema_meta row is kept for continuity');
    assert.equal(String(userVersion), meta.value, 'user_version and schema_meta agree');
    assert.equal(readUserVersion(dbPath), userVersion, 'the on-disk marker matches');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('openDb refuses a DB written by a newer build, without mutating it', () => {
  const { home, dbPath } = freshProject('future-schema');
  try {
    // A bare DB with a future marker and the default rollback journal.
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA user_version = 999');
    raw.close();
    assert.equal(rawPragma(dbPath, 'PRAGMA journal_mode').journal_mode, 'delete');

    assert.throws(
      () => openDb(dbPath),
      /newer build[\s\S]*999[\s\S]*Update the kimi-memory plugin/i,
      'a newer schema must be refused with an actionable message',
    );
    // The refusal happens before any PRAGMA that writes: the marker is
    // untouched and the file is still not in WAL mode.
    assert.equal(readUserVersion(dbPath), 999, 'future marker untouched');
    assert.equal(
      rawPragma(dbPath, 'PRAGMA journal_mode').journal_mode,
      'delete',
      'refused before switching the file to WAL',
    );
    // A second attempt keeps refusing (the refusal is not cached as a handle).
    assert.throws(() => openDb(dbPath), /newer build/i);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('openDb re-runs the idempotent migration loop at or behind the current version', () => {
  const { home, dbPath } = freshProject('gating');
  try {
    const db = openDb(dbPath);
    const current = Number(db.prepare('PRAGMA user_version').get().user_version);
    // skill_invocations is created by a migration and is NOT part of
    // SCHEMA_SQL, so its presence is a clean witness of whether the loop
    // ran.
    db.exec('DROP TABLE skill_invocations');
    closeDb();

    // Equal marker => the conservative gate still runs the loop, so the
    // migration-created table is reconciled. (Skipping here would break
    // the v12 is_session_focus reconcile, which is a deliberate per-open
    // pass; tests/35-session-focus-column.test.js pins that.)
    const equal = openDb(dbPath);
    assert.equal(
      tableExists(equal, 'skill_invocations'),
      true,
      'a current marker still reconciles through the idempotent loop',
    );
    closeDb();

    // Behind marker => the loop runs and the marker is restamped.
    writeUserVersion(dbPath, 0);
    const behind = openDb(dbPath);
    assert.equal(
      tableExists(behind, 'skill_invocations'),
      true,
      'a behind marker re-runs the migrations',
    );
    assert.equal(
      Number(behind.prepare('PRAGMA user_version').get().user_version),
      current,
      're-running migrations restamps the marker',
    );
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('KIMI_MEMORY_BUSY_TIMEOUT_MS overrides the busy timeout; junk falls back to 30000', () => {
  const previous = process.env.KIMI_MEMORY_BUSY_TIMEOUT_MS;
  const cases = [
    { value: undefined, expected: 30000, label: 'unset' },
    { value: '2500', expected: 2500, label: 'short hook budget' },
    { value: ' 4000 ', expected: 4000, label: 'surrounding whitespace' },
    { value: 'not-a-number', expected: 30000, label: 'non-numeric' },
    { value: '12abc', expected: 30000, label: 'trailing junk' },
    { value: '0', expected: 30000, label: 'zero' },
    { value: '-5', expected: 30000, label: 'negative' },
  ];
  try {
    for (const [i, entry] of cases.entries()) {
      if (entry.value === undefined) delete process.env.KIMI_MEMORY_BUSY_TIMEOUT_MS;
      else process.env.KIMI_MEMORY_BUSY_TIMEOUT_MS = entry.value;
      const home = mkTempHome();
      const dbPath = projectDbPath(home, deriveProjectKey(`C:/test/busy-${i}`));
      try {
        const db = openDb(dbPath);
        const timeout = Number(db.prepare('PRAGMA busy_timeout').get().timeout);
        assert.equal(timeout, entry.expected, `busy timeout for ${entry.label}`);
      } finally {
        closeDb();
        rmRf(home);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.KIMI_MEMORY_BUSY_TIMEOUT_MS;
    else process.env.KIMI_MEMORY_BUSY_TIMEOUT_MS = previous;
  }
});

test('deriveProjectKey collapses Windows "." and ".." segments and trailing separators', () => {
  assert.equal(
    deriveProjectKey('C:\\a\\..\\b'),
    deriveProjectKey('C:\\b'),
    'a ".." segment must not split the project',
  );
  assert.equal(
    deriveProjectKey('C:\\a\\.\\b'),
    deriveProjectKey('C:\\a\\b'),
    'a "." segment must not split the project',
  );
  assert.equal(
    deriveProjectKey('C:\\a\\b\\'),
    deriveProjectKey('C:\\a\\b'),
    'a trailing separator must not split the project',
  );
  assert.equal(
    deriveProjectKey('C:/a/../b/c'),
    deriveProjectKey('C:\\b\\c'),
    'mixed separators normalise the same way',
  );
});

test('deriveProjectKey anchors a relative input instead of hashing it verbatim', () => {
  const rawHash = createHash('sha256').update('src').digest('hex').slice(0, 16);
  const resolved = deriveProjectKey(path.resolve('src'));
  assert.equal(deriveProjectKey('src'), resolved, 'a relative input resolves against the cwd');
  assert.equal(deriveProjectKey('./src'), resolved, "'./src' resolves the same way");
  assert.notEqual(
    deriveProjectKey('src'),
    rawHash,
    'a relative input must not be hashed as a bare string',
  );
  assert.notEqual(
    deriveProjectKey('src'),
    deriveProjectKey('tests'),
    'distinct relative inputs stay distinct',
  );
  assert.equal(deriveProjectKey(''), null, 'empty input is still rejected');
  assert.equal(deriveProjectKey(42), null, 'non-string input is still rejected');
});

test('deriveProjectKey folds case on Win32 and Darwin', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/project-key.js', import.meta.url)),
    'utf8',
  );
  assert.match(
    source,
    /process\.platform\s*===\s*'win32'[\s\S]{0,120}?process\.platform\s*===\s*'darwin'/,
    'case folding must cover Darwin as well as Win32',
  );
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  assert.equal(
    deriveProjectKey('C:\\Foo\\Case-Insensitive'),
    deriveProjectKey('c:\\foo\\case-insensitive'),
    'mixed-case spellings of one directory share a key',
  );
});

test('a symlinked project root and its target share one key', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'km-project-key-'));
  const target = path.join(base, 'target');
  const link = path.join(base, 'link');
  mkdirSync(target);
  try {
    try {
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Creating a link can be refused (EPERM on locked-down Windows);
      // nothing to assert in that case.
      return;
    }
    assert.equal(
      deriveProjectKey(link),
      deriveProjectKey(target),
      'a link and its target must not split into two DBs',
    );
    assert.equal(deriveProjectKey(link), deriveProjectKey(link), 'the key is stable across calls');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
