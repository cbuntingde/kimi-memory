// Tests for the v9 "brain" upgrades:
//
//   - Ebbinghaus decay curve (src/decay.js) — covered in 10-decay.test.js,
//     but the helpers get extra coverage here for the edge cases.
//   - Background consolidation (src/consolidate.js) — single-link cosine
//     cluster + conclusion synthesis. Idempotent.
//   - Tool-call recall (src/hooks/tool-recall.js) — extracts a query
//     from file paths + shell verbs and produces [tool-recall] lines.
//   - Diversification (run.js#diversifyHitsByType) — round-robins types
//     so the user sees a balanced recall, not three rows of the same
//     type.
//
// We don't hit the embedding model — tests stub the encode/decode pair
// so the cluster math is deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf } from './_helpers.js';
import { openDb, closeDb, saveMemory, linkMemory } from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';
import { runConsolidate } from '../src/consolidate.js';
import { extractQueryFromToolArgs, runToolRecall } from '../src/hooks/tool-recall.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/brain-A');
  return { home, key, dbPath: projectDbPath(home, key) };
}

// Stubbed embedding encoder/decoder. We assign each saved row a
// deterministic vector based on the title (so similar titles → close
// vectors) and reuse a no-op decoder that simply re-reads the BLOB.
//
// The encode function writes a 4-float vector per row: [hashA, hashB,
// tagShared, titleLen]. Same title prefix → same hash → cosine ≈ 1.
// Tag overlap lifts the third coordinate; unrelated rows have low
// cosine. This gives us a tiny, fast, predictable similarity signal
// without touching Hugging Face.
function encodeStubForRow(row) {
  const title = (row.title || '').toLowerCase();
  const tags = (Array.isArray(row.tags) ? row.tags : []).map((t) => String(t).toLowerCase());
  // Two hash buckets: one for the first word, one for the rest.
  const first = title.split(/\s+/)[0] || '';
  const rest = title.split(/\s+/).slice(1).join(' ');
  let h1 = 0;
  for (let i = 0; i < first.length; i++) h1 = (h1 * 31 + first.charCodeAt(i)) >>> 0;
  let h2 = 0;
  for (let i = 0; i < rest.length; i++) h2 = (h2 * 31 + rest.charCodeAt(i)) >>> 0;
  // Shared tag count with a synthetic tag set — three hard-coded tags
  // that build/test/build-stack memories all share.
  const sharedTags = ['build', 'stack', 'project'].filter((t) => tags.includes(t)).length;
  // Length signal.
  const len = Math.min(2, title.length / 30);
  return new Float32Array([(h1 % 1000) / 1000, (h2 % 1000) / 1000, sharedTags / 3, len]);
}

function installEmbeddingStub() {
  // Monkey-patch saveMemory by injecting _embedding directly. We
  // re-use saveMemory's signature but pre-compute the embedding on
  // the input.
  const originalSave = saveMemory;
  function stubSave(db, projectKey, input) {
    const enriched = { ...input, _embedding: encodeStubForRow(input) };
    return originalSave(db, projectKey, enriched);
  }
  // Patch the memory-save path indirectly: saveMemory in persist.js
  // schedules its own microtask embed; we can't intercept that here
  // without rewriting. Instead, we write a parallel saveMemoryLocal
  // helper that writes the embedding inline so the consolidation
  // module sees it.
  async function saveWithEmbedding(db, projectKey, input) {
    const m = stubSave(db, projectKey, input);
    // Wait for the embed microtask, then overwrite with our stub.
    await new Promise((resolve) => setImmediate(resolve));
    const vec = encodeStubForRow(input);
    const blob = Buffer.from(vec.buffer);
    db.prepare(
      `UPDATE memories SET embedding=?, embedding_model=?, embedding_dim=?, embedded_at=?
       WHERE id=?`,
    ).run(blob, 'stub', vec.length, new Date().toISOString(), m.id);
    return m;
  }
  return { saveWithEmbedding };
}

// ---- consolidation ----

test('consolidate: clusters three related rows with shared tags and synthesises a conclusion', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding } = installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    // Three "build" memories with shared tags. Same first word
    // ("build") → high cosine via the stub.
    await saveWithEmbedding(db, key, {
      type: 'semantic',
      title: 'build command',
      content: 'use pnpm run build',
      tags: ['build', 'stack', 'project'],
    });
    await saveWithEmbedding(db, key, {
      type: 'procedural',
      title: 'build stack',
      content: 'package.json scripts drive the build',
      tags: ['build', 'stack', 'project'],
    });
    await saveWithEmbedding(db, key, {
      type: 'semantic',
      title: 'build dependencies',
      content: 'check for latest unless pinned',
      tags: ['build', 'stack', 'project'],
    });
    // Run consolidation with stubbed embedding decode.
    const r = await runConsolidate({
      db,
      projectKey: key,
      saveMemory,
      memoryLink: linkMemory,
      decodeEmbeddingImpl: (blob) => {
        if (!blob) return null;
        return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
      },
    });
    assert.equal(r.saved, 1, 'one conclusion synthesised');
    assert.equal(r.clusters, 1);
    // The conclusion row is present and references all three children.
    const conclusions = db
      .prepare(
        `SELECT id, type, title FROM memories WHERE project_key=? AND type='conclusion' AND status='active'`,
      )
      .all(key);
    assert.equal(conclusions.length, 1);
    assert.match(conclusions[0].title, /Synthesis/);
    // memory_synthesizes links the parent to all 3 children.
    const links = db
      .prepare(`SELECT child_id FROM memory_synthesizes WHERE project_key=? AND parent_id=?`)
      .all(key, conclusions[0].id);
    assert.equal(links.length, 3, 'three synthesizes edges');
    // memory_edges (synthesizes kind) recorded too.
    const edges = db
      .prepare(`SELECT to_id FROM memory_edges WHERE project_key=? AND kind='synthesizes'`)
      .all(key);
    assert.equal(edges.length, 3);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('consolidate: idempotent — a second pass does not create duplicates', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding } = installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    for (const title of ['x one', 'x two', 'x three']) {
      await saveWithEmbedding(db, key, {
        type: 'semantic',
        title,
        content: 'tag-share',
        tags: ['x', 'y', 'z'],
      });
    }
    const decodeStub = (blob) =>
      blob ? new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4) : null;
    const r1 = await runConsolidate({
      db,
      projectKey: key,
      saveMemory,
      memoryLink: linkMemory,
      decodeEmbeddingImpl: decodeStub,
    });
    assert.equal(r1.saved, 1);
    const r2 = await runConsolidate({
      db,
      projectKey: key,
      saveMemory,
      memoryLink: linkMemory,
      decodeEmbeddingImpl: decodeStub,
    });
    assert.equal(r2.saved, 0, 'no new conclusions on second pass');
    assert.equal(r2.skipped, 1, 'cluster is already covered');
    const conclusions = db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND type='conclusion' AND status='active'`,
      )
      .get(key);
    assert.equal(conclusions.n, 1);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('consolidate: skips clusters with fewer than 3 siblings', async () => {
  const { home, key, dbPath } = freshProject();
  const { saveWithEmbedding } = installEmbeddingStub();
  try {
    const db = openDb(dbPath);
    await saveWithEmbedding(db, key, {
      type: 'semantic',
      title: 'solo build',
      content: 'one row',
      tags: ['build', 'stack', 'project'],
    });
    const r = await runConsolidate({
      db,
      projectKey: key,
      saveMemory,
      memoryLink: linkMemory,
      decodeEmbeddingImpl: (blob) =>
        blob ? new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4) : null,
    });
    assert.equal(r.saved, 0);
    assert.equal(r.skipped, 'below_threshold');
  } finally {
    closeDb();
    rmRf(home);
  }
});

// ---- tool-recall ----

test('tool-recall: extracts paths and shell verbs from a tool-call payload', () => {
  const q = extractQueryFromToolArgs({
    file_path: 'C:/projects/foo/src/hooks/run.js',
    command: 'pnpm test',
  });
  // Extensions are stripped so FTS5 doesn't AND-join a token like
  // "js" against every segment in the path. The stem ("run") and
  // the parent directory ("hooks/run") are the high-signal tokens.
  assert.match(q, /\brun\b/);
  assert.match(q, /hooks\/run/);
  assert.match(q, /\bpnpm\b/);
});

test('tool-recall: returns no hits when no project memories match the tool args', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'semantic',
      title: 'unrelated memory',
      content: 'nothing to do with build',
      tags: ['misc'],
    });
    const r = await runToolRecall({
      projectDb: db,
      globalDb: null,
      projectKey: key,
      toolArgs: { file_path: 'C:/projects/elsewhere/notes.md' },
    });
    // Min score threshold makes low-relevance rows skip the result.
    assert.equal(r.lines.length, 0);
    assert.equal(r.hits.length, 0);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('tool-recall: surfaces a stored memory that matches the tool path', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'semantic',
      title: 'hooks run conventions',
      content: 'do not echo full memory bodies on stdout — applies to run hooks',
      tags: ['conventions'],
    });
    const r = await runToolRecall({
      projectDb: db,
      globalDb: null,
      projectKey: key,
      toolArgs: { file_path: 'C:/code/proj/src/hooks/run.js' },
    });
    // Diagnostic for failures.
    if (r.lines.length === 0) {
      const q = extractQueryFromToolArgs({ file_path: 'C:/code/proj/src/hooks/run.js' });
      throw new Error(`no tool-recall hits. query=${JSON.stringify(q)} hits=${r.hits.length}`);
    }
    assert.ok(r.lines.length > 0, 'at least one tool-recall line emitted');
    assert.match(r.lines[0], /\[tool-recall:/);
    assert.match(r.lines[0], /hooks run conventions/);
  } finally {
    closeDb();
    rmRf(home);
  }
});

// ---- diversification ----

test('diversifyHitsByType: round-robins types so the top 3 are not all one type', async () => {
  const { diversifyHitsByType } = await import('../src/hooks/run.js');
  const hits = [
    { id: 'a', type: 'semantic', score: 0.9, title: 'a' },
    { id: 'b', type: 'semantic', score: 0.85, title: 'b' },
    { id: 'c', type: 'semantic', score: 0.8, title: 'c' },
    { id: 'd', type: 'procedural', score: 0.7, title: 'd' },
    { id: 'e', type: 'working', score: 0.6, title: 'e' },
    { id: 'f', type: 'conclusion', score: 0.5, title: 'f' },
  ];
  const picked = diversifyHitsByType(hits, { topN: 3 });
  assert.equal(picked.length, 3);
  // Should include the highest-scoring row from each of 3 different
  // types (semantic, procedural, working).
  const types = new Set(picked.map((h) => h.type));
  assert.equal(types.size, 3, 'three distinct types: ' + [...types].join(','));
  assert.ok(
    picked.some((h) => h.id === 'a'),
    'top semantic included',
  );
  assert.ok(
    picked.some((h) => h.id === 'd'),
    'top procedural included',
  );
  assert.ok(
    picked.some((h) => h.id === 'e'),
    'top working included',
  );
});

test('diversifyHitsByType: returns fewer than topN when fewer types exist', async () => {
  const { diversifyHitsByType } = await import('../src/hooks/run.js');
  const hits = [
    { id: 'a', type: 'semantic', score: 0.9 },
    { id: 'b', type: 'semantic', score: 0.85 },
  ];
  const picked = diversifyHitsByType(hits, { topN: 3 });
  assert.equal(picked.length, 2, 'only two rows available');
});

test('diversifyHitsByType: empty input is a no-op', async () => {
  const { diversifyHitsByType } = await import('../src/hooks/run.js');
  assert.deepEqual(diversifyHitsByType([], { topN: 3 }), []);
  assert.deepEqual(diversifyHitsByType(null, { topN: 3 }), []);
});
