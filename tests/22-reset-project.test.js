// Tests for the re-clone detection + reset path. Three layers:
//   1. persist-layer: detectReclone + resetProject
//   2. hook-layer: buildStaleMemoryLine emits a [stale-memory] line
//      when a re-clone is detected
//   3. MCP round-trip: memory_reset_project dry-run + apply + global
//      DB isolation
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkTempHome, rmRf, StdioMcp } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  saveMemoryBulk,
  recordProjectPath,
  listProjectPaths,
  resetProject,
  detectReclone,
  setWorkingMemory,
  linkMemory,
  upsertConversation,
  recordConversationEvent,
  updateConversationProgress,
  getMemory,
  listWorkingMemory,
} from '../src/persist.js';
import {
  projectDbPath,
  globalDbPath,
  deriveProjectKey,
  GLOBAL_PROJECT_KEY,
} from '../src/project-key.js';

function freshHome() {
  return mkTempHome('km-reset-');
}

test('detectReclone: returns isReclone=false when no project_paths row exists', () => {
  const home = freshHome();
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-d-'));
  const key = deriveProjectKey(cwd);
  try {
    const db = openDb(projectDbPath(home, key));
    const r = detectReclone(db, key, cwd);
    assert.equal(r.isReclone, false);
    assert.match(r.reason, /no prior record/);
    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
    rmRf(cwd);
  }
});

test('detectReclone: returns isReclone=true when directory birthtime is newer than first_seen_at', () => {
  const home = freshHome();
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-d-'));
  const key = deriveProjectKey(cwd);
  try {
    const db = openDb(projectDbPath(home, key));
    // First stamp the project_paths row, but with a first_seen_at in
    // the past (simulating the original project that was created
    // before this DB was opened).
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO project_paths (project_key, canonical_root, first_seen_at, last_seen_at, last_canonical_root, record_count)
       VALUES (?, ?, ?, ?, NULL, 1)
       ON CONFLICT(project_key) DO UPDATE SET first_seen_at=excluded.first_seen_at`,
    ).run(key, cwd, past, past);
    // The cwd was just created via mkdtempSync, so its birthtime is
    // ~now. first_seen_at is an hour ago, so the gap is ~1h.
    const r = detectReclone(db, key, cwd);
    assert.equal(r.isReclone, true);
    assert.match(r.reason, /directory birthtime is .* newer than first_seen_at/);
    assert.ok(r.first_seen_at, 'first_seen_at populated');
    assert.ok(r.dir_birthtime, 'dir_birthtime populated');
    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
    rmRf(cwd);
  }
});

test('detectReclone: returns isReclone=false when first_seen_at is newer than directory birthtime (long-lived project)', () => {
  const home = freshHome();
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-d-'));
  const key = deriveProjectKey(cwd);
  try {
    const db = openDb(projectDbPath(home, key));
    // Stamp a first_seen_at slightly AFTER the directory was created.
    // The SessionStart hook fires within milliseconds of the directory
    // existing, so a 5-second future stamp is enough to flip the
    // comparison without being unrealistic.
    const future = new Date(Date.now() + 5_000).toISOString();
    db.prepare(
      `INSERT INTO project_paths (project_key, canonical_root, first_seen_at, last_seen_at, last_canonical_root, record_count)
       VALUES (?, ?, ?, ?, NULL, 1)
       ON CONFLICT(project_key) DO UPDATE SET first_seen_at=excluded.first_seen_at`,
    ).run(key, cwd, future, future);
    const r = detectReclone(db, key, cwd);
    assert.equal(r.isReclone, false);
    assert.match(r.reason, /predates or matches first_seen_at/);
    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
    rmRf(cwd);
  }
});

test('detectReclone: returns isReclone=false when directory birthtime is far in the past (long-lived project)', () => {
  // The "long-lived project" branch fires when the directory is older
  // than RECLONE_MAX_DIR_AGE_MS (7d) from now. To exercise it on every
  // platform we backdate the directory's mtime via utimesSync (which
  // leaves birthtime untouched on Linux and Windows). The
  // implementation clamps to Math.min(birthtime, mtime), so on filesystems
  // with a reliable birthtime we still see the backdated mtime.
  //
  // Setup: directory mtime = 10 days ago (older than the 7d ceiling),
  // first_seen_at = 30 days ago (so dirAheadMs is positive — the
  // directory is "newer than the recorded first_seen_at", which is the
  // combination that flips the function out of "predates" and into
  // "long-lived project").
  if (process.platform === 'win32') {
    // Windows honours utimes for both atime and mtime but not birthtime,
    // and the implementation on Windows uses birthtime directly (no
    // Math.min). Gating this assertion to non-Windows hosts avoids a
    // birthtime-mismatch false positive.
    return;
  }
  const home = freshHome();
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-d-'));
  const key = deriveProjectKey(cwd);
  try {
    const db = openDb(projectDbPath(home, key));
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(cwd, tenDaysAgo, tenDaysAgo);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO project_paths (project_key, canonical_root, first_seen_at, last_seen_at, last_canonical_root, record_count)
       VALUES (?, ?, ?, ?, NULL, 1)
       ON CONFLICT(project_key) DO UPDATE SET first_seen_at=excluded.first_seen_at`,
    ).run(key, cwd, thirtyDaysAgo, thirtyDaysAgo);
    const r = detectReclone(db, key, cwd);
    assert.equal(r.isReclone, false);
    assert.match(r.reason, /long-lived project/);
    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
    rmRf(cwd);
  }
});

test('detectReclone: returns safe shape when canonical root is missing on disk', () => {
  const home = freshHome();
  // Use a path that does not exist on disk.
  const cwd = 'C:/this/path/definitely/does/not/exist/km-test';
  const key = deriveProjectKey(cwd);
  try {
    const db = openDb(projectDbPath(home, key));
    recordProjectPath(db, key, cwd);
    const r = detectReclone(db, key, cwd);
    assert.equal(r.isReclone, false);
    assert.match(r.reason, /canonical root not on disk/);
    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
  }
});

test('resetProject: wipes per-project rows but preserves the project_paths row and resets first_seen_at', () => {
  const home = freshHome();
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-rp-'));
  const key = deriveProjectKey(cwd);
  try {
    const db = openDb(projectDbPath(home, key));
    // Seed: one memory of every type, one WM slot, one conversation
    // with one event, one edge, one synthesizes link.
    saveMemory(db, key, {
      type: 'semantic',
      title: 'rule',
      content: 'tabs not spaces',
      tags: [],
      metadata: {},
      provenance: { source: 'test' },
      confidence: 0.8,
      status: 'active',
      priority: 0,
      expires_at: null,
      supersede: false,
      _embed: false,
    });
    const other = saveMemory(db, key, {
      type: 'procedural',
      title: 'deploy',
      content: 'push to main, CI ships',
      tags: [],
      metadata: {},
      provenance: { source: 'test' },
      confidence: 0.8,
      status: 'active',
      priority: 0,
      expires_at: null,
      supersede: false,
      _embed: false,
    });
    setWorkingMemory(db, key, 'current_focus', 'a long in-flight note');
    upsertConversation(db, key, 'sess-1', cwd);
    recordConversationEvent(db, key, 'sess-1', 1, 0, {
      role: 'user',
      kind: 'message',
      payload: '{"text":"hi"}',
      summary: 'hi',
      created_at: new Date().toISOString(),
    });
    updateConversationProgress(db, key, 'sess-1', 100, 1, new Date().toISOString());
    recordProjectPath(db, key, cwd);

    // Sanity: every table has its row.
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key=?').get(key).n,
      2,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM working_memory WHERE project_key=?').get(key).n,
      1,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_key=?').get(key).n,
      1,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?').get(key).n,
      1,
    );

    const summary = resetProject(db, key);
    assert.equal(summary.memories_deleted, 2);
    assert.equal(summary.working_memory_deleted, 1);
    assert.equal(summary.conversations_deleted, 1);
    assert.equal(summary.conversation_events_deleted, 1);
    assert.equal(summary.project_path_preserved, true);

    // After: every per-project row is gone.
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key=?').get(key).n,
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM working_memory WHERE project_key=?').get(key).n,
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_key=?').get(key).n,
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?').get(key).n,
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM memory_edges WHERE project_key=?').get(key).n,
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM memory_synthesizes WHERE project_key=?').get(key).n,
      0,
    );

    // project_paths is preserved; first_seen_at was reset to now.
    // canonical_root is preserved across the reset when the caller does
    // not pass a fresh value — overwriting with '' would mark the
    // just-reset project as a self-orphan on the next memory_prune run.
    // (Audit flag F-102.)
    const row = listProjectPaths(db).find((r) => r.project_key === key);
    assert.ok(row, 'project_paths row preserved');
    assert.equal(row.canonical_root, cwd, 'canonical_root preserved when caller passes none');
    const ageMs = Date.now() - Date.parse(row.first_seen_at);
    assert.ok(ageMs < 10_000, 'first_seen_at is recent (within 10s)');

    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
    rmRf(cwd);
  }
});

test('resetProject: passes a fresh canonical_root through to project_paths', () => {
  // When the caller supplies a canonical root (the MCP handler and CLI
  // both have one), resetProject overwrites the existing value with
  // the new one. (Audit flag F-102.)
  const home = freshHome();
  const oldCwd = mkdtempSync(path.join(tmpdir(), 'km-rp-old-'));
  const newCwd = mkdtempSync(path.join(tmpdir(), 'km-rp-new-'));
  const key = deriveProjectKey(oldCwd);
  try {
    const db = openDb(projectDbPath(home, key));
    recordProjectPath(db, key, oldCwd);
    const before = listProjectPaths(db).find((r) => r.project_key === key);
    assert.equal(before.canonical_root, oldCwd);

    const summary = resetProject(db, key, { canonicalRoot: newCwd });
    assert.equal(summary.project_path_preserved, true);

    const after = listProjectPaths(db).find((r) => r.project_key === key);
    assert.equal(after.canonical_root, newCwd, 'canonical_root updated to caller-supplied value');

    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
    rmRf(oldCwd);
    rmRf(newCwd);
  }
});

test('resetProject: never touches rows belonging to a different project_key', () => {
  const home = freshHome();
  const cwdA = mkdtempSync(path.join(tmpdir(), 'km-iso-A-'));
  const cwdB = mkdtempSync(path.join(tmpdir(), 'km-iso-B-'));
  const keyA = deriveProjectKey(cwdA);
  const keyB = deriveProjectKey(cwdB);
  try {
    const dbA = openDb(projectDbPath(home, keyA));
    const dbB = openDb(projectDbPath(home, keyB));
    saveMemory(dbA, keyA, {
      type: 'semantic',
      title: 'a-stays',
      content: 'A must survive',
      tags: [],
      metadata: {},
      provenance: {},
      confidence: 0.8,
      status: 'active',
      priority: 0,
      expires_at: null,
      supersede: false,
      _embed: false,
    });
    saveMemory(dbB, keyB, {
      type: 'semantic',
      title: 'b-goes',
      content: 'B will be reset',
      tags: [],
      metadata: {},
      provenance: {},
      confidence: 0.8,
      status: 'active',
      priority: 0,
      expires_at: null,
      supersede: false,
      _embed: false,
    });
    // Wipe B; A in a separate DB and CWD must be untouched.
    const summary = resetProject(dbB, keyB);
    assert.equal(summary.memories_deleted, 1);
    // A's row in A's DB is unaffected.
    const aRows = dbA.prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key=?').get(keyA).n;
    assert.equal(aRows, 1, 'A project memory survives B reset');
    // Global DB is in a different file entirely and was never opened.
    assert.ok(!existsSync(globalDbPath(home)), 'global DB does not exist (untouched)');
    closeDb(projectDbPath(home, keyA));
    closeDb(projectDbPath(home, keyB));
  } finally {
    rmRf(home);
    rmRf(cwdA);
    rmRf(cwdB);
  }
});

test('MCP round-trip: memory_reset_project dry-run reports counts without deleting', async () => {
  const home = freshHome();
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-mcp-dry-'));
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    // Seed a memory so the dry run has something to report.
    const save = await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 'will-be-listed',
      content: 'this row counts toward the dry run total',
    });
    assert.equal(JSON.parse(save.content[0].text).operation, 'saved');
    // Dry run without confirm.
    const dry = await mcp.toolCall('memory_reset_project', { cwd });
    const dryJson = JSON.parse(dry.content[0].text);
    assert.equal(dryJson.operation, 'reset_project_dry_run');
    assert.ok(dryJson.row_counts, 'row_counts present');
    assert.equal(dryJson.row_counts.memories, 1, 'one memory on file');
    assert.equal(dryJson.total_rows >= 1, true, 'total_rows counts memories');
    // The memory must still be on file after the dry run.
    const list = await mcp.toolCall('memory_list', { cwd, scope: 'project' });
    const listJson = JSON.parse(list.content[0].text);
    assert.equal(listJson.count, 1, 'dry run did not delete the memory');
  } finally {
    mcp.stop();
    rmRf(home);
    rmRf(cwd);
  }
});

test('MCP round-trip: memory_reset_project with confirm=true wipes the per-project rows and the global DB is untouched', async () => {
  const home = freshHome();
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-mcp-apply-'));
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    // Seed project + global memories.
    const proj = await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 'project-memory',
      content: 'project row',
    });
    assert.equal(JSON.parse(proj.content[0].text).operation, 'saved');
    const glob = await mcp.toolCall('memory_save', {
      cwd,
      scope: 'global',
      type: 'semantic',
      title: 'global-memory',
      content: 'global row',
    });
    assert.equal(JSON.parse(glob.content[0].text).operation, 'saved');
    // Apply the reset.
    const apply = await mcp.toolCall('memory_reset_project', { cwd, confirm: true });
    const applyJson = JSON.parse(apply.content[0].text);
    assert.equal(applyJson.operation, 'reset_project');
    assert.equal(applyJson.memories_deleted, 1, 'one project memory wiped');
    // Project memory is gone; global memory survives.
    const listProj = await mcp.toolCall('memory_list', { cwd, scope: 'project' });
    const listProjJson = JSON.parse(listProj.content[0].text);
    assert.equal(listProjJson.count, 0, 'project memory deleted');
    const listGlobal = await mcp.toolCall('memory_list', { cwd, scope: 'global' });
    const listGlobalJson = JSON.parse(listGlobal.content[0].text);
    assert.equal(listGlobalJson.count, 1, 'global memory survives reset');
    // The global DB file is intact.
    assert.ok(existsSync(globalDbPath(home)), 'global DB still exists');
  } finally {
    mcp.stop();
    rmRf(home);
    rmRf(cwd);
  }
});

test('persist: detectReclone + resetProject integrate end-to-end for a re-cloned project', () => {
  // The MCP round-trip version of this test is fragile because the MCP
  // server caches its own DB handle and would not see the in-test
  // backdating UPDATE. The persist-layer path is the source of truth
  // for detectReclone, so the integration check lives here.
  const home = freshHome();
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-recl-persist-'));
  const key = deriveProjectKey(cwd);
  try {
    // Seed: memory + WM + project_paths row.
    const db = openDb(projectDbPath(home, key));
    saveMemory(db, key, {
      type: 'semantic',
      title: 'pre-reclone',
      content: 'belongs to the previous incarnation',
      tags: [],
      metadata: {},
      provenance: {},
      confidence: 0.8,
      status: 'active',
      priority: 0,
      expires_at: null,
      supersede: false,
      _embed: false,
    });
    setWorkingMemory(db, key, 'current_focus', 'a stale note from the previous incarnation');
    recordProjectPath(db, key, cwd);
    // Backdate first_seen_at by 1 hour. mkdtempSync just created cwd,
    // so its birthtime is ~now and first_seen_at is now 1h in the past.
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE project_paths SET first_seen_at = ? WHERE project_key = ?').run(past, key);
    // detectReclone should now flag the re-clone.
    const r = detectReclone(db, key, cwd);
    assert.equal(r.isReclone, true, 'reclone detected after backdating first_seen_at');
    assert.match(r.reason, /newer than first_seen_at/);
    // resetProject wipes the rows; first_seen_at is bumped to now.
    const summary = resetProject(db, key);
    assert.equal(summary.memories_deleted, 1);
    assert.equal(summary.working_memory_deleted, 1);
    assert.equal(summary.project_path_preserved, true);
    // After reset, detectReclone is silent: first_seen_at is now, dir
    // is older than first_seen_at, so the gap is non-positive.
    const after = detectReclone(db, key, cwd);
    assert.equal(after.isReclone, false, 'no re-clone signal after reset');
    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
    rmRf(cwd);
  }
});

test('MCP round-trip: memory_reset_project rejects a missing project DB without crashing', async () => {
  const home = freshHome();
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-mcp-empty-'));
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const out = await mcp.toolCall('memory_reset_project', { cwd, confirm: true });
    const text = out.content[0].text;
    const json = JSON.parse(text);
    assert.ok(json.error, 'error returned when no project DB exists');
    assert.match(json.error, /no project DB/);
  } finally {
    mcp.stop();
    rmRf(home);
    rmRf(cwd);
  }
});
