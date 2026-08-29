// Auto-reset on re-clone tests. Covers:
//   - wipeProjectLifecycleLogs deletes only the project's own rows
//   - buildStaleMemoryLine with KIMI_MEMORY_AUTO_RESET_ON_RECLONE unset
//     triggers the auto-reset path (default on)
//   - buildStaleMemoryLine with KIMI_MEMORY_AUTO_RESET_ON_RECLONE=off
//     returns the manual hint
//   - buildStaleMemoryLine with KIMI_MEMORY_AUTO_RESET_ON_RECLONE=on
//     triggers resetProject + wipeProjectLifecycleLogs and reports
//     the per-row counts in the success line
//   - auto-reset is one-shot per re-clone event (subsequent
//     SessionStart hooks see detectReclone === false)
//   - the manual resetProject MCP path is unchanged (does NOT touch
//     dream_jobs / dream_proposals / consolidation_runs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkTempHome, rmRf } from './_helpers.js';
import { openDb, closeDb, saveMemory } from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';
import { wipeProjectLifecycleLogs } from '../src/persist/project.js';
import { buildStaleMemoryLine } from '../src/hooks/handlers/_helpers.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/auto-reset');
  return { home, key, dbPath: projectDbPath(home, key) };
}

// Stamp a fresh project_paths row with first_seen_at far in the past
// so a real freshly-created directory's birthtime lands well ahead,
// triggering detectReclone. Does NOT call recordProjectPath first —
// callers should call exactly one of the two stampers.
function seedReclonableProjectPaths(db, key, cwd) {
  const past = new Date(Date.now() - 120_000).toISOString();
  db.prepare(
    `INSERT INTO project_paths (project_key, canonical_root, first_seen_at, last_seen_at, last_canonical_root, record_count)
     VALUES (?, ?, ?, ?, NULL, 1)`,
  ).run(key, cwd, past, past);
  return past;
}

function makeRecloneFixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'pm-autoreset-'));
  const cwd = path.join(home, 'project');
  mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

test('auto-reset: wipeProjectLifecycleLogs deletes only the project rows', () => {
  const home = mkTempHome();
  const keyA = deriveProjectKey('C:/test/wipe-A');
  const keyB = deriveProjectKey('C:/test/wipe-B');
  const dbPathA = projectDbPath(home, keyA);
  const dbPathB = projectDbPath(home, keyB);
  try {
    // Seed lifecycle rows for project A and project B in A's DB (the
    // tables are per-DB but tests share $KIMI_CODE_HOME; use two
    // separate DBs to keep projects isolated).
    const dbA = openDb(dbPathA);
    dbA
      .prepare(
        'INSERT INTO dream_jobs (id, project_key, status, triggered_by, input_snapshot, result_counts, enqueued_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('job-a1', keyA, 'applied', 'test', '{}', '{}', 'now', 'now');
    dbA
      .prepare(
        'INSERT INTO dream_jobs (id, project_key, status, triggered_by, input_snapshot, result_counts, enqueued_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('job-b1', keyB, 'applied', 'test', '{}', '{}', 'now', 'now');
    dbA
      .prepare(`INSERT INTO consolidation_runs (id, project_key, summary, at) VALUES (?, ?, ?, ?)`)
      .run('crun-a1', keyA, '{}', 'now');
    dbA
      .prepare(`INSERT INTO consolidation_runs (id, project_key, summary, at) VALUES (?, ?, ?, ?)`)
      .run('crun-b1', keyB, '{}', 'now');
    closeDb();

    // Open the DB again (the helper expects the cached handle to be
    // fresh after our seed-then-close).
    const db = openDb(dbPathA);
    const summary = wipeProjectLifecycleLogs(db, keyA);
    assert.equal(summary.dream_jobs_deleted, 1, 'only project A dream_jobs row');
    assert.equal(summary.dream_proposals_deleted, 0);
    assert.equal(summary.consolidation_runs_deleted, 1, 'only project A consolidation row');
    // Project B rows untouched.
    const stillB = db
      .prepare('SELECT COUNT(*) AS n FROM dream_jobs WHERE project_key=?')
      .get(keyB).n;
    assert.equal(stillB, 1, 'project B dream_jobs untouched');
    const crunB = db
      .prepare('SELECT COUNT(*) AS n FROM consolidation_runs WHERE project_key=?')
      .get(keyB).n;
    assert.equal(crunB, 1, 'project B consolidation_runs untouched');
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('auto-reset: env unset (default) triggers the auto-reset path on a real re-clone', () => {
  const { home, cwd } = makeRecloneFixture();
  const key = deriveProjectKey(cwd);
  const dbPath = projectDbPath(home, key);
  try {
    const db = openDb(dbPath);
    seedReclonableProjectPaths(db, key, cwd);
    saveMemory(db, key, {
      type: 'semantic',
      title: 'default-on row',
      content: 'should be wiped because default is now on',
      tags: ['default-on'],
      _embed: false,
    });
    const prev = process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE;
    // Ensure the env is unset (other tests in this file may have set
    // it; the default-on behaviour is what we're pinning here).
    delete process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE;
    try {
      const line = buildStaleMemoryLine(db, key, cwd);
      assert.ok(line, 'default-on should produce a line on a real re-clone');
      assert.match(line, /\[stale-memory:auto-reset\]/);
      assert.match(line, /memories:1/);
      const memoriesAfter = db
        .prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key=?')
        .get(key).n;
      assert.equal(memoriesAfter, 0, 'memories wiped under default-on');
    } finally {
      if (prev === undefined) delete process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE;
      else process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE = prev;
    }
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('auto-reset: env off with a reclonable project_paths row returns the manual hint', () => {
  const { home, cwd } = makeRecloneFixture();
  const key = deriveProjectKey(cwd);
  const dbPath = projectDbPath(home, key);
  try {
    const db = openDb(dbPath);
    seedReclonableProjectPaths(db, key, cwd);
    const prev = process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE;
    process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE = 'off';
    try {
      const line = buildStaleMemoryLine(db, key, cwd);
      assert.ok(line, 'should return a manual-hint line under env=off');
      assert.match(line, /\[stale-memory\]/);
      assert.match(line, /memory_reset_project/);
      // No `[stale-memory:auto-reset]` because the env was off.
      assert.doesNotMatch(line, /\[stale-memory:auto-reset\]/);
      // Memories untouched under the manual-hint path.
      const memoriesBefore = db
        .prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key=?')
        .get(key).n;
      assert.equal(memoriesBefore, 0, 'no rows were seeded in this test');
    } finally {
      if (prev === undefined) delete process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE;
      else process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE = prev;
    }
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('auto-reset: env on with no reclone returns null (no false wipe)', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    // No project_paths row → detectReclone returns isReclone=false.
    const before = db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').all().length;
    const prev = process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE;
    process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE = 'on';
    try {
      const line = buildStaleMemoryLine(db, key, 'C:/does/not/matter');
      assert.equal(line, null, 'no reclone signal → no line, no wipe');
    } finally {
      if (prev === undefined) delete process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE;
      else process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE = prev;
    }
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('auto-reset: env on with a reclonable project_paths row + real dir wipes and reports counts', () => {
  const { home, cwd } = makeRecloneFixture();
  const key = deriveProjectKey(cwd);
  const dbPath = projectDbPath(home, key);
  try {
    const db = openDb(dbPath);
    seedReclonableProjectPaths(db, key, cwd);

    // Seed memories + a dream row so the wipe has something to wipe.
    saveMemory(db, key, {
      type: 'semantic',
      title: 'stale one',
      content: 'stale content',
      tags: ['stale'],
      _embed: false,
    });
    db.prepare(
      'INSERT INTO dream_jobs (id, project_key, status, triggered_by, input_snapshot, result_counts, enqueued_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('job-1', key, 'queued', 'test', '{}', '{}', 'now', 'now');

    const memoriesBefore = db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key=?')
      .get(key).n;
    assert.equal(memoriesBefore, 1, 'one memory before reset');
    const dreamsBefore = db
      .prepare('SELECT COUNT(*) AS n FROM dream_jobs WHERE project_key=?')
      .get(key).n;
    assert.equal(dreamsBefore, 1, 'one dream_jobs row before reset');

    const prev = process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE;
    process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE = 'on';
    try {
      const line = buildStaleMemoryLine(db, key, cwd);
      assert.ok(line, 'should return a line');
      assert.match(line, /\[stale-memory:auto-reset\]/);
      assert.match(line, /wiped \d+ per-project rows/);
      assert.match(line, /memories:1/);
      assert.match(line, /dreams:1\/0/);

      const memoriesAfter = db
        .prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key=?')
        .get(key).n;
      assert.equal(memoriesAfter, 0, 'memories wiped');
      const dreamsAfter = db
        .prepare('SELECT COUNT(*) AS n FROM dream_jobs WHERE project_key=?')
        .get(key).n;
      assert.equal(dreamsAfter, 0, 'dream_jobs wiped');

      // One-shot: buildStaleMemoryLine called again should return null
      // because resetProject updated first_seen_at to now, which makes
      // detectReclone return isReclone=false.
      const line2 = buildStaleMemoryLine(db, key, cwd);
      assert.equal(line2, null, 'second call: no longer a re-clone signal');
    } finally {
      if (prev === undefined) delete process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE;
      else process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE = prev;
    }
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('auto-reset: env on + resetProject throws returns the failure line, not the manual hint', () => {
  const { home, cwd } = makeRecloneFixture();
  const key = deriveProjectKey(cwd);
  const dbPath = projectDbPath(home, key);
  try {
    const db = openDb(dbPath);
    seedReclonableProjectPaths(db, key, cwd);

    const prev = process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE;
    process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE = 'on';
    try {
      // Drop the memories table so resetProject's BEGIN/DELETE throws.
      db.exec('DROP TABLE memories');
      const line = buildStaleMemoryLine(db, key, cwd);
      assert.ok(line, 'should return a line on failure too');
      assert.match(line, /\[stale-memory:auto-reset-failed\]/);
      assert.match(line, /reset failed/);
      assert.match(line, /memory_reset_project/);
    } finally {
      if (prev === undefined) delete process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE;
      else process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE = prev;
    }
    closeDb();
  } finally {
    rmRf(home);
  }
});
