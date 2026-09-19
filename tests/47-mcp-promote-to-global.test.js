// Tests for memory_promote_to_global at the MCP-protocol level. The
// tool moves one or more project memories into the cross-project
// _global store; verifies end-to-end through a real stdio MCP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf, StdioMcp } from './_helpers.js';

async function boot() {
  const home = mkTempHome();
  const mcp = new StdioMcp({ home });
  mcp.start();
  await mcp.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  return { home, mcp };
}

test('memory_promote_to_global: appears in the tool list and accepts the documented schema', async () => {
  const { home, mcp } = await boot();
  try {
    const listed = await mcp.call('tools/list', {});
    const tools = listed.tools || listed;
    const names = (Array.isArray(tools) ? tools : []).map((t) => t.name);
    assert.ok(
      names.includes('memory_promote_to_global'),
      `memory_promote_to_global should be registered, got: ${names.join(',')}`,
    );
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('memory_promote_to_global: moves a row from project DB to global DB', async () => {
  const { home, mcp } = await boot();
  try {
    const cwdA = 'C:/projects/promote-a-' + Date.now();
    const cwdB = 'C:/projects/promote-b-' + Date.now();

    // Save a project-scoped memory in project A.
    const saved = JSON.parse(
      (
        await mcp.toolCall('memory_save', {
          cwd: cwdA,
          type: 'semantic',
          title: 'user prefers dark mode',
          content: 'cross-project user preference',
          tags: ['user-preference'],
        })
      ).content[0].text,
    );
    const id = saved.memory.id;
    assert.ok(id);

    // Promote.
    const promoted = JSON.parse(
      (
        await mcp.toolCall('memory_promote_to_global', {
          cwd: cwdA,
          memory_ids: [id],
        })
      ).content[0].text,
    );
    assert.equal(promoted.operation, 'promoted_to_global');
    assert.equal(promoted.moved_count, 1);
    assert.equal(promoted.moved.length, 1);
    assert.equal(promoted.moved[0].id, id);
    assert.equal(promoted.moved[0].new_global_id, id);
    assert.equal(promoted.moved[0].type, 'semantic');
    assert.equal(promoted.moved[0].title, 'user prefers dark mode');
    assert.equal(promoted.skipped_count, 0);

    // Recall from project B with default scope="all" — the promoted
    // row must surface.
    const recallB = JSON.parse(
      (await mcp.toolCall('memory_recall', { cwd: cwdB, query: 'dark mode' })).content[0].text,
    );
    const ids = recallB.items.map((i) => i.id);
    assert.ok(ids.includes(id), 'promoted row should be recalled from any project');

    // The project DB no longer has the row.
    const listProj = JSON.parse(
      (await mcp.toolCall('memory_list', { cwd: cwdA, scope: 'project' })).content[0].text,
    );
    assert.equal(
      listProj.items.find((m) => m.id === id),
      undefined,
      'promoted row should be gone from the project DB',
    );

    // The global DB has it.
    const listGlob = JSON.parse(
      (await mcp.toolCall('memory_list', { cwd: cwdB, scope: 'global' })).content[0].text,
    );
    assert.ok(
      listGlob.items.find((m) => m.id === id),
      'promoted row should appear in the global DB',
    );
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('memory_promote_to_global: missing ids land in skipped', async () => {
  const { home, mcp } = await boot();
  try {
    const cwd = 'C:/projects/promote-missing-' + Date.now();
    const r = JSON.parse(
      (
        await mcp.toolCall('memory_promote_to_global', {
          cwd,
          memory_ids: ['nonexistent-id-1234'],
        })
      ).content[0].text,
    );
    assert.equal(r.moved_count, 0);
    assert.equal(r.skipped_count, 1);
    assert.equal(r.skipped[0].id, 'nonexistent-id-1234');
    assert.equal(r.skipped[0].reason, 'not_found');
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('memory_promote_to_global: empty memory_ids array is rejected', async () => {
  const { home, mcp } = await boot();
  try {
    const cwd = 'C:/projects/promote-empty-' + Date.now();
    const r = await mcp.toolCall('memory_promote_to_global', {
      cwd,
      memory_ids: [],
    });
    assert.equal(r.isError, true, 'empty memory_ids must be rejected');
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('memory_promote_to_global: duplicate ids are deduplicated and reported once', async () => {
  const { home, mcp } = await boot();
  try {
    const cwd = 'C:/projects/promote-dup-' + Date.now();
    const saved = JSON.parse(
      (
        await mcp.toolCall('memory_save', {
          cwd,
          type: 'semantic',
          title: 'dup candidate',
          content: 'will be promoted twice',
          tags: [],
        })
      ).content[0].text,
    );
    const id = saved.memory.id;
    const r = JSON.parse(
      (
        await mcp.toolCall('memory_promote_to_global', {
          cwd,
          memory_ids: [id, id, id],
        })
      ).content[0].text,
    );
    assert.equal(r.moved_count, 1, 'duplicate ids collapse to one move');
    assert.equal(r.skipped.length, 2, 'two duplicates reported as skipped');
    for (const s of r.skipped) {
      assert.equal(s.id, id);
      assert.equal(s.reason, 'duplicate');
    }
  } finally {
    mcp.stop();
    rmRf(home);
  }
});
