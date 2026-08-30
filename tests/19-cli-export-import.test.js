// CLI export / import round-trip. The CLI bin (src/cli.js) is the
// public surface for backup and migration; this test drives it as a
// real subprocess so the file format, JSON shape, and CLI argument
// parsing are all exercised end-to-end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pluginRoot, StdioMcp, rmRf } from './_helpers.js';
import { openDb, closeDb, listMemories } from '../src/persist.js';
import {
  deriveProjectKey,
  projectDbPath,
  globalDbPath,
  GLOBAL_PROJECT_KEY,
  canonicalizeRoot,
} from '../src/project-key.js';

function runCli(args, { cwd, home } = {}) {
  const ownHome = home || mkdtempSync(path.join(tmpdir(), 'pm-export-'));
  const r = spawnSync(process.execPath, [path.join(pluginRoot(), 'src/cli.js'), ...args], {
    cwd: cwd || pluginRoot(),
    env: { ...process.env, KIMI_CODE_HOME: ownHome, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, home: ownHome };
}

async function seed(home, cwd) {
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'export-test', version: '0' },
    });
    await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 'tabs vs spaces',
      content: 'Use four spaces for indentation',
      tags: ['style'],
    });
    await mcp.toolCall('memory_save', {
      cwd,
      type: 'procedural',
      title: 'release process',
      content: 'Tag → npm ci → push → verify',
      tags: ['release'],
    });
    await mcp.toolCall('working_memory_set', {
      cwd,
      slot: 'current_focus',
      value: 'export-import test',
    });
  } finally {
    mcp.stop();
  }
}

test('CLI export writes a valid JSON file with memories and working slots', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'pm-export-'));
  const cwd = canonicalizeRoot('C:/projects/cli-export-' + Date.now());
  await seed(home, cwd);
  const out = path.join(home, 'dump.json');
  const r = runCli(['export', out, '--cwd', cwd, '--scope', 'project'], { home });
  assert.equal(r.status, 0, 'export must exit 0; stderr=' + r.stderr);
  assert.ok(existsSync(out), 'export file must exist');
  const doc = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(doc.version, 1);
  assert.equal(doc.scopes.project.project_key, deriveProjectKey(cwd));
  assert.ok(doc.scopes.project.memories.length >= 2);
  assert.ok(doc.scopes.project.working_memory.some((w) => w.slot === 'current_focus'));
  // Embedding BLOBs are stripped from the dump.
  for (const m of doc.scopes.project.memories) {
    assert.ok(!('embedding' in m), 'embedding BLOB must be stripped from export');
  }
  rmRf(home);
});

test('CLI import round-trips: export → import produces an identical dataset', async () => {
  const home1 = mkdtempSync(path.join(tmpdir(), 'pm-source-'));
  const home2 = mkdtempSync(path.join(tmpdir(), 'pm-target-'));
  const cwd = canonicalizeRoot('C:/projects/cli-roundtrip-' + Date.now());

  // Seed source.
  await seed(home1, cwd);

  // Export from source.
  const dump = path.join(home1, 'dump.json');
  const exp = runCli(['export', dump, '--cwd', cwd, '--scope', 'project'], { home: home1 });
  assert.equal(exp.status, 0, 'export must succeed');

  // Import into target (which has no DB yet).
  const imp = runCli(['import', dump, '--cwd', cwd, '--scope', 'project', '--merge'], {
    home: home2,
  });
  assert.equal(imp.status, 0, 'import must succeed; stderr=' + imp.stderr);

  // Read the imported DB and confirm.
  const key = deriveProjectKey(cwd);
  const dbPath = projectDbPath(home2, key);
  assert.ok(existsSync(dbPath), 'import should create the target project DB');
  const db = openDb(dbPath);
  try {
    const rows = listMemories(db, key, { limit: 100, status: null });
    const titles = rows.map((r) => r.title).sort();
    assert.deepEqual(titles, ['release process', 'tabs vs spaces']);
    const slot = db
      .prepare('SELECT value FROM working_memory WHERE project_key=? AND slot=?')
      .get(key, 'current_focus');
    assert.ok(slot, 'current_focus slot must be imported');
    assert.equal(slot.value, 'export-import test');
  } finally {
    closeDb(dbPath);
  }

  rmRf(home1);
  rmRf(home2);
});

test('CLI import refuses to replace without --yes', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'pm-refuse-'));
  const cwd = canonicalizeRoot('C:/projects/cli-refuse-' + Date.now());
  await seed(home, cwd);
  const dump = path.join(home, 'dump.json');
  runCli(['export', dump, '--cwd', cwd, '--scope', 'project'], { home });
  const r = runCli(['import', dump, '--cwd', cwd, '--scope', 'project', '--replace'], { home });
  assert.notEqual(r.status, 0, 'replace without --yes must fail');
  assert.match(r.stderr, /refusing to replace/);
  rmRf(home);
});

test('CLI import --replace wipes the target before loading', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'pm-replace-'));
  const cwd = canonicalizeRoot('C:/projects/cli-replace-' + Date.now());
  // Seed initial memories.
  await seed(home, cwd);
  // Export before adding unrelated memory.
  const dump = path.join(home, 'dump.json');
  runCli(['export', dump, '--cwd', cwd, '--scope', 'project'], { home });
  // Now add an unrelated memory to the target.
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 'unrelated noise',
      content: 'this row should be wiped on replace',
    });
  } finally {
    mcp.stop();
  }
  // Import with replace should wipe the unrelated memory.
  const r = runCli(['import', dump, '--cwd', cwd, '--scope', 'project', '--replace', '--yes'], {
    home,
  });
  assert.equal(r.status, 0, 'replace with --yes must succeed; stderr=' + r.stderr);
  const key = deriveProjectKey(cwd);
  const db = openDb(projectDbPath(home, key));
  try {
    const rows = listMemories(db, key, { limit: 100, status: null });
    const titles = rows.map((m) => m.title).sort();
    assert.ok(!titles.includes('unrelated noise'), 'unrelated noise should be wiped');
    assert.deepEqual(titles, ['release process', 'tabs vs spaces']);
  } finally {
    closeDb(projectDbPath(home, key));
  }
  rmRf(home);
});

test('CLI export → import preserves v10 ACL, tier, persona_id, synthesizes edges', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'pm-acl-'));
  const cwd = canonicalizeRoot('C:/projects/cli-acl-' + Date.now());
  const mcp = new StdioMcp({ home });
  mcp.start();
  let savedId;
  let concId;
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'acl-test', version: '0' },
    });
    const saveA = await mcp.toolCall('memory_save', {
      cwd,
      type: 'episodic',
      title: 'parent memory',
      content: 'will be synthesised',
      tags: ['alpha'],
      shared_with: ['user:alice', 'role:editor'],
    });
    savedId = JSON.parse(saveA.content[0].text).memory.id;
    const promote = await mcp.toolCall('memory_promote', {
      cwd,
      memory_id: savedId,
      reason: 'manual test promotion',
    });
    assert.equal(JSON.parse(promote.content[0].text).memory.tier, 'L1');
    const saveConc = await mcp.toolCall('memory_save', {
      cwd,
      type: 'conclusion',
      title: 'synthesis',
      content: 'one conclusion',
      synthesizes: [savedId],
    });
    concId = JSON.parse(saveConc.content[0].text).memory.id;
  } finally {
    mcp.stop();
  }

  const dump = path.join(home, 'acl.json');
  const exp = runCli(['export', dump, '--cwd', cwd, '--scope', 'project'], { home });
  assert.equal(exp.status, 0, 'export must exit 0; stderr=' + exp.stderr);

  const key = deriveProjectKey(cwd);
  closeDb(projectDbPath(home, key));
  const r = runCli(['import', dump, '--cwd', cwd, '--scope', 'project'], { home });
  assert.equal(r.status, 0, 'import must exit 0; stderr=' + r.stderr);

  const db = openDb(projectDbPath(home, key));
  try {
    const row = db.prepare('SELECT * FROM memories WHERE id=? AND project_key=?').get(savedId, key);
    assert.ok(row, 'parent memory must exist after import');
    assert.equal(row.visibility, 'private');
    assert.equal(row.shared_with, '["user:alice","role:editor"]');
    assert.equal(row.tier, 'L1');
    const synth = db
      .prepare('SELECT child_id FROM memory_synthesizes WHERE parent_id=? AND project_key=?')
      .all(concId, key);
    assert.deepEqual(
      synth.map((r) => r.child_id),
      [savedId],
    );
    const fts = db
      .prepare('SELECT id FROM memories_fts WHERE id=? AND project_key=?')
      .get(savedId, key);
    assert.ok(fts, 'FTS row must exist after import');
  } finally {
    closeDb(projectDbPath(home, key));
  }
  rmRf(home);
});
