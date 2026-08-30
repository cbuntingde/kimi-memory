// Tests for the deterministic work-log auto-writer. The git call is
// mocked at the `runGit` injection seam so the suite is offline and
// reproducible across machines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as _realExecFile } from 'node:child_process';
import { mkTempHome, rmRf, writeRaw } from './_helpers.js';
import { openDb, closeDb, saveMemory, listMemories } from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';
import {
  deriveProjectDisplayName,
  workLogTitle,
  gatherCommits,
  gatherTodaysActivity,
  gatherTodaysMemoryTitles,
  maybeWriteWorkLog,
  _resetWorkLogRegistryForTests,
} from '../src/work-log.js';

function fakeRunGitWith(lines) {
  return (_args, cb) => {
    cb(null, Array.isArray(lines) ? lines.join('\n') + '\n' : String(lines));
  };
}

function fakeRunGitError() {
  return (_args, cb) => cb(new Error('no git'));
}

test('deriveProjectDisplayName: pulls the trailing path segment', () => {
  assert.equal(deriveProjectDisplayName('C:/Chris-Dev/axiom-cache'), 'axiom-cache');
  assert.equal(deriveProjectDisplayName('/srv/repos/foo'), 'foo');
  assert.equal(deriveProjectDisplayName('C:/work/something/'), 'something');
  // Falls through to the full canonical root on weird / generic segments.
  const generic = deriveProjectDisplayName('C:/some/path/src');
  assert.notEqual(generic, 'src');
  assert.notEqual(generic, 'project');
  assert.equal(deriveProjectDisplayName(''), 'project');
  assert.equal(deriveProjectDisplayName(null), 'project');
});

test('workLogTitle: stable format with ISO date + project name', () => {
  assert.equal(workLogTitle('axiom-cache', '2026-08-02'), '2026-08-02 · axiom-cache work log');
});

test('gatherCommits: parses `git log --pretty=format:%h %s` output', async () => {
  const r = await gatherCommits('C:/anywhere', '2026-08-02', {
    runGit: fakeRunGitWith(['618dc8a hardening', '8a69ca1 readme sync', 'extra noise']),
  });
  assert.equal(r.error, null);
  assert.deepEqual(r.commits, ['618dc8a hardening', '8a69ca1 readme sync', 'extra noise']);
});

test('gatherCommits: returns error shape on git failure (no throw)', async () => {
  const r = await gatherCommits('C:/anywhere', '2026-08-02', { runGit: fakeRunGitError() });
  assert.deepEqual(r.commits, []);
  assert.equal(r.error, 'git_failed');
});

test('maybeWriteWorkLog: env opt-out short-circuits before any DB or git call', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/work-log-off');
  const db = openDb(projectDbPath(home, key));
  const prev = process.env.KIMI_MEMORY_DISABLE_WORK_LOG;
  process.env.KIMI_MEMORY_DISABLE_WORK_LOG = '1';
  let gitCalled = false;
  const runGit = (_a, cb) => {
    gitCalled = true;
    cb(null, '');
  };
  try {
    const r = await maybeWriteWorkLog({
      db,
      projectKey: key,
      cwd: 'C:/test/work-log-off',
      saveMemory,
      runGit,
    });
    assert.equal(r.skipped, 'env_opt_out');
    assert.equal(r.written, 0);
    assert.equal(gitCalled, false, 'runGit must not run when opt-out is set');
  } finally {
    if (prev == null) delete process.env.KIMI_MEMORY_DISABLE_WORK_LOG;
    else process.env.KIMI_MEMORY_DISABLE_WORK_LOG = prev;
    closeDb();
    rmRf(home);
  }
});

test('maybeWriteWorkLog: below threshold → skipped, no memory written', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/work-log-quiet');
  const db = openDb(projectDbPath(home, key));
  try {
    // No events, no commits: threshold not met.
    const r = await maybeWriteWorkLog({
      db,
      projectKey: key,
      cwd: 'C:/test/work-log-quiet',
      saveMemory,
      runGit: fakeRunGitWith([]),
      minEvents: 8,
    });
    assert.equal(r.skipped, 'below_threshold');
    assert.equal(r.written, 0);
    assert.equal(listMemories(db, key, {}).length, 0);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('maybeWriteWorkLog: with a commit, writes the work-log memory', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/Chris-Dev/some-repo');
  const db = openDb(projectDbPath(home, key));
  try {
    const r = await maybeWriteWorkLog({
      db,
      projectKey: key,
      cwd: 'C:/Chris-Dev/some-repo',
      saveMemory,
      runGit: fakeRunGitWith(['a1b2c3d initial scaffold', 'd4e5f6a add feature']),
    });
    assert.equal(r.skipped, null);
    assert.equal(r.written, 1);
    assert.equal(r.updated, 0);
    const all = listMemories(db, key, {});
    assert.equal(all.length, 1);
    const m = all[0];
    assert.equal(m.type, 'episodic');
    assert.match(m.title, /^\d{4}-\d{2}-\d{2} · some-repo work log$/);
    assert.match(m.content, /Commits today \(2\)/);
    assert.match(m.content, /a1b2c3d initial scaffold/);
    assert.match(m.content, /d4e5f6a add feature/);
    assert.equal(m.tags.length, 4);
    assert.equal(m.tags[0], 'work-log');
    assert.match(m.tags[1], /^\d{4}-\d{2}$/);
    assert.equal(m.tags[2], 'some-repo');
    assert.equal(m.tags[3], 'auto');
    assert.equal(m.provenance && m.provenance.source, 'work_log_auto');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('maybeWriteWorkLog: idempotent within a day — second call updates, not duplicates', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/Chris-Dev/some-repo');
  const db = openDb(projectDbPath(home, key));
  try {
    const first = await maybeWriteWorkLog({
      db,
      projectKey: key,
      cwd: 'C:/Chris-Dev/some-repo',
      saveMemory,
      runGit: fakeRunGitWith(['a1 initial']),
    });
    assert.equal(first.written, 1);
    assert.equal(first.updated, 0);
    const id1 = first.id;

    const second = await maybeWriteWorkLog({
      db,
      projectKey: key,
      cwd: 'C:/Chris-Dev/some-repo',
      saveMemory,
      // New commit since the first call — content updates, but the
      // title is identical, so supersede=true should mark the prior
      // row superseded and insert a fresh active row.
      runGit: fakeRunGitWith(['a1 initial', 'b2 second']),
    });
    assert.equal(second.written, 1);
    assert.equal(second.updated, 1, 'prior row was replaced');
    assert.notEqual(second.id, id1);
    const active = listMemories(db, key, {});
    assert.equal(active.length, 1, 'exactly one active work-log per day per project');
    assert.equal(active[0].id, second.id);
    assert.match(active[0].content, /b2 second/);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('maybeWriteWorkLog: different UTC days → different titles, both stay active', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/Chris-Dev/some-repo');
  const db = openDb(projectDbPath(home, key));
  // Pin `now` to two distinct UTC days so the writer picks distinct titles.
  const day1 = new Date('2026-08-02T10:00:00Z');
  const day2 = new Date('2026-08-03T10:00:00Z');
  try {
    const r1 = await maybeWriteWorkLog({
      db,
      projectKey: key,
      cwd: 'C:/Chris-Dev/some-repo',
      saveMemory,
      runGit: fakeRunGitWith(['a1 day-1']),
      now: () => day1,
    });
    const r2 = await maybeWriteWorkLog({
      db,
      projectKey: key,
      cwd: 'C:/Chris-Dev/some-repo',
      saveMemory,
      runGit: fakeRunGitWith(['b2 day-2']),
      now: () => day2,
    });
    assert.equal(r1.written, 1);
    assert.equal(r1.updated, 0);
    assert.equal(r2.written, 1);
    assert.equal(r2.updated, 0, 'day-2 does not supersede day-1');
    const active = listMemories(db, key, {});
    assert.equal(active.length, 2);
    const titles = active.map((m) => m.title).sort();
    assert.deepEqual(titles, [
      '2026-08-02 · some-repo work log',
      '2026-08-03 · some-repo work log',
    ]);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('maybeWriteWorkLog: events-only path triggers without any commits', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/work-log-events');
  const db = openDb(projectDbPath(home, key));
  try {
    // Seed ≥ minEvents conversation_events for today across two sessions.
    const dayIso = new Date().toISOString().slice(0, 10);
    const insert = db.prepare(
      'INSERT INTO conversation_events (project_key, session_id, line_no, byte_offset, role, kind, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    db.exec('BEGIN');
    let lineNo = 1;
    for (const sessionId of ['sA', 'sB']) {
      for (let i = 0; i < 5; i++) {
        insert.run(
          key,
          sessionId,
          lineNo++,
          lineNo * 100,
          'user',
          'message',
          `prompt-${i}`,
          '{}',
          `${dayIso}T12:00:0${i}Z`,
        );
      }
    }
    db.exec('COMMIT');

    const r = await maybeWriteWorkLog({
      db,
      projectKey: key,
      cwd: 'C:/test/work-log-events',
      saveMemory,
      runGit: fakeRunGitWith([]),
      minEvents: 8,
    });
    assert.equal(r.skipped, null);
    assert.equal(r.written, 1);
    const all = listMemories(db, key, {});
    assert.equal(all.length, 1);
    assert.match(all[0].content, /Sessions today: 2/);
    assert.match(all[0].content, /conversation_events today: 10/);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('maybeWriteWorkLog: cross-references today\u2019s memory titles in the content', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/work-log-cross-ref');
  const db = openDb(projectDbPath(home, key));
  try {
    // Seed two memories updated today on this project.
    const dayIso = new Date().toISOString().slice(0, 10);
    saveMemory(db, key, {
      type: 'semantic',
      title: 'release flow',
      content: 'tag + push',
      tags: ['ci'],
    });
    saveMemory(db, key, {
      type: 'procedural',
      title: 'db backup',
      content: 'nightly at 02:00 UTC',
      tags: ['ops'],
    });
    // Backdate updated_at to today so the cross-ref query picks them up.
    db.prepare(`UPDATE memories SET updated_at = ? WHERE project_key = ?`).run(
      `${dayIso}T01:00:00Z`,
      key,
    );

    const r = await maybeWriteWorkLog({
      db,
      projectKey: key,
      cwd: 'C:/test/work-log-cross-ref',
      saveMemory,
      runGit: fakeRunGitWith(['a1 first']),
    });
    assert.equal(r.written, 1);
    // The work-log row is the only one with the expected title; find it
    // explicitly rather than relying on listMemories' insertion order
    // (which has no documented guarantee and has historically picked
    // a different row first when the seed used a shared updated_at).
    const all = listMemories(db, key, {});
    const workLog = all.find((m) => /work log$/.test(m.title || ''));
    assert.ok(workLog, 'work-log row must exist after a successful write');
    const content = workLog.content;
    assert.match(content, /Memories saved\/updated today on this project \(2\)/);
    assert.match(content, /- release flow/);
    assert.match(content, /- db backup/);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('gatherTodaysActivity: returns zeros on a fresh DB without erroring', () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/work-log-empty');
  const db = openDb(projectDbPath(home, key));
  try {
    const a = gatherTodaysActivity(db, key, '2026-08-02');
    assert.equal(a.events, 0);
    assert.equal(a.sessions, 0);
    assert.equal(a.error, null);
    const t = gatherTodaysMemoryTitles(db, key, '2026-08-02');
    assert.deepEqual(t, []);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('gatherCommits: against a missing git repo, does not throw (fail-open)', async () => {
  const r = await gatherCommits('C:/definitely/not/a/repo/anywhere', '2026-08-02');
  assert.ok(Array.isArray(r.commits));
  // No assertion on r.error -- git exit codes vary across platforms.
});

// Touch the test-only re-export so the linter doesn't complain about
// unused-import on the registry reset hook (kept for future callers).
void _resetWorkLogRegistryForTests;
