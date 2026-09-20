// Four audit findings in one file:
//
//   1. `sortBy: 'oldest' | 'recent'` (and the legacy `recentFirst`
//      boolean) must order the FINAL recall result, and `limit` must
//      select that many rows in that order. The pre-fix code re-sorted
//      the FTS candidates before they were ranked, which the later
//      score re-sort then undid, and it took only `limit` FTS rows in
//      rank order — so a time sort could neither pick the newest /
//      oldest rows nor survive a vector-channel hit.
//   2. `growStability(0)` returned STABILITY_MIN instead of
//      STABILITY_INITIAL * STABILITY_GROWTH, contradicting its own
//      docstring for any row predating the v9 backfill.
//   3. The embedding pipeline reset paths dropped the cached handle
//      without calling `dispose()`, leaking a native ONNX session per
//      failed load.
//   4. POST /shutdown tore the server down but never exited, leaving a
//      zombie process behind for a supervisor that shuts down via the
//      endpoint instead of a signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { mkTempHome, rmRf, pluginRoot, exists } from './_helpers.js';
import { openDb, closeDb, saveMemory, searchMemories } from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';
import {
  STABILITY_INITIAL,
  STABILITY_GROWTH,
  STABILITY_MAX,
  STABILITY_MIN,
  growStability,
} from '../src/decay.js';
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  embedText,
  encodeVector,
  _setPipelineStubForTests,
  _resetForTests,
} from '../src/embedding.js';

function freshProject(name) {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/' + name);
  return { home, key, dbPath: projectDbPath(home, key) };
}

// ---------------------------------------------------------------- 1. sort

// Four rows that all match the same FTS token, stamped with explicit
// `updated_at` values so the chronological order is known. The titles
// differ (two match the token, two do not), which makes the FTS ranking
// differ from the chronological order — so "the default order is score
// order" and "a time sort replaces it" are distinguishable.
const SEEDED = [
  { slot: 'A', title: 'widget alpha', at: '2024-01-01T00:00:00.000Z' },
  { slot: 'B', title: 'beta note', at: '2024-01-02T00:00:00.000Z' },
  { slot: 'C', title: 'gamma note', at: '2024-01-03T00:00:00.000Z' },
  { slot: 'D', title: 'widget delta', at: '2024-01-04T00:00:00.000Z' },
];

function seedRows(db, key) {
  const ids = {};
  for (const s of SEEDED) {
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: s.title,
      content: 'widget instrumentation for ' + s.slot,
      _embed: false,
    });
    db.prepare('UPDATE memories SET updated_at=? WHERE id=?').run(s.at, m.id);
    ids[s.slot] = m.id;
  }
  return ids;
}

function slotsOf(ids, rows) {
  const byId = new Map(Object.entries(ids).map(([slot, id]) => [id, slot]));
  return rows.map((r) => byId.get(r.id));
}

test('searchMemories: no time sort keeps the score order', async () => {
  const { home, key, dbPath } = freshProject('sort-default');
  try {
    const db = openDb(dbPath);
    const ids = seedRows(db, key);
    const rows = await searchMemories(db, key, 'widget', { limit: 10, includeScore: true });
    assert.equal(rows.length, 4, 'every seeded row is a candidate');
    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        rows[i].score <= rows[i - 1].score,
        `default order must be score-descending at index ${i} (${rows[i].score} > ${rows[i - 1].score})`,
      );
    }
    // The FTS ranking puts neither the newest nor the oldest row first,
    // so the default order is provably not one of the two time orders —
    // which is what makes the sortBy cases below meaningful.
    const slots = slotsOf(ids, rows);
    assert.notDeepEqual(slots, ['A', 'B', 'C', 'D'], 'default is not oldest-first');
    assert.notDeepEqual(slots, ['D', 'C', 'B', 'A'], 'default is not recent-first');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test("searchMemories: sortBy 'oldest' orders the final list by updated_at ASC", async () => {
  const { home, key, dbPath } = freshProject('sort-oldest');
  try {
    const db = openDb(dbPath);
    const ids = seedRows(db, key);
    const rows = await searchMemories(db, key, 'widget', {
      limit: 10,
      sortBy: 'oldest',
      includeScore: true,
    });
    assert.deepEqual(slotsOf(ids, rows), ['A', 'B', 'C', 'D']);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test("searchMemories: sortBy 'recent' orders the final list by updated_at DESC", async () => {
  const { home, key, dbPath } = freshProject('sort-recent');
  try {
    const db = openDb(dbPath);
    const ids = seedRows(db, key);
    const byScore = await searchMemories(db, key, 'widget', { limit: 10 });
    const rows = await searchMemories(db, key, 'widget', { limit: 10, sortBy: 'recent' });
    assert.deepEqual(slotsOf(ids, rows), ['D', 'C', 'B', 'A']);
    // The time order overrides the score order: the top-scored row of
    // the default ranking is not the top of the time-sorted list.
    const byScoreSlots = slotsOf(ids, byScore);
    const recentSlots = slotsOf(ids, rows);
    assert.notEqual(
      recentSlots[0],
      byScoreSlots[0],
      'the newest row must lead, even when it is not rank-1 by score',
    );
    assert.equal(
      recentSlots[recentSlots.length - 1],
      byScoreSlots[0],
      'the rank-1 row is pushed to the tail by the time sort',
    );
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('searchMemories: the recentFirst / recent_first / sort_by aliases work', async () => {
  const { home, key, dbPath } = freshProject('sort-aliases');
  try {
    const db = openDb(dbPath);
    const ids = seedRows(db, key);
    const recent = await searchMemories(db, key, 'widget', { limit: 10, recentFirst: true });
    assert.deepEqual(slotsOf(ids, recent), ['D', 'C', 'B', 'A']);
    const recentSnake = await searchMemories(db, key, 'widget', {
      limit: 10,
      recent_first: true,
    });
    assert.deepEqual(slotsOf(ids, recentSnake), ['D', 'C', 'B', 'A']);
    const oldestSnake = await searchMemories(db, key, 'widget', {
      limit: 10,
      sort_by: 'oldest',
    });
    assert.deepEqual(slotsOf(ids, oldestSnake), ['A', 'B', 'C', 'D']);
    // recentFirst: false is not a request for a time sort — score order.
    const neither = await searchMemories(db, key, 'widget', {
      limit: 10,
      recentFirst: false,
      includeScore: true,
    });
    for (let i = 1; i < neither.length; i++) {
      assert.ok(
        neither[i].score <= neither[i - 1].score,
        'recentFirst: false must leave the score order alone',
      );
    }
    const plainDefault = await searchMemories(db, key, 'widget', { limit: 10 });
    assert.deepEqual(
      neither.map((r) => r.id),
      plainDefault.map((r) => r.id),
      'recentFirst: false must match the default order exactly',
    );
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('searchMemories: a time sort selects the newest / oldest `limit` rows, not the top `limit` by score', async () => {
  const { home, key, dbPath } = freshProject('sort-limit');
  try {
    const db = openDb(dbPath);
    const ids = seedRows(db, key);
    // The two newest rows are the only ones the sort may return.
    const recent = await searchMemories(db, key, 'widget', { limit: 2, sortBy: 'recent' });
    assert.deepEqual(slotsOf(ids, recent), ['D', 'C']);
    const oldest = await searchMemories(db, key, 'widget', { limit: 2, sortBy: 'oldest' });
    assert.deepEqual(slotsOf(ids, oldest), ['A', 'B']);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('searchMemories: a time sort also applies under perType selection', async () => {
  const { home, key, dbPath } = freshProject('sort-per-type');
  try {
    const db = openDb(dbPath);
    const ids = seedRows(db, key);
    const rows = await searchMemories(db, key, 'widget', {
      limit: 10,
      perType: true,
      perTypeLimit: 4,
      sortBy: 'oldest',
    });
    assert.deepEqual(slotsOf(ids, rows), ['A', 'B', 'C', 'D']);
  } finally {
    closeDb();
    rmRf(home);
  }
});

// A unit vector along axis 0 is what the stubbed query embedding
// resolves to, so the cosine of a stored vector is simply its first
// component: `similarity(c) = c`.
function vectorWithFirstComponent(c) {
  const v = new Float32Array(EMBEDDING_DIM);
  v[0] = c;
  v[1] = Math.sqrt(Math.max(0, 1 - c * c));
  return v;
}

// Runs `fn` with the embedding model stubbed to a fixed query vector.
// The FTS-only cases above cannot distinguish a real time sort from a
// coincidence — one FTS channel whose ranks follow the pre-sort means
// the score order arrives at the same answer. Scoring a row through the
// VECTOR channel as well breaks that; that is what these cases do.
async function withStubbedQueryVector(fn) {
  const prev = process.env.KIMI_MEMORY_EMBEDDINGS;
  process.env.KIMI_MEMORY_EMBEDDINGS = 'on';
  const queryVec = vectorWithFirstComponent(1);
  _setPipelineStubForTests(() => async () => ({ data: queryVec }));
  try {
    return await fn();
  } finally {
    _resetForTests();
    if (prev === undefined) delete process.env.KIMI_MEMORY_EMBEDDINGS;
    else process.env.KIMI_MEMORY_EMBEDDINGS = prev;
  }
}

function embedRow(db, id, similarity) {
  db.prepare('UPDATE memories SET embedding=?, embedding_dim=?, embedding_model=? WHERE id=?').run(
    encodeVector(vectorWithFirstComponent(similarity)),
    EMBEDDING_DIM,
    EMBEDDING_MODEL,
    id,
  );
}

test('searchMemories: recent-first survives a vector hit on the oldest row', async () => {
  const { home, key, dbPath } = freshProject('sort-vector-recent');
  try {
    await withStubbedQueryVector(async () => {
      const db = openDb(dbPath);
      try {
        const ids = seedRows(db, key);
        // Only the OLDEST row has an embedding, and it matches the query
        // perfectly — so it wins the vector channel outright and the
        // default (score) ranking puts it first.
        embedRow(db, ids.A, 1);
        const byScore = await searchMemories(db, key, 'widget', { limit: 10 });
        assert.equal(
          slotsOf(ids, byScore)[0],
          'A',
          'sanity: the vector channel lifts the oldest row to the top of the default ranking',
        );
        const recent = await searchMemories(db, key, 'widget', { limit: 10, sortBy: 'recent' });
        assert.deepEqual(
          slotsOf(ids, recent),
          ['D', 'C', 'B', 'A'],
          'the time sort must override the score order',
        );
      } finally {
        closeDb();
      }
    });
  } finally {
    rmRf(home);
  }
});

test('searchMemories: oldest-first survives a vector hit on the newest row', async () => {
  const { home, key, dbPath } = freshProject('sort-vector-oldest');
  try {
    await withStubbedQueryVector(async () => {
      const db = openDb(dbPath);
      try {
        const ids = seedRows(db, key);
        embedRow(db, ids.D, 1);
        const byScore = await searchMemories(db, key, 'widget', { limit: 10 });
        assert.equal(
          slotsOf(ids, byScore)[0],
          'D',
          'sanity: the vector channel lifts the newest row to the top of the default ranking',
        );
        const oldest = await searchMemories(db, key, 'widget', { limit: 10, sortBy: 'oldest' });
        assert.deepEqual(
          slotsOf(ids, oldest),
          ['A', 'B', 'C', 'D'],
          'the time sort must override the score order',
        );
      } finally {
        closeDb();
      }
    });
  } finally {
    rmRf(home);
  }
});

// ------------------------------------------------------------- 2. decay

test('growStability: a non-positive / non-finite prevStability grows from STABILITY_INITIAL', () => {
  // The docstring promises the first reinforce of a freshly-saved row
  // yields STABILITY_INITIAL * STABILITY_GROWTH. A row carrying an
  // explicit 0 (a pre-v9 DB that never got the backfill) used to fall
  // through the `Number.isFinite` check and return
  // max(STABILITY_MIN, 0) = 1.
  const firstReinforce = STABILITY_INITIAL * STABILITY_GROWTH;
  assert.equal(firstReinforce, 45, 'sanity: 30 * 1.5');
  assert.equal(growStability(0), firstReinforce, 'stability_days=0 must grow from the initial');
  assert.equal(growStability(-3), firstReinforce, 'a negative stability is equally unusable');
  assert.equal(growStability(null), firstReinforce);
  assert.equal(growStability(undefined), firstReinforce);
  assert.equal(growStability(NaN), firstReinforce);
  assert.equal(growStability('30'), firstReinforce, 'a non-numeric string is not usable history');
  // Only a non-positive value is special-cased; a tiny positive one
  // still grows and is then floored at STABILITY_MIN.
  assert.equal(growStability(0.001), STABILITY_MIN);
  assert.equal(growStability(STABILITY_MAX), STABILITY_MAX);
  assert.equal(growStability(300), STABILITY_MAX, 'capped at the hard ceiling');
});

// --------------------------------------------------------- 3. embedding

// A pipe is any callable with an optional `dispose()`. The handles are
// built explicitly so a missing `dispose` (transformers.js before the
// method existed) can be exercised too.
test('embedding: the real-failure reset disposes the previous pipeline handle', async () => {
  const prevOn = process.env.KIMI_MEMORY_EMBEDDINGS;
  const prevTimeout = process.env.KIMI_MEMORY_EMBED_TIMEOUT_MS;
  process.env.KIMI_MEMORY_EMBEDDINGS = 'on';
  process.env.KIMI_MEMORY_EMBED_TIMEOUT_MS = '5000';
  let disposals = 0;
  let calls = 0;
  const pipe = async () => {
    calls += 1;
    throw new Error('onnx session died mid-call');
  };
  pipe.dispose = () => {
    disposals += 1;
  };
  _setPipelineStubForTests(() => pipe);
  try {
    const v = await embedText('hello world');
    assert.equal(v, null, 'a runtime failure fails open');
    assert.equal(calls, 1);
    // dispose runs on the microtask queue; give it a tick.
    await new Promise((r) => setImmediate(r));
    assert.equal(disposals, 1, 'the failed load must release its ONNX session');
  } finally {
    _resetForTests();
    if (prevOn === undefined) delete process.env.KIMI_MEMORY_EMBEDDINGS;
    else process.env.KIMI_MEMORY_EMBEDDINGS = prevOn;
    if (prevTimeout === undefined) delete process.env.KIMI_MEMORY_EMBED_TIMEOUT_MS;
    else process.env.KIMI_MEMORY_EMBED_TIMEOUT_MS = prevTimeout;
  }
});

test('embedding: a timed-out load is NOT disposed (a later call may still reuse it)', async () => {
  const prevOn = process.env.KIMI_MEMORY_EMBEDDINGS;
  const prevTimeout = process.env.KIMI_MEMORY_EMBED_TIMEOUT_MS;
  process.env.KIMI_MEMORY_EMBEDDINGS = 'on';
  process.env.KIMI_MEMORY_EMBED_TIMEOUT_MS = '30';
  let disposals = 0;
  let calls = 0;
  // The handle loads fine; the CALL into it hangs, so embedRaw hits its
  // wall-clock budget. The load itself is left running by design — the
  // next embed call can ride it — so it must not be disposed here.
  const pipe = () => {
    calls += 1;
    return new Promise(() => {});
  };
  pipe.dispose = () => {
    disposals += 1;
  };
  _setPipelineStubForTests(() => pipe);
  try {
    const v = await embedText('slow');
    assert.equal(v, null, 'the budget expires and the call fails open');
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1);
    assert.equal(disposals, 0, 'the still-running load must stay cached and undisposed');
  } finally {
    _resetForTests();
    if (prevOn === undefined) delete process.env.KIMI_MEMORY_EMBEDDINGS;
    else process.env.KIMI_MEMORY_EMBEDDINGS = prevOn;
    if (prevTimeout === undefined) delete process.env.KIMI_MEMORY_EMBED_TIMEOUT_MS;
    else process.env.KIMI_MEMORY_EMBED_TIMEOUT_MS = prevTimeout;
  }
});

test('embedding: _resetForTests disposes a loaded handle and tolerates a missing dispose()', async () => {
  const prevOn = process.env.KIMI_MEMORY_EMBEDDINGS;
  process.env.KIMI_MEMORY_EMBEDDINGS = 'on';
  let disposals = 0;
  const vec = new Float32Array(EMBEDDING_DIM).fill(0.1);
  const pipe = async () => ({ data: vec });
  pipe.dispose = () => {
    disposals += 1;
  };
  _setPipelineStubForTests(() => pipe);
  try {
    const v = await embedText('hello');
    assert.ok(v && v.length === EMBEDDING_DIM, 'the stub handle is used');
    assert.equal(disposals, 0, 'a live handle is not disposed while it is cached');
    _resetForTests();
    await new Promise((r) => setImmediate(r));
    assert.equal(disposals, 1, 'the reset releases the cached handle');
    // A handle with no dispose() (an older transformers.js) must not
    // make the reset throw.
    _setPipelineStubForTests(() => async () => ({ data: vec }));
    const v2 = await embedText('hello again');
    assert.ok(v2 && v2.length === EMBEDDING_DIM);
    assert.doesNotThrow(() => _resetForTests());
  } finally {
    _resetForTests();
    if (prevOn === undefined) delete process.env.KIMI_MEMORY_EMBEDDINGS;
    else process.env.KIMI_MEMORY_EMBEDDINGS = prevOn;
  }
});

// ------------------------------------------------------------ 4. proxy

// Ask the OS for a free port, then release it. The window between the
// release and the child's bind is small and the port comes from the
// ephemeral range, so a collision is not expected in practice.
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// The child boots the proxy through the CLI subcommand — the surface a
// supervisor actually runs — and keeps one inert repeating handle
// alive afterwards. That handle models the rest of the process (the
// MCP wiring and everything it opened), and it is what makes the
// difference observable: with nothing else pending, Node exits on its
// own as soon as the listener closes, and the test would pass even
// without the explicit exit.
function shutdownProbeSource() {
  return `
import { writeFileSync } from 'node:fs';
import { cmdServeHttp } from ${JSON.stringify(
    new URL('../src/cli-cmd/serve-http.js', import.meta.url).href,
  )};
await cmdServeHttp({
  positional: [],
  flags: {
    port: process.env.PROBE_PORT,
    host: '127.0.0.1',
    'auth-token-env': 'PROBE_AUTH_TOKEN',
  },
});
setInterval(() => {}, 1000);
writeFileSync(process.env.PROBE_READY, 'ready\\n');
`;
}

test('POST /shutdown answers 200 and exits the process after the teardown', async () => {
  const home = mkTempHome('pm-proxy-shutdown-');
  const scriptPath = path.join(home, 'shutdown-probe.mjs');
  const readyPath = path.join(home, 'ready.txt');
  const port = await freePort();
  writeFileSync(scriptPath, shutdownProbeSource());
  const env = { ...process.env, KIMI_CODE_HOME: home, NO_COLOR: '1' };
  env.PROBE_PORT = String(port);
  env.PROBE_AUTH_TOKEN = 'probe-token';
  env.PROBE_READY = readyPath;
  // A bypass in the ambient environment would change the auth path under
  // test; the probe authenticates with its own token, so drop both.
  delete env.KIMI_MEMORY_PROXY_AUTH;
  delete env.KIMI_MEMORY_PROXY_TOKEN;
  const child = spawn(process.execPath, [scriptPath], {
    cwd: pluginRoot(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString('utf8');
  });
  // Collected up front so the exit-code assertion can name a crash.
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          'the probe was still alive 15s after POST /shutdown — the route closed ' +
            'the server but never exited the process\n--- stderr ---\n' +
            stderr,
        ),
      );
    }, 15000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  try {
    // Wait for the child to bind before probing it.
    const deadline = Date.now() + 10000;
    while (!exists(readyPath)) {
      if (Date.now() > deadline) {
        throw new Error('the proxy child never became ready\n--- stderr ---\n' + stderr);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: 'POST',
      headers: { authorization: 'Bearer probe-token' },
    });
    assert.equal(res.status, 200, 'the route answers before tearing down');
    assert.deepEqual(await res.json(), { ok: true });
    const exit = await exited;
    assert.equal(exit.code, 0, `expected exit code 0, got ${exit.code} (signal ${exit.signal})`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmRf(home);
  }
});

test('the exported close() tears the proxy down in-process and does NOT exit', async () => {
  const home = mkTempHome('pm-proxy-close-');
  const port = await freePort();
  const { startProxy } = await import('../src/proxy/server.js');
  const prevAuth = process.env.KIMI_MEMORY_PROXY_AUTH;
  delete process.env.KIMI_MEMORY_PROXY_AUTH;
  try {
    const proxy = await startProxy({
      host: '127.0.0.1',
      port,
      kimiHomeDir: home,
      pluginRootDir: pluginRoot(),
      authToken: 'tok',
      logger: () => {},
    });
    await proxy.close();
    // Reaching this line proves the process survived the teardown —
    // process.exit() would have killed the test runner.
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/healthz`),
      'the listener must be closed after close()',
    );
  } finally {
    if (prevAuth === undefined) delete process.env.KIMI_MEMORY_PROXY_AUTH;
    else process.env.KIMI_MEMORY_PROXY_AUTH = prevAuth;
    rmRf(home);
  }
});
