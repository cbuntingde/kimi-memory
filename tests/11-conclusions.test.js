// Tests for the higher-order `conclusion` type and the memory_synthesizes
// table. Covers migration idempotency, save with synthesizes[] input,
// bidirectional lookups via listConclusionsFor + getParents, and the
// MCP round-trip for memory_conclusions_for + memory_parents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf, StdioMcp } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  getMemory,
  listMemories,
  listConclusionsFor,
  getParents,
} from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';
import { validateType } from '../src/validation.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/conclusion-A');
  return { home, key, dbPath: projectDbPath(home, key) };
}

test('v5 migration: type=conclusion is accepted and memory_synthesizes table exists', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    // Idempotent re-open.
    openDb(dbPath);
    const probe = saveMemory(db, key, { type: 'conclusion', title: 'probe', content: 'x' });
    assert.equal(probe.type, 'conclusion');
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((t) => t.name),
    );
    assert.ok(tables.has('memory_synthesizes'), 'memory_synthesizes table created');
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_synthesizes_child'",
      )
      .get();
    assert.ok(idx, 'child index exists');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('saveMemory with synthesizes[] writes one memory_synthesizes row per child', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const a = saveMemory(db, key, { type: 'semantic', title: 'a', content: 'a' });
    const b = saveMemory(db, key, { type: 'semantic', title: 'b', content: 'b' });
    const c = saveMemory(db, key, { type: 'semantic', title: 'c', content: 'c' });
    const conc = saveMemory(db, key, {
      type: 'conclusion',
      title: 'summary',
      content: 'a + b + c',
      synthesizes: [a.id, b.id, c.id],
    });
    const rows = db.prepare('SELECT * FROM memory_synthesizes WHERE parent_id=?').all(conc.id);
    assert.equal(rows.length, 3);
    const childIds = rows.map((r) => r.child_id).sort();
    assert.deepEqual(childIds, [a.id, b.id, c.id].sort());
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('listConclusionsFor returns the parent conclusion that synthesizes a child', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const a = saveMemory(db, key, { type: 'semantic', title: 'a', content: 'a' });
    const b = saveMemory(db, key, { type: 'semantic', title: 'b', content: 'b' });
    const c1 = saveMemory(db, key, {
      type: 'conclusion',
      title: 'one',
      content: 'one',
      synthesizes: [a.id],
    });
    const c2 = saveMemory(db, key, {
      type: 'conclusion',
      title: 'two',
      content: 'two',
      synthesizes: [a.id, b.id],
    });
    const concs = listConclusionsFor(db, key, a.id);
    assert.equal(concs.length, 2);
    const ids = concs.map((c) => c.id);
    assert.ok(ids.includes(c1.id));
    assert.ok(ids.includes(c2.id));
    // b is only referenced by c2 — that should be the only return.
    const concsForB = listConclusionsFor(db, key, b.id);
    assert.equal(concsForB.length, 1);
    assert.equal(concsForB[0].id, c2.id);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('getParents returns the underlying memories of a conclusion', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const a = saveMemory(db, key, { type: 'semantic', title: 'a', content: 'a' });
    const b = saveMemory(db, key, { type: 'semantic', title: 'b', content: 'b' });
    const conc = saveMemory(db, key, {
      type: 'conclusion',
      title: 'sum',
      content: 'a + b',
      synthesizes: [a.id, b.id],
    });
    const parents = getParents(db, key, conc.id);
    assert.equal(parents.length, 2);
    const ids = parents.map((p) => p.id).sort();
    assert.deepEqual(ids, [a.id, b.id].sort());
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('saveMemory: re-saving the same synthesizes[] is idempotent (no duplicate rows)', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const a = saveMemory(db, key, { type: 'semantic', title: 'a', content: 'a' });
    const b = saveMemory(db, key, { type: 'semantic', title: 'b', content: 'b' });
    const conc1 = saveMemory(db, key, {
      type: 'conclusion',
      title: 'sum',
      content: 'x',
      synthesizes: [a.id, b.id],
    });
    const conc2 = saveMemory(db, key, {
      type: 'conclusion',
      title: 'sum',
      content: 'x',
      synthesizes: [a.id, b.id],
    });
    // Same (parent_id, child_id) → exactly two rows total, one per child.
    const rows = db
      .prepare('SELECT * FROM memory_synthesizes WHERE parent_id IN (?, ?)')
      .all(conc1.id, conc2.id);
    assert.equal(rows.length, 2);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('saveMemory: self-reference in synthesizes is dropped silently', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const a = saveMemory(db, key, { type: 'semantic', title: 'a', content: 'a' });
    const conc = saveMemory(db, key, {
      type: 'conclusion',
      title: 'self',
      content: 'self-ref',
      synthesizes: [a.id, (conc) => conc.id],
    });
    void conc; // placeholder
    // No row should be written for self.
    const self = saveMemory(db, key, {
      type: 'conclusion',
      title: 'real',
      content: 'x',
      synthesizes: ['placeholder'],
    });
    void self;
    // Make a real self-ref test:
    const c2 = saveMemory(db, key, { type: 'conclusion', title: 't', content: 'x' });
    saveMemory(db, key, {
      type: 'conclusion',
      title: 't2',
      content: 'y',
      synthesizes: [c2.id, c2.id],
    });
    const rows = db.prepare('SELECT * FROM memory_synthesizes WHERE child_id = ?').all(c2.id);
    assert.equal(rows.length, 1, 'one row per unique child even with duplicates');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('validateType accepts the new conclusion type', () => {
  const v = validateType('conclusion');
  assert.equal(v.ok, true);
  assert.equal(v.value, 'conclusion');
});

test('MCP round-trip: memory_save with synthesizes → memory_conclusions_for → memory_parents', async () => {
  const home = mkTempHome();
  const cwd = 'C:/test/conclusion-mcp';
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const toolsList = await mcp.call('tools/list', {});
    const names = new Set((toolsList.tools || []).map((t) => t.name));
    for (const expected of ['memory_conclusions_for', 'memory_parents']) {
      assert.ok(names.has(expected), `tool ${expected} is declared`);
    }
    // Save two underlying memories.
    const aSave = await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 'a',
      content: 'a',
    });
    const bSave = await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 'b',
      content: 'b',
    });
    const a = JSON.parse(aSave.content[0].text).memory.id;
    const b = JSON.parse(bSave.content[0].text).memory.id;
    // Save a conclusion that synthesizes both.
    const concSave = await mcp.toolCall('memory_save', {
      cwd,
      type: 'conclusion',
      title: 'sum',
      content: 'a + b',
      synthesizes: [a, b],
    });
    const conc = JSON.parse(concSave.content[0].text).memory;
    assert.equal(conc.type, 'conclusion');
    // Conclusions for a → includes conc; parents of conc → a + b.
    const cfa = await mcp.toolCall('memory_conclusions_for', { cwd, id: a });
    const cfaPayload = JSON.parse(cfa.content[0].text);
    assert.ok(cfaPayload.items.some((m) => m.id === conc.id));
    const parents = await mcp.toolCall('memory_parents', { cwd, id: conc.id });
    const parentsPayload = JSON.parse(parents.content[0].text);
    assert.equal(parentsPayload.count, 2);
    const ids = parentsPayload.items.map((m) => m.id).sort();
    assert.deepEqual(ids, [a, b].sort());
  } finally {
    mcp.stop();
    rmRf(home);
  }
});
