// Tests for the memory_edges table + memory operations API (merge /
// link / unlink / edges). The persist-layer tests run directly against
// the helper functions; a single MCP round-trip test exercises the
// JSON-RPC surface end-to-end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf, StdioMcp } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  getMemory,
  listMemories,
  linkMemory,
  unlinkMemory,
  listEdges,
  mergeMemory,
} from '../src/persist.js';
import {
  projectDbPath,
  globalDbPath,
  deriveProjectKey,
  GLOBAL_PROJECT_KEY,
} from '../src/project-key.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/edges-A');
  return { home, key, dbPath: projectDbPath(home, key) };
}

test('memory_edges migration is idempotent and exposes the expected columns', () => {
  const { home, key, dbPath } = freshProject();
  try {
    openDb(dbPath);
    // Re-open — migration runs again. Should be a no-op.
    const db = openDb(dbPath);
    const cols = db.prepare('PRAGMA table_info(memory_edges)').all();
    const names = new Set(cols.map((c) => c.name));
    for (const name of ['id', 'project_key', 'from_id', 'to_id', 'kind', 'weight', 'created_at']) {
      assert.ok(names.has(name), `column ${name} exists`);
    }
    // Both indexes exist.
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_memory_edges_%'",
      )
      .all();
    const idxNames = new Set(idx.map((r) => r.name));
    assert.ok(idxNames.has('idx_memory_edges_from'), 'idx_memory_edges_from exists');
    assert.ok(idxNames.has('idx_memory_edges_to'), 'idx_memory_edges_to exists');
    // The CHECK constraint rejects unknown kinds.
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO memory_edges (id, project_key, from_id, to_id, kind, created_at) VALUES ('x','y','a','b','bogus','2026-01-01')",
          )
          .run(),
      /CHECK/,
    );
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('linkMemory creates a typed edge; deterministic id; idempotent on re-link', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const a = saveMemory(db, key, { type: 'semantic', title: 'A', content: 'apple' });
    const b = saveMemory(db, key, { type: 'semantic', title: 'B', content: 'apricot' });
    const edge1 = linkMemory(db, key, a.id, b.id, 'related');
    assert.ok(edge1.id, 'edge has an id');
    assert.equal(edge1.from_id, a.id);
    assert.equal(edge1.to_id, b.id);
    assert.equal(edge1.kind, 'related');
    assert.equal(edge1.weight, 1.0);
    // Re-link returns the same id (deterministic) without error.
    const edge2 = linkMemory(db, key, a.id, b.id, 'related');
    assert.equal(edge2.id, edge1.id, 'idempotent re-link returns the same edge id');
    // A different kind yields a different id.
    const edge3 = linkMemory(db, key, a.id, b.id, 'supports');
    assert.notEqual(edge3.id, edge1.id);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('linkMemory rejects invalid kind, missing ids, and self-links', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const a = saveMemory(db, key, { type: 'semantic', title: 'A', content: 'x' });
    assert.throws(() => linkMemory(db, key, a.id, a.id, 'related'), /differ/);
    assert.throws(() => linkMemory(db, key, a.id, 'other-id', 'bogus'), /kind/);
    assert.throws(() => linkMemory(db, key, '', 'other-id', 'related'), /required/);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('unlinkMemory removes an edge; second call returns false', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const a = saveMemory(db, key, { type: 'semantic', title: 'A', content: 'a' });
    const b = saveMemory(db, key, { type: 'semantic', title: 'B', content: 'b' });
    const edge = linkMemory(db, key, a.id, b.id, 'related');
    assert.equal(unlinkMemory(db, key, edge.id), true);
    assert.equal(unlinkMemory(db, key, edge.id), false, 'already removed');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('listEdges returns both directions by default; filters by direction and kind', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const a = saveMemory(db, key, { type: 'semantic', title: 'A', content: 'a' });
    const b = saveMemory(db, key, { type: 'semantic', title: 'B', content: 'b' });
    const c = saveMemory(db, key, { type: 'semantic', title: 'C', content: 'c' });
    linkMemory(db, key, a.id, b.id, 'related');
    linkMemory(db, key, c.id, a.id, 'supports');
    linkMemory(db, key, a.id, c.id, 'contradicts');

    const all = listEdges(db, key, a.id);
    assert.equal(all.length, 3, 'all three edges touching A are listed');
    const directions = all.map((e) => e.direction);
    assert.ok(directions.includes('out') && directions.includes('in'), 'both directions present');

    const out = listEdges(db, key, a.id, { direction: 'out' });
    assert.equal(out.length, 2);
    for (const e of out) assert.equal(e.direction, 'out');

    const onlySupports = listEdges(db, key, a.id, { kind: 'supports' });
    assert.equal(onlySupports.length, 1);
    assert.equal(onlySupports[0].kind, 'supports');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('mergeMemory: intoId keeps its body; fromId is soft-superseded; tags union; edge recorded', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const into = saveMemory(db, key, {
      type: 'semantic',
      title: 'tabs',
      content: 'use tabs for indent',
      tags: ['indent'],
    });
    const from = saveMemory(db, key, {
      type: 'semantic',
      title: 'tabs2',
      content: 'use tabs for indent',
      tags: ['formatting', 'indent'],
    });

    const r = mergeMemory(db, key, into.id, from.id);
    assert.equal(r.into.id, into.id);
    // Tags unioned (case-insensitive dedup).
    assert.deepEqual(r.into.tags.sort(), ['formatting', 'indent'].sort());
    // fromId is soft-superseded and points back.
    const afterFrom = getMemory(db, key, from.id, { includeSuperseded: true });
    assert.equal(afterFrom.status, 'superseded');
    assert.equal(afterFrom.superseded_by, into.id);
    // Default behaviour: intoId content unchanged.
    assert.equal(r.into.content, 'use tabs for indent');
    // Provenance carries a merge_from entry.
    assert.ok(Array.isArray(r.into.provenance.merged_from));
    assert.equal(r.into.provenance.merged_from.length, 1);
    assert.equal(r.into.provenance.merged_from[0].id, from.id);
    // A supersedes edge is recorded in memory_edges.
    assert.ok(r.edge);
    assert.equal(r.edge.kind, 'supersedes');
    assert.equal(r.edge.from_id, from.id);
    assert.equal(r.edge.to_id, into.id);
    // fromId is no longer in FTS — recall does not surface it.
    const all = listMemories(db, key, {});
    assert.equal(all.length, 1, 'only into is in the active list');
    assert.equal(all[0].id, into.id);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('mergeMemory with merged_content replaces intoId content', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const into = saveMemory(db, key, { type: 'semantic', title: 'rule', content: 'short' });
    const from = saveMemory(db, key, { type: 'semantic', title: 'rule-dup', content: 'short' });
    const r = mergeMemory(db, key, into.id, from.id, {
      mergedContent: 'the long canonical rule, combined from both prior memories',
    });
    assert.equal(r.into.content, 'the long canonical rule, combined from both prior memories');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('mergeMemory rejects same into/from and missing memories', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const a = saveMemory(db, key, { type: 'semantic', content: 'a' });
    assert.throws(() => mergeMemory(db, key, a.id, a.id), /differ/);
    assert.throws(() => mergeMemory(db, key, a.id, 'no-such-id'), /not found/);
    assert.throws(() => mergeMemory(db, key, 'no-such-id', a.id), /not found/);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('MCP round-trip: memory_link → memory_edges → memory_unlink → memory_merge', async () => {
  const home = mkTempHome();
  const cwd = 'C:/test/edges-mcp';
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    // Initialize + tools/list so we know the new tools are declared.
    const init = await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.ok(
      init && (init.capabilities || init.serverInfo || init.protocolVersion),
      'initialize returns a result',
    );
    const toolsList = await mcp.call('tools/list', {});
    const names = new Set((toolsList.tools || []).map((t) => t.name));
    for (const expected of ['memory_link', 'memory_unlink', 'memory_edges', 'memory_merge']) {
      assert.ok(names.has(expected), `tool ${expected} is declared`);
    }

    // Save two memories via the MCP tools.
    const saveA = await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 'A',
      content: 'apple',
      tags: ['fruit'],
    });
    const saveB = await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 'B',
      content: 'apricot',
      tags: ['fruit', 'orange'],
    });
    const idA = JSON.parse(saveA.content[0].text).memory.id;
    const idB = JSON.parse(saveB.content[0].text).memory.id;

    // memory_link
    const link = await mcp.toolCall('memory_link', {
      cwd,
      from_id: idA,
      to_id: idB,
      kind: 'related',
    });
    const linkPayload = JSON.parse(link.content[0].text);
    assert.equal(linkPayload.operation, 'linked');
    assert.equal(linkPayload.edge.kind, 'related');
    const edgeId = linkPayload.edge.id;

    // memory_edges (list)
    const list = await mcp.toolCall('memory_edges', { cwd, id: idA });
    const listPayload = JSON.parse(list.content[0].text);
    assert.equal(listPayload.operation, 'edges');
    assert.equal(listPayload.items.length, 1);
    assert.equal(listPayload.items[0].id, edgeId);

    // memory_unlink
    const unlink = await mcp.toolCall('memory_unlink', { cwd, edge_id: edgeId });
    const unlinkPayload = JSON.parse(unlink.content[0].text);
    assert.equal(unlinkPayload.operation, 'unlinked');
    assert.equal(unlinkPayload.removed, true);

    // memory_merge
    const merge = await mcp.toolCall('memory_merge', { cwd, into_id: idA, from_id: idB });
    const mergePayload = JSON.parse(merge.content[0].text);
    assert.equal(mergePayload.operation, 'merged');
    assert.equal(mergePayload.into.id, idA);
    assert.equal(mergePayload.from.status, 'superseded');
    // Tags are unioned on the merged into-memory.
    assert.deepEqual(mergePayload.into.tags.sort(), ['fruit', 'orange'].sort());
    // A supersedes edge is recorded.
    assert.ok(mergePayload.edge);
    assert.equal(mergePayload.edge.kind, 'supersedes');

    // memory_edges for A now lists the supersedes edge.
    const list2 = await mcp.toolCall('memory_edges', { cwd, id: idA });
    const list2Payload = JSON.parse(list2.content[0].text);
    assert.ok(
      list2Payload.items.some((e) => e.kind === 'supersedes'),
      'supersedes edge appears on A',
    );
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('memory_parents honors project|global|all scope (regression: was project-only)', async () => {
  const home = mkTempHome();
  const cwd = 'C:/test/parents-scope';
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    // Two project children + a project conclusion that synthesizes
    // them. The default (no scope) → 'all'; project → 2 children;
    // global → 0 (the conclusion lives in project scope).
    const saveA = await mcp.toolCall('memory_save', {
      cwd,
      scope: 'project',
      type: 'episodic',
      title: 'project child A',
      content: 'p-a',
    });
    const saveB = await mcp.toolCall('memory_save', {
      cwd,
      scope: 'project',
      type: 'episodic',
      title: 'project child B',
      content: 'p-b',
    });
    const idA = JSON.parse(saveA.content[0].text).memory.id;
    const idB = JSON.parse(saveB.content[0].text).memory.id;

    const saveConc = await mcp.toolCall('memory_save', {
      cwd,
      scope: 'project',
      type: 'conclusion',
      title: 'project synthesis',
      content: 'two project kids',
      synthesizes: [idA, idB],
    });
    const concId = JSON.parse(saveConc.content[0].text).memory.id;

    // Now a global conclusion that synthesizes one global child.
    const saveG = await mcp.toolCall('memory_save', {
      cwd,
      scope: 'global',
      type: 'episodic',
      title: 'global child G',
      content: 'g',
    });
    const idG = JSON.parse(saveG.content[0].text).memory.id;
    const saveGConc = await mcp.toolCall('memory_save', {
      cwd,
      scope: 'global',
      type: 'conclusion',
      title: 'global synthesis',
      content: 'one global kid',
      synthesizes: [idG],
    });
    const gConcId = JSON.parse(saveGConc.content[0].text).memory.id;

    // Default (no scope arg → reads default to 'all'): every child
    // across both scopes comes back. The project conclusion's edges
    // are project-scoped; the global conclusion's edges are global-
    // scoped. Cross-DB synthesis is not supported by the schema, so
    // the project conclusion yields 2 children, the global yields 1.
    const projAllDefault = await mcp.toolCall('memory_parents', { cwd, id: concId });
    const projDefaultPayload = JSON.parse(projAllDefault.content[0].text);
    assert.equal(projDefaultPayload.scope, 'all');
    // Only the project conclusion's children come back; the global
    // conclusion's edge points into the _global DB and never crosses
    // over.
    assert.deepEqual(projDefaultPayload.items.map((m) => m.id).sort(), [idA, idB].sort());
    assert.ok(projDefaultPayload.items.every((m) => m.scope === 'project'));
    // Project scope narrows to the two project children.
    const projOnly = await mcp.toolCall('memory_parents', {
      cwd,
      id: concId,
      scope: 'project',
    });
    const projPayload = JSON.parse(projOnly.content[0].text);
    assert.equal(projPayload.scope, 'project');
    assert.deepEqual(projPayload.items.map((m) => m.id).sort(), [idA, idB].sort());
    assert.ok(projPayload.items.every((m) => m.scope === 'project'));
    // Global scope on the project conclusion yields nothing: the
    // conclusion lives in the project DB and never appears in _global.
    const projGlobal = await mcp.toolCall('memory_parents', {
      cwd,
      id: concId,
      scope: 'global',
    });
    const projGlobalPayload = JSON.parse(projGlobal.content[0].text);
    assert.equal(projGlobalPayload.scope, 'global');
    assert.equal(projGlobalPayload.count, 0);
    // The global conclusion: scope=global yields its single child.
    const globalOnly = await mcp.toolCall('memory_parents', {
      cwd,
      id: gConcId,
      scope: 'global',
    });
    const globalPayload = JSON.parse(globalOnly.content[0].text);
    assert.equal(globalPayload.scope, 'global');
    assert.deepEqual(
      globalPayload.items.map((m) => m.id),
      [idG],
    );
    assert.ok(globalPayload.items.every((m) => m.scope === 'global'));
    // Default on the global conclusion yields the global child only.
    const globalAllDefault = await mcp.toolCall('memory_parents', { cwd, id: gConcId });
    const globalDefaultPayload = JSON.parse(globalAllDefault.content[0].text);
    assert.equal(globalDefaultPayload.scope, 'all');
    assert.deepEqual(globalDefaultPayload.items.map((m) => m.id).sort(), [idG]);
    // Project scope on the global conclusion yields nothing.
    const globalProjOnly = await mcp.toolCall('memory_parents', {
      cwd,
      id: gConcId,
      scope: 'project',
    });
    const globalProjPayload = JSON.parse(globalProjOnly.content[0].text);
    assert.equal(globalProjPayload.scope, 'project');
    assert.equal(globalProjPayload.count, 0);
    // No scope=all merge expected: cross-DB synthesis is not
    // supported, so the global conclusion's edges never reach into
    // the project DB and vice versa. The scope-routing behaviour is
  } finally {
    mcp.stop();
    rmRf(home);
  }
});
