// Tests for v10 lazy tool loading: buildToolRegistry, filterToolRegistry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolRegistry, filterToolRegistry } from '../src/persist.js';

const FAKE_DEFS = [
  { name: 'memory_save', desc: 'Persist a memory entry', input: { type: 'object' } },
  { name: 'memory_recall', desc: 'Search memories by query', input: { type: 'object' } },
  { name: 'memory_status', desc: 'Combined project + global summary', input: { type: 'object' } },
  {
    name: 'memory_share',
    desc: 'v10: promote a memory to a new visibility',
    input: { type: 'object' },
  },
  {
    name: 'memory_graph_build',
    desc: 'v10: scan source tree and create code-graph edges',
    input: { type: 'object' },
  },
  { name: 'memory_tools_list', desc: 'v10: list tools by name', input: { type: 'object' } },
];

test('buildToolRegistry: returns Map<name, {name, desc, inputSchema}>', () => {
  const reg = buildToolRegistry(FAKE_DEFS);
  assert.ok(reg instanceof Map);
  assert.equal(reg.size, FAKE_DEFS.length);
  const mem = reg.get('memory_save');
  assert.equal(mem.name, 'memory_save');
  assert.match(mem.desc, /Persist/);
  assert.ok(mem.inputSchema);
});

test('buildToolRegistry: ignores entries without a name', () => {
  const reg = buildToolRegistry([{ desc: 'orphan' }, null, { name: 'real', desc: 'r' }]);
  assert.equal(reg.size, 1);
  assert.ok(reg.has('real'));
});

test('filterToolRegistry: returns lightweight entries (name + desc only)', () => {
  const reg = buildToolRegistry(FAKE_DEFS);
  const filtered = filterToolRegistry(reg, '');
  assert.ok(Array.isArray(filtered));
  assert.equal(filtered.length, FAKE_DEFS.length);
  // No inputSchema leaked.
  for (const e of filtered) {
    assert.equal(typeof e.name, 'string');
    assert.equal(typeof e.desc, 'string');
    assert.equal(e.inputSchema, undefined);
  }
});

test('filterToolRegistry: query matches tool name or desc, case-insensitive', () => {
  const reg = buildToolRegistry(FAKE_DEFS);
  const byName = filterToolRegistry(reg, 'memory_share');
  assert.equal(byName.length, 1);
  assert.equal(byName[0].name, 'memory_share');
  const byDesc = filterToolRegistry(reg, 'graph');
  assert.ok(byDesc.length >= 1);
  assert.ok(byDesc.some((e) => e.name === 'memory_graph_build'));
  const byDescUpper = filterToolRegistry(reg, 'VISIBILITY');
  assert.ok(byDescUpper.length >= 1);
  assert.equal(byDescUpper[0].name, 'memory_share');
});

test('filterToolRegistry: caps at 100 entries', () => {
  const big = [];
  for (let i = 0; i < 250; i++) big.push({ name: `t${i}`, desc: 'desc', input: {} });
  const reg = buildToolRegistry(big);
  const out = filterToolRegistry(reg, '');
  assert.equal(out.length, 100);
});
