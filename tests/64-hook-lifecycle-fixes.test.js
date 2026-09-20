// Regression tests for the hook-lifecycle fixes. One test per defect:
//
//   1. safeHandleStop never throws (ingest failure must not take down
//      the whole SessionStart / UserPromptSubmit event).
//   2. the hook dispatcher sets a short SQLite busy timeout so a lock
//      attempt fails fast instead of blocking the JS thread past the
//      dispatcher ceiling.
//   3. parseExtractionResponse survives a `null` element in the
//      model's JSON array instead of dropping the whole reply.
//   4. PostToolUseFailure never lazy-creates the project DB and opens
//      inside its try block.
//   5. retryFailedEmbeddings honours a total wall-clock budget.
//   6. the SessionStart dreaming pass actually runs (and is gated by
//      KIMI_MEMORY_DREAMING).
//   7. flushStream waits for pending stdout writes, bounded.
//   8. callChat detaches its abort listener in the finally.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { pluginRoot, rmRf } from './_helpers.js';

const ROOT = pluginRoot();
const TMP_HOME = mkdtempSync(path.join(tmpdir(), 'km-hookfix-'));
process.env.KIMI_CODE_HOME = TMP_HOME;
process.env.KIMI_MEMORY_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;
process.env.KIMI_MEMORY_EMBEDDINGS = 'off';

const modUrl = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const RUN_URL = modUrl('src/hooks/run.js');

const { safeHandleStop } = await import(modUrl('src/hooks/handlers/lib/stop.js'));
const { handlePostToolUseFailure } = await import(
  modUrl('src/hooks/handlers/post-tool-use-failure.js')
);
const { parseExtractionResponse, callChat } = await import(modUrl('src/extract.js'));
const { retryFailedEmbeddings } = await import(modUrl('src/hooks/embed-retry.js'));
const { deriveProjectKey, projectDbPath } = await import(modUrl('src/project-key.js'));
const { openDb, closeDb, saveMemory } = await import(modUrl('src/persist.js'));

// ---- 1. safeHandleStop containment ----

test('safeHandleStop returns a failure shape instead of throwing when ingest fails', async () => {
  const cwd = 'C:/test/hookfix-ingest-throw';
  const key = deriveProjectKey(cwd);
  const projectDir = path.join(TMP_HOME, 'kimi-memory', key);
  // A *file* where ensureProjectDir wants a directory: the very first
  // await inside the ingest throws (ENOTDIR / EEXIST), which is the
  // cheapest faithful stand-in for mkdir EPERM or SQLITE_BUSY.
  mkdirSync(path.join(TMP_HOME, 'kimi-memory'), { recursive: true });
  writeFileSync(projectDir, 'not a directory');

  let result;
  await assert.doesNotReject(async () => {
    result = await safeHandleStop({ session_id: 'sess-throw' }, cwd);
  });
  // Shape the unguarded callers already understand:
  // `ingest.ok !== false` gates their follow-up work.
  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'ingest_threw');
  assert.ok(result.error, 'failure carries the error message');
  assert.equal(result.project_key, key);
});

// ---- 2. hook bus timeout ----

test('importing the hook dispatcher pins a short SQLite busy timeout', async () => {
  delete process.env.KIMI_MEMORY_BUSY_TIMEOUT_MS;
  const { HOOK_BUSY_TIMEOUT_MS } = await import(RUN_URL + '?case=default');
  assert.ok(Number.isFinite(HOOK_BUSY_TIMEOUT_MS) && HOOK_BUSY_TIMEOUT_MS <= 2000);
  assert.equal(
    process.env.KIMI_MEMORY_BUSY_TIMEOUT_MS,
    String(HOOK_BUSY_TIMEOUT_MS),
    'the hook process must send a short busy timeout to the connection layer',
  );

  // A user-provided value is capped, not honoured verbatim: the ceiling
  // is what keeps a lock wait inside the dispatcher budget.
  process.env.KIMI_MEMORY_BUSY_TIMEOUT_MS = '30000';
  await import(RUN_URL + '?case=clamp');
  assert.equal(process.env.KIMI_MEMORY_BUSY_TIMEOUT_MS, String(HOOK_BUSY_TIMEOUT_MS));

  // A shorter explicit value is respected.
  process.env.KIMI_MEMORY_BUSY_TIMEOUT_MS = '250';
  await import(RUN_URL + '?case=keep');
  assert.equal(process.env.KIMI_MEMORY_BUSY_TIMEOUT_MS, '250');
  delete process.env.KIMI_MEMORY_BUSY_TIMEOUT_MS;
});

// ---- 3. parseExtractionResponse ----

test('parseExtractionResponse keeps valid candidates next to a null element', () => {
  const out = parseExtractionResponse(
    '[null, {"type":"semantic","title":"keep me","content":"valid sibling"}, ' +
      '"not an object", 7, [[1,2]], {"type":"procedural","title":"second","content":"also valid"}]',
  );
  assert.equal(out.length, 2, 'both valid candidates survive');
  assert.deepEqual(
    out.map((c) => c.title),
    ['keep me', 'second'],
  );
  assert.equal(out[0].type, 'semantic');
  assert.equal(out[1].type, 'procedural');
});

// ---- 4. PostToolUseFailure open path ----

test('PostToolUseFailure does not lazy-create the project DB', async () => {
  const cwd = 'C:/test/hookfix-no-db';
  const dbPath = projectDbPath(TMP_HOME, deriveProjectKey(cwd));
  assert.equal(existsSync(dbPath), false, 'precondition: no project DB yet');

  const result = await handlePostToolUseFailure({
    cwd,
    projectRoot: cwd,
    toolName: 'Bash',
    error: { message: 'boom' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_db');
  assert.equal(
    existsSync(dbPath),
    false,
    'observing a tool failure must not create directories, schema or migrations',
  );
});

// ---- 5. embed retry budget ----

test('retryFailedEmbeddings stops starting attempts once the budget is spent', async () => {
  const key = 'hookfix-embed-budget';
  const dbPath = projectDbPath(TMP_HOME, key);
  const db = openDb(dbPath);
  for (let i = 0; i < 7; i++) {
    saveMemory(db, key, {
      type: 'semantic',
      title: `row ${i}`,
      content: `body ${i} mentions release and tests`,
    });
  }
  // Make every row a retry candidate: old + carrying a prior failure.
  db.prepare(
    "UPDATE memories SET updated_at = '2020-01-01T00:00:00Z', last_embed_error = 'prior failure' WHERE project_key = ?",
  ).run(key);

  const spent = await retryFailedEmbeddings(db, key, { budgetMs: 0 });
  assert.equal(spent.scanned, 5, 'row cap preserved');
  assert.equal(spent.attempted, 0, 'not one attempt started with an empty budget');
  assert.equal(spent.failed, 0);
  assert.equal(spent.budget_exhausted, true);
  const stamped = db
    .prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key = ? AND embedded_at IS NOT NULL')
    .get(key).n;
  assert.equal(stamped, 0, 'untouched rows keep their previous state');

  // With room in the budget the pass still walks the capped row set.
  const room = await retryFailedEmbeddings(db, key, { budgetMs: 60000 });
  assert.equal(room.scanned, 5);
  assert.equal(room.attempted, 5);
  assert.equal(room.failed, 5, 'embeddings are off, so every attempt records a failure');
  assert.equal(room.budget_exhausted, false);
  closeDb();
});

// ---- 6. SessionStart dreaming pass ----

function spawnSessionStart({ home, cwd, envExtra = {} }) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-start.js')], {
    cwd: ROOT,
    env: { ...process.env, KIMI_CODE_HOME: home, NO_COLOR: '1', ...envExtra },
    input: JSON.stringify({ cwd, session_id: 's-hookfix' }),
    encoding: 'utf8',
    timeout: 20000,
  });
  return r;
}

test('SessionStart runs the wall-clock-gated dreaming pass, gated by KIMI_MEMORY_DREAMING', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'km-hookfix-dream-'));
  try {
    const cwd = 'C:/test/hookfix-dreaming';
    const key = deriveProjectKey(cwd);
    // The pass only runs for a project that already has a DB (the hook
    // never lazy-creates one).
    const db = openDb(projectDbPath(home, key));
    closeDb();

    const fired = spawnSessionStart({
      home,
      cwd,
      envExtra: { KIMI_MEMORY_DREAMING_MODE: 'on', KIMI_MEMORY_DREAMING_INTERVAL_MS: '0' },
    });
    assert.equal(fired.status, 0, 'hook must fail open');
    const statePath = path.join(home, 'kimi-memory', key, 'dreaming.json');
    assert.ok(existsSync(statePath), 'SessionStart must run the dreaming pass and record last_run');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.ok(state.last_run && state.last_run.at, 'last_run is stamped');

    // Same config, env opt-out: the pass is skipped and nothing is written.
    const offCwd = 'C:/test/hookfix-dreaming-off';
    const offKey = deriveProjectKey(offCwd);
    const offDb = openDb(projectDbPath(home, offKey));
    closeDb();
    const skipped = spawnSessionStart({
      home,
      cwd: offCwd,
      envExtra: {
        KIMI_MEMORY_DREAMING: 'off',
        KIMI_MEMORY_DREAMING_MODE: 'on',
        KIMI_MEMORY_DREAMING_INTERVAL_MS: '0',
      },
    });
    assert.equal(skipped.status, 0);
    assert.equal(
      existsSync(path.join(home, 'kimi-memory', offKey, 'dreaming.json')),
      false,
      'KIMI_MEMORY_DREAMING=off must gate the pass',
    );
  } finally {
    rmRf(home);
  }
});

// ---- 7. bounded stdout flush ----

test('flushStream waits for a pending write and stays bounded when the pipe stalls', async () => {
  const { flushStream } = await import(RUN_URL);

  // A pending write whose callback fires later must be awaited.
  let wrote = false;
  const slow = {
    writableLength: 4,
    once() {},
    write(_chunk, cb) {
      wrote = true;
      setTimeout(cb, 40);
      return true;
    },
  };
  const start = Date.now();
  await flushStream(slow, { budgetMs: 1000 });
  const waited = Date.now() - start;
  assert.equal(wrote, true, 'the flush issues an empty write to detect drain');
  assert.ok(waited >= 30, `flush waited for the callback, got ${waited}ms`);

  // A pipe that never calls the callback must not hang the hook.
  const stuck = { writableLength: 4, once() {}, write() {} };
  const stuckStart = Date.now();
  await flushStream(stuck, { budgetMs: 60 });
  const stuckWaited = Date.now() - stuckStart;
  assert.ok(stuckWaited < 1000, `flush stayed bounded, got ${stuckWaited}ms`);

  // Nothing pending → no write at all.
  const idle = {
    writableLength: 0,
    once() {},
    write() {
      throw new Error('idle stream must not be written to');
    },
  };
  await flushStream(idle, { budgetMs: 1000 });
});

// ---- 8. callChat abort listener ----

test('callChat detaches the caller abort listener after the attempt', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() =>
    callChat({
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:9',
      type: 'openai',
      model: 'test-model',
      system: 'sys',
      user: 'usr',
      signal: ac.signal,
    }),
  );
  assert.equal(
    getEventListeners(ac.signal, 'abort').length,
    0,
    'the retry loop must not accumulate listeners on the caller signal',
  );
});

after(() => rmRf(TMP_HOME));
