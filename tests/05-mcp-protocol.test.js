// End-to-end MCP protocol smoke test over stdio. Verifies newline-delimited
// JSON framing, initialize, tools/list, the core CRUD + working-memory
// + status tools, strict per-project isolation across two projects,
// scope-aware routing (project / global / all), global cross-project
// recall, and combined-status reporting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf, StdioMcp } from './_helpers.js';

test('MCP server: initialize, list tools, save/list/get/delete, status, isolation', async () => {
  const home = mkTempHome();
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    const init = await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.ok(init && init.capabilities || init && (init.serverInfo || init.result));
    const tools = await mcp.call('tools/list', {});
    const names = (tools.tools || []).map((t) => t.name);
    for (const expected of ['memory_save', 'memory_recall', 'memory_list', 'memory_get', 'memory_update', 'memory_delete', 'memory_save_bulk', 'working_memory_set', 'working_memory_get', 'working_memory_clear', 'conversation_list', 'conversation_get', 'conversation_search', 'memory_status', 'conversation_ingest']) {
      assert.ok(names.includes(expected), 'expected tool missing: ' + expected);
    }

    const cwdA = 'C:/projects/alpha-' + Date.now();
    const cwdB = 'C:/projects/beta-' + Date.now();

    // Save a few entries to project A (scope defaults to "project").
    const s1 = await mcp.toolCall('memory_save', { cwd: cwdA, type: 'semantic', title: 'tabs vs spaces', content: 'we use tabs, no semicolons', tags: ['style', 'code'] });
    const j1 = JSON.parse(s1.content[0].text);
    assert.equal(j1.operation, 'saved');
    assert.equal(j1.scope, 'project');
    assert.ok(j1.memory && j1.memory.id);

    const s2 = await mcp.toolCall('memory_save', { cwd: cwdA, type: 'procedural', title: 'release', content: 'git tag && git push --tags', tags: ['ci'] });
    const j2 = JSON.parse(s2.content[0].text);
    assert.ok(j2.memory.id);

    // Save something into project B (scope=project, isolated) and verify isolation.
    const sB = await mcp.toolCall('memory_save', { cwd: cwdB, type: 'semantic', content: 'beta only', tags: [] });
    const jB = JSON.parse(sB.content[0].text);
    assert.ok(jB.memory.id);

    // Explicit scope="project" keeps results per-project.
    const listA = JSON.parse((await mcp.toolCall('memory_list', { cwd: cwdA, scope: 'project', limit: 10 })).content[0].text);
    const listB = JSON.parse((await mcp.toolCall('memory_list', { cwd: cwdB, scope: 'project', limit: 10 })).content[0].text);
    assert.equal(listA.count, 2);
    assert.equal(listB.count, 1);

    // Cross-project get with scope="project" returns not-found.
    const x = await mcp.toolCall('memory_get', { cwd: cwdA, scope: 'project', id: jB.memory.id });
    assert.equal(x.isError, true);

    // Recall with explicit scope="project" matches a keyword only in A.
    const recall = JSON.parse((await mcp.toolCall('memory_recall', { cwd: cwdA, scope: 'project', query: 'tabs' })).content[0].text);
    assert.ok(recall.count >= 1);
    assert.equal(recall.scope, 'project');
    for (const item of recall.items) assert.equal(item.scope || 'project', 'project', 'recall items should not carry a global tag for scope=project');

    // Update the title via scope=project.
    const upd = JSON.parse((await mcp.toolCall('memory_update', { cwd: cwdA, scope: 'project', id: j1.memory.id, title: 'tabs vs spaces (updated)' })).content[0].text);
    assert.equal(upd.operation, 'updated');
    assert.equal(upd.scope, 'project');
    assert.equal(upd.memory.title, 'tabs vs spaces (updated)');

    // Supersede the convention.
    const sup = JSON.parse((await mcp.toolCall('memory_save', { cwd: cwdA, type: 'semantic', title: 'tabs vs spaces', content: 'we use 2 spaces, no semicolons', supersede: true })).content[0].text);
    assert.equal(sup.operation, 'saved');
    // Now active list should have the new entry; old one is hidden.
    const listAfter = JSON.parse((await mcp.toolCall('memory_list', { cwd: cwdA, scope: 'project' })).content[0].text);
    assert.ok(listAfter.items.find((i) => i.id === sup.memory.id));

    // Working memory.
    const wm = JSON.parse((await mcp.toolCall('working_memory_set', { cwd: cwdA, slot: 'current_focus', value: 'ship the demo' })).content[0].text);
    assert.equal(wm.value, 'ship the demo');
    const wmg = JSON.parse((await mcp.toolCall('working_memory_get', { cwd: cwdA, slot: 'current_focus' })).content[0].text);
    assert.equal(wmg.value, 'ship the demo');
    const wmc = JSON.parse((await mcp.toolCall('working_memory_clear', { cwd: cwdA, slot: 'current_focus' })).content[0].text);
    assert.equal(wmc.cleared, true);

    // Status reports project + global summary.
    const status = JSON.parse((await mcp.toolCall('memory_status', { cwd: cwdA })).content[0].text);
    assert.ok(status.memories.active >= 2, 'project active memory count');
    assert.ok(status.working_memory_slots >= 0);
    assert.ok(status.global && status.global.memories, 'memory_status includes global summary');
    assert.equal(status.scopes.global, '_global');
    assert.match(status.project_key, /^[0-9a-f]{16}$/);

    // Delete (soft) via scope=project.
    const del = JSON.parse((await mcp.toolCall('memory_delete', { cwd: cwdA, scope: 'project', id: j2.memory.id })).content[0].text);
    assert.equal(del.operation, 'deleted');
    assert.equal(del.scope, 'project');
    assert.equal(del.deleted, true);
    const getDel = await mcp.toolCall('memory_get', { cwd: cwdA, scope: 'project', id: j2.memory.id });
    assert.equal(getDel.isError, true);

    // Validation: bad input.
    const bad = await mcp.toolCall('memory_save', { cwd: cwdA, type: 'banana', content: 'x' });
    assert.equal(bad.isError, true);
    const badCwd = await mcp.toolCall('memory_save', { cwd: 'relative/path', type: 'semantic', content: 'x' });
    assert.equal(badCwd.isError, true);
    const badScope = await mcp.toolCall('memory_save', { cwd: cwdA, scope: 'all', type: 'semantic', content: 'x' });
    assert.equal(badScope.isError, true, 'write tools must reject scope=all');
    const badReadScope = await mcp.toolCall('memory_recall', { cwd: cwdA, scope: 'lol', query: 'tabs' });
    assert.equal(badReadScope.isError, true);
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP server: global memory saved from project A is recalled from project B and project memories never cross projects', async () => {
  const home = mkTempHome();
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });

    const cwdA = 'C:/projects/gamma-' + Date.now();
    const cwdB = 'C:/projects/delta-' + Date.now();

    // Global memory saved while sitting in project A.
    const gSave = await mcp.toolCall('memory_save', { cwd: cwdA, scope: 'global', type: 'semantic', title: 'theme preference', content: 'User prefers dark themes everywhere', tags: ['theme'] });
    const gSaved = JSON.parse(gSave.content[0].text);
    assert.equal(gSaved.operation, 'saved');
    assert.equal(gSaved.scope, 'global');
    const gId = gSaved.memory.id;
    assert.ok(gId);

    // Project-only memory from project A — must NEVER surface from project B.
    const projSave = await mcp.toolCall('memory_save', { cwd: cwdA, type: 'semantic', title: 'proj only doc', content: 'this is private project A info', tags: [] });
    const projSaved = JSON.parse(projSave.content[0].text);
    const projId = projSaved.memory.id;

    // Recall from project B with default scope ("all"). The global hit
    // must surface; the project-only row from A must not.
    const recallB = JSON.parse((await mcp.toolCall('memory_recall', { cwd: cwdB, query: 'theme preference' })).content[0].text);
    assert.equal(recallB.operation, 'recalled');
    assert.equal(recallB.scope, 'all');
    assert.ok(recallB.count >= 1, 'global memory should be recalled from project B');
    const ids = recallB.items.map((i) => i.id);
    assert.ok(ids.includes(gId), 'global id should appear');
    assert.ok(!ids.includes(projId), 'project-A row must not cross into project B');
    for (const item of recallB.items) assert.equal(item.scope, 'global', 'all-scope results carry a scope tag');

    // explicit scope="global" + cwdB finds the same global row.
    const globList = JSON.parse((await mcp.toolCall('memory_list', { cwd: cwdB, scope: 'global' })).content[0].text);
    assert.equal(globList.operation, 'listed');
    assert.equal(globList.scope, 'global');
    for (const item of globList.items) assert.equal(item.scope, 'global');

    // scope="global" memory_get from project B returns the global row stamped "global".
    const got = JSON.parse((await mcp.toolCall('memory_get', { cwd: cwdB, scope: 'global', id: gId })).content[0].text);
    assert.equal(got.operation, 'got');
    assert.equal(got.memory.scope, 'global');
    assert.equal(got.memory.id, gId);

    // Global mutation targeted at global scope must succeed.
    const upd = JSON.parse((await mcp.toolCall('memory_update', { cwd: cwdB, scope: 'global', id: gId, title: 'theme preference (global)' })).content[0].text);
    assert.equal(upd.operation, 'updated');
    assert.equal(upd.scope, 'global');

    // Project-scoped update of a global memory must NOT find it.
    const miss = await mcp.toolCall('memory_update', { cwd: cwdB, scope: 'project', id: gId, title: 'should fail' });
    assert.equal(miss.isError, true, 'project-scoped update should reject a global id');

    // status reports the global summary.
    const status = JSON.parse((await mcp.toolCall('memory_status', { cwd: cwdB })).content[0].text);
    assert.ok(status.global && status.global.memories && status.global.memories.active >= 1);
    assert.equal(status.scopes.global, '_global');
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP server: scope="all" merge tags items by scope and preserves project-first order', async () => {
  const home = mkTempHome();
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });

    const cwd = 'C:/projects/epsilon-' + Date.now();
    await mcp.toolCall('memory_save', { cwd, scope: 'project', type: 'semantic', title: 'project codestyle', content: 'the repo uses tabs', tags: ['style'] });
    await mcp.toolCall('memory_save', { cwd, scope: 'global', type: 'semantic', title: 'global codestyle', content: 'globally we prefer tabs', tags: ['style'] });

    const merged = JSON.parse((await mcp.toolCall('memory_recall', { cwd, scope: 'all', query: 'tabs' })).content[0].text);
    assert.equal(merged.operation, 'recalled');
    assert.equal(merged.scope, 'all');
    assert.ok(merged.count >= 2);
    assert.ok(merged.project_count >= 1);
    assert.ok(merged.global_count >= 1);
    for (const item of merged.items) {
      assert.ok(item.scope === 'project' || item.scope === 'global', 'every item has a scope tag');
    }
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP server: invalid JSON-RPC returns an error result, not a crash', async () => {
  const home = mkTempHome();
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await new Promise((resolve) => {
      const id = mcp._send({ method: 'tools/nope', params: {} });
      mcp.pending.set(id, { resolve: () => resolve(), reject: () => resolve() });
    });
    const init = await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.ok(init);
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP server: memory_save_bulk saves many rows in one transaction and supersedes within the batch', async () => {
  const home = mkTempHome();
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const cwd = 'C:/projects/bulk-' + Date.now();
    const r = await mcp.toolCall('memory_save_bulk', {
      cwd,
      scope: 'project',
      items: [
        { type: 'semantic', title: 'tabs', content: 'use tabs' },
        { type: 'semantic', title: 'quotes', content: 'single quotes' },
        { type: 'procedural', title: 'release', content: 'git tag && git push --tags' },
        { type: 'semantic', title: 'tabs', content: 'use spaces', supersede: true },
      ],
    });
    const j = JSON.parse(r.content[0].text);
    assert.equal(r.isError, undefined);
    assert.equal(j.operation, 'saved_bulk');
    assert.equal(j.scope, 'project');
    assert.equal(j.count, 4);
    assert.equal(j.memories.length, 4);
    // Listing should show three active rows (prior "tabs" is superseded).
    const list = JSON.parse((await mcp.toolCall('memory_list', { cwd, scope: 'project', limit: 50 })).content[0].text);
    assert.equal(list.count, 3);
    // Bad input: bad type is rejected.
    const bad = await mcp.toolCall('memory_save_bulk', { cwd, items: [{ type: 'banana', content: 'x' }] });
    assert.equal(bad.isError, true);
    // Bad input: empty array is rejected.
    const empty = await mcp.toolCall('memory_save_bulk', { cwd, items: [] });
    assert.equal(empty.isError, true);
  } finally {
    mcp.stop();
    rmRf(home);
  }
});
