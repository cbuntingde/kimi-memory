// Wiki-removal smoke tests. Locks in that the wiki subsystem is gone:
//   - src/wiki.js is not present
//   - server.js does not import or register any wiki_* tool
//   - freshly-opened project DBs do not get wiki_pages / wiki_links /
//     wiki_fts tables created by the v14+ migration list
//   - the module loads cleanly under KIMI_MEMORY_LEGACY_SUBSYSTEMS=off
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { mkTempHome, rmRf, pluginRoot } from './_helpers.js';
import { openDb, closeDb } from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

const root = pluginRoot();

test('wiki: src/wiki.js is removed', () => {
  assert.equal(
    existsSync(path.join(root, 'src', 'wiki.js')),
    false,
    'src/wiki.js should be deleted (v14 wiki removal)',
  );
});

test('wiki: server.js has no wiki import + no wiki_… tool name', () => {
  const serverSrc = readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  assert.equal(
    /from\s+['"]\.\/wiki(\.js)?['"]/.test(serverSrc),
    false,
    'src/server.js should not import ./wiki.js',
  );
  // TOOL_DEFS block has no `name: 'wiki_…'` entry. Lives in
  // src/mcp/tool-defs.js since the Phase-1 refactor; server.js
  // re-exports it for the proxy.
  const defsSrc = readFileSync(path.join(root, 'src', 'mcp', 'tool-defs.js'), 'utf8');
  const def = defsSrc.match(/export const TOOL_DEFS = \[([\s\S]*?)\];/);
  assert.ok(def, 'TOOL_DEFS not found in src/mcp/tool-defs.js');
  const wikiToolNames = def[1].match(/name:\s*'wiki_[a-z_]+'/g) || [];
  assert.deepEqual(wikiToolNames, [], 'TOOL_DEFS must not declare any wiki_… tool');
  // server.tool registrations — there must be no wiki_* wired into a
  // tool registration. (Accept either an explicit `wiki_…` literal in
  // the server.tool call or TOOL_DEFS[NN] inside the legacy gate.)
  const wikiWires = serverSrc.match(/server\.tool\(\s*['"]?wiki_/g) || [];
  assert.deepEqual(wikiWires, [], 'no server.tool() may be wired to wiki_…');
});

test('wiki: fresh project DB does not get wiki_pages / wiki_links / wiki_fts created by v14+ migrations', () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/wiki-removed');
  const dbPath = projectDbPath(home, key);
  try {
    const db = openDb(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wiki_%'")
      .all()
      .map((r) => r.name)
      .sort();
    assert.deepEqual(tables, [], 'no wiki_* tables should be created by the v14+ migration list');
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('wiki: server.js loads cleanly with LEGACY_SUBSYSTEMS=off', async () => {
  const prev = process.env.KIMI_MEMORY_LEGACY_SUBSYSTEMS;
  process.env.KIMI_MEMORY_LEGACY_SUBSYSTEMS = 'off';
  try {
    // Use a dynamic import so the env var is in place before module
    // evaluation. server.js reads the env at module top level to gate
    // the legacy tool block.
    const mod = await import('../src/server.js');
    assert.ok(mod && typeof mod === 'object', 'server.js module loads');
  } finally {
    if (prev === undefined) delete process.env.KIMI_MEMORY_LEGACY_SUBSYSTEMS;
    else process.env.KIMI_MEMORY_LEGACY_SUBSYSTEMS = prev;
  }
});
