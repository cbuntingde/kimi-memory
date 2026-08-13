// Tests for v10 code-graph extraction + BFS query.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf, writeRaw, StdioMcp } from './_helpers.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import {
  openDb,
  closeDb,
  saveMemory,
  extractSymbolsFromText,
  extractCodeGraph,
  buildCodeGraphEdges,
  queryMemoryGraph,
} from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/codegraph');
  return { home, key, dbPath: projectDbPath(home, key) };
}

test('extractSymbolsFromText: JS function and import', () => {
  const text = `
import { foo, bar } from './mod.js';
export function myFn() { return 1; }
function helper() {}
class MyClass {}
const x = 5;
`;
  const { symbols, imports } = extractSymbolsFromText(text, '.js');
  const names = symbols.map((s) => s.name);
  assert.ok(names.includes('myFn'));
  assert.ok(names.includes('MyClass'));
  assert.ok(names.includes('x'));
  assert.equal(imports.length, 1);
  assert.equal(imports[0].module, './mod.js');
  assert.deepEqual(imports[0].symbols, ['foo', 'bar']);
});

test('extractSymbolsFromText: Python import', () => {
  const text = `from os import path, getcwd\ndef helper():\n    pass\n`;
  const { symbols, imports } = extractSymbolsFromText(text, '.py');
  assert.ok(symbols.find((s) => s.name === 'helper'));
  assert.equal(imports.length, 1);
  assert.equal(imports[0].module, 'os');
  assert.deepEqual(imports[0].symbols, ['path', 'getcwd']);
});

test('extractCodeGraph: walks a fixture tree, skips node_modules', async () => {
  const { home, key } = freshProject();
  try {
    const root = path.join(home, 'project-root');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'skip'), { recursive: true });
    writeRaw(path.join(root, 'src', 'app.js'), 'export function greet() { return 1; }');
    writeRaw(path.join(root, 'src', 'lib.js'), 'export function add(a, b) { return a + b; }');
    writeRaw(path.join(root, 'node_modules', 'skip', 'bad.js'), 'function never() {}');
    const files = await extractCodeGraph(root, { limit: 50 });
    const paths = files.map((f) => f.file).sort();
    assert.equal(paths.length, 2);
    assert.ok(paths.includes('src/app.js'));
    assert.ok(paths.includes('src/lib.js'));
    assert.ok(!paths.some((p) => p.includes('node_modules')));
  } finally {
    rmRf(home);
  }
});

test('buildCodeGraphEdges: dry-run counts without inserting', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const root = path.join(home, 'project-root');
    await fs.mkdir(root, { recursive: true });
    writeRaw(path.join(root, 'app.js'), 'export function greet() { return 1; }');
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', title: 'greet module', content: 'greeting function' });
    saveMemory(db, key, { type: 'semantic', title: 'greet service', content: 'greeting flow' });
    const files = await extractCodeGraph(root, { limit: 50 });
    const result = buildCodeGraphEdges(db, key, files, { apply: false, kind: 'calls' });
    assert.equal(result.inserted, 0, 'dry run must not insert');
    assert.ok(
      result.candidates >= 1,
      'should have at least one candidate (one symbol × 2 memories)',
    );
    const edges = db.prepare('SELECT * FROM memory_edges').all();
    assert.equal(edges.length, 0, 'no edges were committed');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('buildCodeGraphEdges: apply=true persists edges with metadata', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const root = path.join(home, 'project-root');
    await fs.mkdir(root, { recursive: true });
    writeRaw(path.join(root, 'app.js'), 'export function greet() { return 1; }');
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', title: 'greet function', content: 'greeting utility' });
    saveMemory(db, key, { type: 'semantic', title: 'greet handler', content: 'greeting endpoint' });
    const files = await extractCodeGraph(root, { limit: 50 });
    const result = buildCodeGraphEdges(db, key, files, { apply: true, kind: 'calls' });
    assert.ok(result.inserted >= 1);
    const edges = db.prepare('SELECT * FROM memory_edges WHERE kind = ?').all('calls');
    assert.ok(edges.length >= 1);
    const md = JSON.parse(edges[0].metadata);
    assert.equal(typeof md.file, 'string');
    assert.ok(typeof md.lang === 'string');
    assert.ok(typeof md.range === 'number');
    // Self-loops are not created (linkMemory would reject anyway).
    assert.ok(edges.every((e) => e.from_id !== e.to_id));
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('buildCodeGraphEdges: single matching memory → no edge (need ≥2 to pair)', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const root = path.join(home, 'project-root');
    await fs.mkdir(root, { recursive: true });
    writeRaw(path.join(root, 'app.js'), 'export function greet() { return 1; }');
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', title: 'greet only', content: 'lonely memory' });
    const files = await extractCodeGraph(root, { limit: 50 });
    const result = buildCodeGraphEdges(db, key, files, { apply: true, kind: 'calls' });
    assert.equal(result.inserted, 0, 'no edges when only one memory matches');
    assert.equal(result.candidates, 0, 'no candidates either');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('queryMemoryGraph: BFS honors max_depth and kind filter', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const a = saveMemory(db, key, { type: 'semantic', title: 'A', content: 'a' });
    const b = saveMemory(db, key, { type: 'semantic', title: 'B', content: 'b' });
    const c = saveMemory(db, key, { type: 'semantic', title: 'C', content: 'c' });
    // A -> B via 'calls'
    db.prepare(
      `INSERT INTO memory_edges (id, project_key, from_id, to_id, kind, weight, metadata, created_at)
       VALUES ('edge-ab', ?, ?, ?, 'calls', 1.0, '{}', '2026-01-01T00:00:00Z')`,
    ).run(key, a.id, b.id);
    // B -> C via 'related'
    db.prepare(
      `INSERT INTO memory_edges (id, project_key, from_id, to_id, kind, weight, metadata, created_at)
       VALUES ('edge-bc', ?, ?, ?, 'related', 1.0, '{}', '2026-01-01T00:00:00Z')`,
    ).run(key, b.id, c.id);
    const out1 = queryMemoryGraph(db, key, a.id, { kind: 'calls', max_depth: 5 });
    assert.ok(out1.nodes.length >= 2, 'A + B reachable via calls');
    assert.ok(out1.nodes.some((n) => n.id === a.id));
    assert.ok(out1.nodes.some((n) => n.id === b.id));
    const out2 = queryMemoryGraph(db, key, a.id, { kind: 'calls', max_depth: 0 });
    // max_depth=0 from A: only A itself.
    assert.equal(out2.nodes.length, 1);
    const out2b = queryMemoryGraph(db, key, a.id, { kind: 'calls', max_depth: 1 });
    // max_depth=1 from A: A + direct neighbor B.
    assert.equal(out2b.nodes.length, 2);
    const out3 = queryMemoryGraph(db, key, a.id, { kind: 'related', max_depth: 5 });
    assert.ok(!out3.nodes.some((n) => n.id === b.id), 'B not reachable via kind=related from A');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('codegraph_extract: refuses a root outside the project directory', async () => {
  // The path-traversal guard at src/server.js:2540-2544 (added via
  // audit finding H1 / B1-2) refuses any root that is not equal to or
  // nested under the active project root. This test exercises the
  // MCP surface to confirm the guard stays in place across refactors.
  // (Audit flag F-202.)
  const home = mkTempHome();
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-cg-cwd-'));
  const evilRoot = mkdtempSync(path.join(tmpdir(), 'km-cg-evil-'));
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const res = await mcp.toolCall('codegraph_extract', {
      cwd,
      root: evilRoot,
      limit: 10,
    });
    assert.equal(res.isError, true, 'codegraph_extract must refuse an out-of-project root');
    const text = res.content[0].text;
    assert.match(
      text,
      /codegraph_extract root must be within the project directory/,
      'error message names the path-escape guard',
    );
  } finally {
    mcp.stop();
    closeDb();
    rmRf(home);
    rmRf(cwd);
    rmRf(evilRoot);
  }
});

test('codegraph_extract: accepts the project root itself', async () => {
  // The path-escape guard allows the active project root equal to the
  // boundary — `root === projectRoot` must not be misclassified as an
  // escape. (Audit flag F-202.)
  const home = mkTempHome();
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-cg-self-'));
  writeRaw(path.join(cwd, 'index.js'), "export function hello() { return 'world'; }\n");
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const res = await mcp.toolCall('codegraph_extract', { cwd, limit: 10 });
    assert.equal(res.isError, undefined, 'codegraph_extract on the project root succeeds');
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.operation, 'codegraph_extract');
    assert.equal(payload.root, path.resolve(cwd));
    assert.ok(payload.files.length >= 1, 'picks up the index.js we wrote');
  } finally {
    mcp.stop();
    closeDb();
    rmRf(home);
    rmRf(cwd);
  }
});
