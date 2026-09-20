// Regression tests for the second-pass audit fixes that have no other
// home. Each case drives the real code path (a real DB, a real proxy
// child where the defect lived in a process-level runtime, a real embed
// call through the injected pipeline stub) rather than asserting on a
// helper in isolation.
//
//   * saveMemory wrote is_session_focus from the CALLER's metadata
//     unconditionally, so a partial update that omitted metadata reset
//     the column to 0 while the stored metadata still said
//     `{"session_focus":true}` — a self-contradicting row, and the
//     "where we left off" line disappeared from every later render.
//   * resetProject built one SQL placeholder per memory row, so a project
//     above SQLite's 32766-bound-variable ceiling could never be reset
//     (`--confirm` always threw and rolled back).
//   * auto-prune issued two safeDelete calls, i.e. two savepoints, so a
//     failure between them stranded a live memory with no FTS row —
//     invisible to MATCH recall and to codegraph matching.
//   * validateOffset accepted any finite non-negative number, so
//     `memory_list {offset: 1e30}` reached node:sqlite and failed with a
//     raw datatype-mismatch instead of returning an empty page.
//   * KIMI_MEMORY_EMBED_TIMEOUT_MS accepted values above 2^31-1, which
//     overflow Node's timer: it fires after ~1 ms, so every embed call
//     aborted instantly and recall silently degraded to FTS-only.
//   * PEM block redaction used a regex with a lazy `[\s\S]*?` body, which is
//     quadratic on a tail of unclosed BEGIN headers: 2.8 s at 512 KB, 17.7 s
//     at 2.5 MB. It is now a linear indexOf scanner.
//   * a closed stdout pipe crashed the hook dispatcher (exit 1) instead
//     of failing open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkTempHome, rmRf, pluginRoot } from './_helpers.js';
import { openDb, closeDb } from '../src/persist/connection.js';
import { saveMemory, getMemory, listMemories } from '../src/persist/memories.js';
import { resetProject } from '../src/persist/project.js';
import { runAutoPrune } from '../src/auto-gc.js';
import { validateOffset } from '../src/validation.js';
import {
  embedText,
  EMBEDDING_DIM,
  lastEmbeddingError,
  _resetForTests,
  _setPipelineStubForTests,
} from '../src/embedding.js';
import { redactSecrets, looksLikeSecret } from '../src/secrets.js';
import { parseToml } from '../src/toml.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

function freshDb(label) {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/' + label);
  return { home, key, db: openDb(projectDbPath(home, key)) };
}

function closeAll(home) {
  closeDb();
  rmRf(home);
}

test('saveMemory keeps is_session_focus when a partial update omits metadata', () => {
  const { home, key, db } = freshDb('focus-partial');
  try {
    const m = saveMemory(db, key, {
      type: 'working',
      title: 'where we left off',
      content: 'focus body',
      metadata: { session_focus: true },
      _embed: false,
    });
    const row = () =>
      db
        .prepare(
          'SELECT is_session_focus AS f, metadata AS m, priority AS p FROM memories WHERE id=?',
        )
        .get(m.id);
    assert.equal(row().f, 1, 'the initial save stamps the flag');

    // The shape that used to break the row: a patch that names no metadata.
    saveMemory(db, key, { id: m.id, priority: 5 });
    const after = row();
    assert.equal(after.p, 5, 'the rest of the patch still applied');
    assert.equal(after.f, 1, 'the stored flag survives an update that omits metadata');
    assert.equal(after.m, '{"session_focus":true}', 'so the row does not contradict itself');

    // Supplying metadata is authoritative: without the flag, the column is
    // cleared (the same presence contract supersedes / expires_at use).
    saveMemory(db, key, { id: m.id, metadata: {} });
    assert.equal(row().f, 0, 'an explicit metadata replaces the stored flag');
  } finally {
    closeAll(home);
  }
});

test('resetProject succeeds on a project above SQLite 32766-bound-variable ceiling', () => {
  const { home, key, db } = freshDb('reset-ceiling');
  const N = 33000;
  try {
    const idList = (n) => Array.from({ length: n }, (_, i) => 'm' + i);
    // Single-statement seed: a 33k-row loop would dominate the suite.
    db.exec(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ${N})
       INSERT INTO memories (id, project_key, type, title, content, created_at, updated_at)
       SELECT 'm' || n, '${key}', 'semantic', 't' || n, 'c' || n,
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
       FROM seq`,
    );
    db.prepare(
      `INSERT INTO memories_fts (id, project_key, type, title, content, tags)
       SELECT id, project_key, type, title, content, tags FROM memories WHERE project_key = ?`,
    ).run(key);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, N);

    // The fixture really is past the ceiling: the shape resetProject used
    // to build (one placeholder per row) cannot even be prepared.
    const placeholders = Array.from({ length: N }, () => '?').join(',');
    assert.throws(
      () => db.prepare(`SELECT id FROM memories WHERE id IN (${placeholders})`).all(...idList(N)),
      /too many SQL variables/,
      "the fixture must exceed SQLite's bound-variable ceiling for this test to mean anything",
    );

    const summary = resetProject(db, key, { canonicalRoot: 'C:/test/reset-ceiling' });

    // The summary key set is the contract tests/60-project-wipe-fts.test.js
    // pins; the fix must not add or drop a key.
    assert.deepEqual(Object.keys(summary).sort(), [
      'conversation_events_deleted',
      'conversations_deleted',
      'memories_acl_deleted',
      'memories_deleted',
      'memory_edges_deleted',
      'memory_synthesizes_deleted',
      'persona_promotions_deleted',
      'project_key',
      'project_path_preserved',
      'skill_invocations_deleted',
      'working_memory_deleted',
    ]);
    assert.equal(summary.memories_deleted, N);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories_fts').get().n, 0, 'FTS swept too');
  } finally {
    closeAll(home);
  }
});

test('auto-prune keeps the FTS row and its memories row in one unit', () => {
  const { home, key, db } = freshDb('prune-pair');
  try {
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    const id = 'dead-row-0001';
    saveMemory(db, key, {
      id,
      type: 'semantic',
      title: 'deleted long ago',
      content: 'body',
      status: 'deleted',
      created_at: old,
      updated_at: old,
      _embed: false,
    });
    const countId = (table) =>
      db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(id).n;
    assert.equal(countId('memories'), 1);
    assert.equal(countId('memories_fts'), 1, 'pre-condition: the FTS row exists');

    // Make the second half of the pair fail. If the two deletes were still
    // separate savepoints, the FTS delete would have committed on its own
    // and left a live memory that no MATCH query can find again.
    db.exec(
      "CREATE TRIGGER block_memories_delete BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    const result = runAutoPrune(db, key, {});

    assert.equal(result.pruned_deleted, 0, 'the pair rolls back as one unit');
    assert.ok(result.error, 'the failure is reported rather than swallowed silently');
    assert.equal(countId('memories'), 1, 'the memory survives the failed prune');
    assert.equal(countId('memories_fts'), 1, 'and so does its FTS row — nothing is stranded');
  } finally {
    closeAll(home);
  }
});

test('validateOffset clamps an out-of-range offset to a value SQLite accepts', () => {
  assert.deepEqual(validateOffset(1e30), { ok: true, value: 1e9 });
  assert.deepEqual(validateOffset(-1), {
    ok: false,
    error: 'offset must be a non-negative integer',
  });
  assert.deepEqual(validateOffset(12.9), { ok: true, value: 12 });
  assert.deepEqual(validateOffset(undefined), { ok: true, value: 0 });

  const { home, key, db } = freshDb('offset-clamp');
  try {
    saveMemory(db, key, { type: 'semantic', title: 'one row', content: 'x', _embed: false });
    // The raw value is what node:sqlite refuses; the clamped one is
    // accepted and yields an empty page. (listMemories carries its own
    // clampInt as a second line of defence, so this asserts the SQLite
    // contract the validated value has to satisfy rather than a failure
    // the endpoint still produced.)
    assert.throws(
      () => db.prepare('SELECT * FROM memories LIMIT ? OFFSET ?').all(1, 1e30),
      /datatype mismatch/,
    );
    assert.deepEqual(listMemories(db, key, { offset: validateOffset(1e30).value }), []);
  } finally {
    closeAll(home);
  }
});

test('an overflowing KIMI_MEMORY_EMBED_TIMEOUT_MS is clamped, not fired at ~1ms', async () => {
  const prevTimeout = process.env.KIMI_MEMORY_EMBED_TIMEOUT_MS;
  const prevEmbeddings = process.env.KIMI_MEMORY_EMBEDDINGS;
  try {
    process.env.KIMI_MEMORY_EMBEDDINGS = 'on';
    // > 2^31-1: Node's setTimeout warns and clamps to 1 ms, so before the
    // clamp every embed call raced a 1 ms timer and lost.
    process.env.KIMI_MEMORY_EMBED_TIMEOUT_MS = '99999999999';
    _setPipelineStubForTests(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return async () => ({ data: new Float32Array(EMBEDDING_DIM).fill(0.25) });
    });
    const vec = await embedText('a short text to embed');
    assert.ok(vec, 'the encode must not be aborted by an overflowed timer');
    assert.equal(vec.length, EMBEDDING_DIM);
    assert.equal(lastEmbeddingError(), null);
  } finally {
    _resetForTests();
    if (prevTimeout === undefined) delete process.env.KIMI_MEMORY_EMBED_TIMEOUT_MS;
    else process.env.KIMI_MEMORY_EMBED_TIMEOUT_MS = prevTimeout;
    if (prevEmbeddings === undefined) delete process.env.KIMI_MEMORY_EMBEDDINGS;
    else process.env.KIMI_MEMORY_EMBEDDINGS = prevEmbeddings;
  }
});

test('PEM redaction scrubs a real key exactly and stays linear on unclosed headers', () => {
  // A realistic RSA private key block (80 lines, ~5.3 KB): the shape a user
  // actually pastes. The output must be the token and nothing else — this is
  // the exact string the regex produced before the scanner replaced it.
  const keyLines = Array.from({ length: 80 }, () => 'MIIEowIBAAKCAQEA'.repeat(4));
  const realKey = [
    '-----BEGIN RSA PRIVATE KEY-----',
    ...keyLines,
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  assert.equal(redactSecrets(realKey), '[REDACTED_PEM_BLOCK]');
  // Embedded in prose, and twice in a row: each block is one token, the
  // surrounding text survives untouched.
  assert.equal(redactSecrets(`before\n${realKey}\nafter`), 'before\n[REDACTED_PEM_BLOCK]\nafter');
  assert.equal(
    redactSecrets(`${realKey}\n${realKey}`),
    '[REDACTED_PEM_BLOCK]\n[REDACTED_PEM_BLOCK]',
  );
  // OPENSSH and PKCS#8 headers are covered by the same pass.
  assert.equal(
    redactSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----'),
    '[REDACTED_PEM_BLOCK]',
  );

  // An over-long block is not claimed as one unit (the 64 KiB cap), but the
  // header rule still detects it — so it can never be persisted through the
  // write gate. The over-detect direction is unchanged.
  const oversized = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(70000)}\n-----END RSA PRIVATE KEY-----`;
  assert.ok(!redactSecrets(oversized).includes('[REDACTED_PEM_BLOCK]'));
  assert.ok(looksLikeSecret(oversized), 'looksLikeSecret still refuses it');

  // The pathological input: a long tail of unclosed BEGIN headers, which is
  // what a key repeatedly echoed across a session looks like. The block pass
  // must not rescan the tail per header.
  //
  // Measured before the scanner (the capped lazy regex): 2.8 s at 512 KB and
  // 17.7 s at 2.5 MB — 25x the work for 5x the input, past the 14 s Stop
  // budget. Measured through redactSecrets with the scanner: ~26 ms at
  // 512 KB, ~63 ms at 1.25 MB and ~125 ms at 2.5 MB (4.9x for 5x input).
  // The budgets below are ~10x the observed values so a loaded CI box does
  // not flake, while a quadratic regression (2.8 s / 14 s) fails by a wide
  // margin.
  const header = '-----BEGIN RSA PRIVATE KEY-----\n';
  const unclosed = header.repeat(Math.floor((512 * 1024) / header.length));
  const bigger = header.repeat(Math.floor((2560 * 1024) / header.length));
  const time = (text) => {
    const start = process.hrtime.bigint();
    const out = redactSecrets(text);
    return { ms: Number(process.hrtime.bigint() - start) / 1e6, out };
  };
  const small = time(unclosed);
  const large = time(bigger);
  assert.equal(small.out, unclosed, 'no END marker means no false-positive block');
  assert.equal(large.out, bigger);
  assert.ok(small.ms < 250, `512 KB must stay well under a second (took ${small.ms}ms)`);
  assert.ok(large.ms < 750, `2.5 MB must not blow up (took ${large.ms}ms)`);

  // The detection half runs on every write, so it must not be quadratic
  // either: ~4 ms on 2.5 MB of unclosed headers.
  const detectStart = process.hrtime.bigint();
  assert.ok(looksLikeSecret(bigger));
  const detectMs = Number(process.hrtime.bigint() - detectStart) / 1e6;
  assert.ok(detectMs < 250, `looksLikeSecret must stay linear (took ${detectMs}ms)`);
});

test('the hook dispatcher survives a closed stdout pipe (fail-open, exit 0)', async () => {
  const runUrl = pathToFileURL(path.join(pluginRoot(), 'src/hooks/run.js')).href;
  // The dispatcher is only entered when KM_HOOK_EVENT is set. stdin stays
  // open, so main() never reaches a handler — this exercises module
  // evaluation (where the listeners are registered) plus the write path.
  const source = [
    'process.env.KM_HOOK_EVENT = "Stop";',
    `await import(${JSON.stringify(runUrl)});`,
    'process.stderr.write("listeners=" + process.stdout.listenerCount("error") + "," + process.stderr.listenerCount("error"));',
    'process.stdout.write("x".repeat(1000000));',
    'setTimeout(() => process.exit(0), 300);',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  // Read a little, then close our end: the child's remaining writes get
  // EPIPE, which arrives asynchronously as an 'error' event.
  child.stdout.once('data', () => {
    try {
      child.stdout.destroy();
    } catch {
      /* ignore */
    }
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (c) => resolve(c));
  });

  assert.match(stderr, /listeners=1,1/, 'module evaluation registers both stream listeners');
  assert.equal(code, 0, 'a closed stdout pipe must not turn the fail-open path into exit 1');
});

test('parseToml drops chain-walking keys (no prototype pollution)', () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  parseToml('[__proto__]\npolluted=1\n');
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
});

// The read path the flag exists for: render.js and session-focus.js read
// the row back through getMemory, so the metadata the row reports must
// still carry the focus marker after a partial save.
test('getMemory reports the session-focus row unchanged after a partial save', () => {
  const { home, key, db } = freshDb('focus-readback');
  try {
    const m = saveMemory(db, key, {
      type: 'working',
      title: 'focus readback',
      content: 'body',
      metadata: { session_focus: true },
      _embed: false,
    });
    saveMemory(db, key, { id: m.id, priority: 3 });
    const read = getMemory(db, key, m.id);
    assert.equal(read.metadata.session_focus, true);
    assert.equal(read.priority, 3);
  } finally {
    closeAll(home);
  }
});
