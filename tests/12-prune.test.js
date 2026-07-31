// Tests for the memory_prune tool and its backing helpers. The persist-
// layer tests run directly against the helper functions; a small MCP
// round-trip test exercises the JSON-RPC surface end-to-end, including
// the dry-run → apply contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkTempHome, rmRf, StdioMcp } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  recordProjectPath,
  listProjectPaths,
} from '../src/persist.js';
import {
  projectDbPath,
  globalDbPath,
  deriveProjectKey,
  ensureProjectDir,
  GLOBAL_PROJECT_KEY,
} from '../src/project-key.js';

function freshHome() {
  return mkTempHome('km-prune-');
}

test('schema v6: project_paths table is created on first open', () => {
  const home = freshHome();
  const key = deriveProjectKey('C:/test/prune-A');
  try {
    const dbPath = projectDbPath(home, key);
    openDb(dbPath);
    // Reopen to exercise the migration path.
    const db = openDb(dbPath);
    const cols = db.prepare('PRAGMA table_info(project_paths)').all();
    const names = new Set(cols.map((c) => c.name));
    for (const name of ['project_key', 'canonical_root', 'first_seen_at', 'last_seen_at']) {
      assert.ok(names.has(name), `column ${name} exists`);
    }
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_project_paths_root'",
      )
      .get();
    assert.ok(idx, 'idx_project_paths_root index exists');
  } finally {
    rmRf(home);
  }
});

test('recordProjectPath is idempotent and updates last_seen_at', async () => {
  const home = freshHome();
  const key = deriveProjectKey('C:/test/prune-B');
  try {
    const db = openDb(projectDbPath(home, key));
    recordProjectPath(db, key, 'C:/test/prune-B');
    const first = listProjectPaths(db).find((r) => r.project_key === key);
    assert.ok(first, 'first record exists');
    assert.equal(first.canonical_root, 'C:/test/prune-B');
    assert.equal(first.first_seen_at, first.last_seen_at, 'first_seen == last_seen on insert');
    // Re-record the same path after a small delay; last_seen should bump.
    await new Promise((r) => setTimeout(r, 5));
    recordProjectPath(db, key, 'C:/test/prune-B');
    const second = listProjectPaths(db).find((r) => r.project_key === key);
    assert.ok(second, 'second record exists');
    assert.equal(second.first_seen_at, first.first_seen_at, 'first_seen_at is preserved');
    assert.notEqual(second.last_seen_at, first.last_seen_at, 'last_seen_at bumps');
    // Re-record with a different canonical_root (project moved); first_seen
    // is still the original, last_seen moves forward.
    recordProjectPath(db, key, 'C:/elsewhere/prune-B');
    const third = listProjectPaths(db).find((r) => r.project_key === key);
    assert.equal(third.canonical_root, 'C:/elsewhere/prune-B');
    assert.equal(third.first_seen_at, first.first_seen_at);
    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
  }
});

test('global DB also has the empty project_paths table (no canonical root of its own)', () => {
  const home = freshHome();
  try {
    const db = openDb(globalDbPath(home));
    const rows = listProjectPaths(db);
    assert.deepEqual(rows, [], 'global DB starts with an empty project_paths table');
    closeDb(globalDbPath(home));
  } finally {
    rmRf(home);
  }
});

test('MCP round-trip: memory_prune dry-run reports orphans without deleting them', async () => {
  const home = freshHome();
  const activeCwd = mkdtempSync(path.join(tmpdir(), 'km-active-'));
  // Use a different temp dir as the "deleted project" so existsSync returns false.
  const deletedCwd = mkdtempSync(path.join(tmpdir(), 'km-orphan-'));
  // We have to remove the dir AFTER recording it.
  const deletedKey = deriveProjectKey(deletedCwd);
  // Open once via persist to seed a real DB; openDb creates the parent
  // directory recursively, so no separate ensureProjectDir is needed.
  {
    const db = openDb(projectDbPath(home, deletedKey));
    recordProjectPath(db, deletedKey, deletedCwd);
    saveMemory(db, deletedKey, {
      type: 'semantic',
      title: 'orphan-test',
      content: 'this project is going away',
      tags: [],
      metadata: {},
      provenance: { source: 'test' },
      confidence: 0.8,
      status: 'active',
      priority: 0,
      expires_at: null,
      supersede: false,
    });
    closeDb(projectDbPath(home, deletedKey));
  }
  // Now remove the deleted project's path on disk.
  rmRf(deletedCwd);

  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    // First write a memory to the active project so its DB exists; the
    // call also stamps project_paths via the MCP openScopeDb path.
    const save = await mcp.toolCall('memory_save', {
      cwd: activeCwd,
      type: 'semantic',
      title: 'active',
      content: 'still here',
    });
    const saveJson = JSON.parse(save.content[0].text);
    assert.equal(saveJson.operation, 'saved');

    // Dry run: every orphan should be reported as would-remove; nothing
    // should be removed.
    const dry = await mcp.toolCall('memory_prune', {
      cwd: activeCwd,
      scope: 'all-projects',
    });
    const dryJson = JSON.parse(dry.content[0].text);
    assert.equal(dryJson.operation, 'pruned');
    assert.equal(dryJson.apply, false);
    assert.ok(dryJson.orphan_count >= 1, 'at least one orphan reported');
    const orphan = dryJson.candidates.find(
      (c) => c.project_key === deletedKey && c.action === 'would-remove',
    );
    assert.ok(orphan, 'orphan candidate is reported with action=would-remove');
    assert.equal(orphan.exists_on_disk, false, 'canonical root no longer exists');
    assert.ok(
      existsSync(path.join(home, 'kimi-memory', deletedKey, 'memory.sqlite')),
      'dry run did not delete the file',
    );
    // The active project is always reported as kept-active.
    const activeEntry = dryJson.candidates.find((c) => c.action === 'kept-active');
    assert.ok(activeEntry, 'active project reported as kept-active');

    // Apply: now the orphan file is gone, the active project is untouched.
    const applied = await mcp.toolCall('memory_prune', {
      cwd: activeCwd,
      scope: 'all-projects',
      apply: true,
    });
    const appliedJson = JSON.parse(applied.content[0].text);
    assert.equal(appliedJson.removed, 1, 'one orphan removed');
    assert.ok(
      !existsSync(path.join(home, 'kimi-memory', deletedKey, 'memory.sqlite')),
      'orphan file is gone after apply',
    );
    // The active project DB still has its memory.
    const list = await mcp.toolCall('memory_list', { cwd: activeCwd, scope: 'project' });
    const listJson = JSON.parse(list.content[0].text);
    assert.equal(listJson.count, 1, 'active project memory survived prune');
  } finally {
    mcp.stop();
    rmRf(home);
    rmRf(activeCwd);
  }
});

test('MCP round-trip: memory_prune scope="project" never removes the active project', async () => {
  const home = freshHome();
  const activeCwd = mkdtempSync(path.join(tmpdir(), 'km-prune-scope-'));
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const save = await mcp.toolCall('memory_save', {
      cwd: activeCwd,
      type: 'semantic',
      title: 'alive',
      content: 'path exists',
    });
    const saveJson = JSON.parse(save.content[0].text);
    assert.equal(saveJson.operation, 'saved', 'memory_save succeeded before prune');
    // Confirm the active project DB landed where we expect.
    const activeKey = deriveProjectKey(activeCwd);
    assert.ok(
      existsSync(projectDbPath(home, activeKey)),
      'active project DB exists at ' + projectDbPath(home, activeKey),
    );
    // scope="project" should report the active project as kept-active
    // even though its canonical root is also "the current path on disk".
    const out = await mcp.toolCall('memory_prune', {
      cwd: activeCwd,
      scope: 'project',
      apply: true,
    });
    const json = JSON.parse(out.content[0].text);
    assert.equal(json.operation, 'pruned');
    const activeEntry = json.candidates.find((c) => c.action === 'kept-active');
    assert.ok(
      activeEntry,
      'active project is reported as kept-active; got: ' + JSON.stringify(json),
    );
    const orphans = json.candidates.filter(
      (c) => c.action === 'would-remove' || c.action === 'removed',
    );
    assert.equal(orphans.length, 0, 'scope=project never reports other projects');
  } finally {
    mcp.stop();
    rmRf(home);
    rmRf(activeCwd);
  }
});

test('MCP round-trip: memory_prune never touches the _global database', async () => {
  const home = freshHome();
  const activeCwd = mkdtempSync(path.join(tmpdir(), 'km-prune-global-'));
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    // Seed the global DB by writing a global memory through MCP.
    const save = await mcp.toolCall('memory_save', {
      cwd: activeCwd,
      scope: 'global',
      type: 'semantic',
      title: 'global-stays',
      content: 'this must survive every prune',
    });
    assert.equal(JSON.parse(save.content[0].text).operation, 'saved');
    assert.ok(
      existsSync(path.join(home, 'kimi-memory', GLOBAL_PROJECT_KEY, 'memory.sqlite')),
      'global DB exists before prune',
    );
    // Apply a project-scope prune (which has nothing to prune here) and
    // confirm the global DB still exists.
    const out = await mcp.toolCall('memory_prune', {
      cwd: activeCwd,
      scope: 'all-projects',
      apply: true,
    });
    const json = JSON.parse(out.content[0].text);
    assert.equal(json.note, 'global database is preserved (cross-project by definition)');
    assert.ok(
      existsSync(path.join(home, 'kimi-memory', GLOBAL_PROJECT_KEY, 'memory.sqlite')),
      'global DB still exists after prune',
    );
  } finally {
    mcp.stop();
    rmRf(home);
    rmRf(activeCwd);
  }
});
