// Regression tests for three defects fixed together:
//
//   DEFECT 1 — PreCompact / Interrupt / StopFailure ran the billable
//   auto-extract pass inside a 4 s dispatcher ceiling (5 s manifest
//   budget) while the pass itself is bounded by 2 x LLM_TIMEOUT_MS
//   (4 s) + one 1 s backoff ≈ 9 s. The timer killed the process
//   mid-fetch: the provider kept billing an abandoned request, and
//   the ingest-state write, work-log, session-focus and Dream enqueue
//   that follow the extract in handleStop never ran. Those three
//   events must therefore skip the extract and still do every local
//   step. Stop / SessionEnd keep the extract.
//
//   DEFECT 2 — the system-reminder stripper used `[^>]*` before the
//   literal `>`; with no `>` in the input it consumed to
//   end-of-string and backtracked at every occurrence: O(n²) over
//   wire content read from an arbitrary file.
//
//   DEFECT 3 — KIMI_MEMORY_PROXY_DENY_TOOLS was read after the
//   loopback early-return, so on the documented default bind
//   (127.0.0.1) the operator deny-list silently enforced nothing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mkTempHome, rmRf, writeJsonl, pluginRoot } from './_helpers.js';

const ROOT = pluginRoot();
const CWD = 'C:/example/proj-63';

// `HOME` in src/hooks/handlers/lib/constants.js is captured once, at
// module load, from KIMI_CODE_HOME — so the temp home has to be in
// place before the handler module is imported.
const HOME = mkTempHome('pm-63-');
process.env.KIMI_CODE_HOME = HOME;
after(() => rmRf(HOME));

const { handleStop, handleSessionEnd, handlePreCompact, handleInterrupt, handleStopFailure } =
  await import('../src/hooks/handlers/stop.js');
const { extractSummary } = await import('../src/wire.js');
const { nonLoopbackToolGuard } = await import('../src/proxy/server.js');

// ---- Fixtures ----------------------------------------------------------

// Insertion-ordered so session_index.jsonl always carries every session
// seeded so far; the Stop handler consults the index when the ingest
// state has no work-dir key on file yet.
const seeded = [];
const WORK_KEY = 'wk-63';

function seedSession(sessionId, events = 2) {
  if (seeded.includes(sessionId)) return sessionId;
  seeded.push(sessionId);
  const createdAt = new Date(Date.now() - 1000).toISOString();
  writeJsonl(
    path.join(HOME, 'sessions', WORK_KEY, sessionId, 'wire.jsonl'),
    Array.from({ length: events }, (_, i) => ({
      type: 'context.append_message',
      message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` },
      created_at: createdAt,
    })),
  );
  writeJsonl(
    path.join(HOME, 'session_index.jsonl'),
    seeded.map((id) => ({ sessionId: id, workDirKey: WORK_KEY })),
  );
  return sessionId;
}

// ---- DEFECT 1: hook budget --------------------------------------------

// The three short-budget events run the handler on a 4 s dispatcher
// ceiling. Reading the numbers from source (rather than hard-coding
// them) keeps this honest if the budgets are ever retuned.
function dispatcherTimeouts() {
  const src = readFileSync(path.join(ROOT, 'src/hooks/run.js'), 'utf8');
  const block = src.match(/HOOK_TIMEOUTS_MS\s*=\s*\{([\s\S]*?)\}/);
  assert.ok(block, 'src/hooks/run.js must define HOOK_TIMEOUTS_MS');
  const out = {};
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*(\w+):\s*(\d+)/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function manifestTimeouts() {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'kimi.plugin.json'), 'utf8'));
  const out = {};
  for (const hook of manifest.hooks || []) out[hook.event] = hook.timeout * 1000;
  return out;
}

function extractWorstCaseMs() {
  const src = readFileSync(path.join(ROOT, 'src/extract.js'), 'utf8');
  const m = src.match(/const LLM_TIMEOUT_MS = (\d+)/);
  assert.ok(m, 'src/extract.js must define LLM_TIMEOUT_MS');
  // withLlmRetry(..., { maxAttempts: 2, baseDelayMs: 1000 }): two calls
  // plus one capped backoff.
  return 2 * Number(m[1]) + 1000;
}

test('the short-budget hook events cannot afford the extract pass', () => {
  const dispatcher = dispatcherTimeouts();
  const manifest = manifestTimeouts();
  const worstCase = extractWorstCaseMs();
  for (const event of ['PreCompact', 'Interrupt', 'StopFailure']) {
    assert.ok(
      manifest[event] < worstCase,
      `${event}: manifest budget ${manifest[event]}ms is below the ${worstCase}ms ` +
        `worst-case extract, so the runtime kills the pass mid-fetch`,
    );
    assert.ok(
      dispatcher[event] < manifest[event],
      `${event}: dispatcher ${dispatcher[event]}ms must stay under the manifest budget`,
    );
  }
  // Stop / SessionEnd are the events with room for the extract.
  for (const event of ['Stop', 'SessionEnd']) {
    assert.ok(
      manifest[event] >= worstCase,
      `${event} keeps the extract; its budget must accommodate it`,
    );
  }
});

test('handlePreCompact skips the extract pass but still does the local work', async () => {
  const sessionId = seedSession('s-63-precompact');
  const { snapshot } = await handlePreCompact({ cwd: CWD, session_id: sessionId });
  // The snapshot shape is part of the handler's contract.
  assert.deepEqual(
    Object.keys(snapshot).sort(),
    ['dream', 'extract', 'focus', 'ingest', 'ok', 'workLog'],
    'the returned snapshot shape must not change',
  );
  assert.ok(snapshot.ok, 'ingest reports ok');
  assert.ok(snapshot.ingest.ingested >= 1, 'the local ingest pass still runs');
  // The extract pass is the only step the short-budget events drop. A
  // non-null `extract` means handleAutoExtract was entered — the pass
  // that reaches runAutoExtract -> withLlmRetry -> the provider.
  assert.equal(
    snapshot.extract,
    null,
    'PreCompact must not enter the extract pass (4s ceiling vs ~9s worst case)',
  );
});

for (const [name, handler] of [
  ['handleInterrupt', handleInterrupt],
  ['handleStopFailure', handleStopFailure],
]) {
  test(`${name} skips the extract pass but still does the local work`, async () => {
    const sessionId = seedSession(`s-63-${name.toLowerCase()}`);
    const { ok, snapshot } = await handler({ cwd: CWD, session_id: sessionId });
    assert.equal(ok, true);
    assert.ok(snapshot.ingest.ingested >= 1, 'the local ingest pass still runs');
    assert.equal(snapshot.extract, null, `${name} must not enter the extract pass`);
  });
}

test('handleStop and handleSessionEnd keep the extract pass', async () => {
  // The contrast that makes the two tests above meaningful: the very
  // same payload reaches the extract stage through Stop / SessionEnd,
  // so a null `extract` on the short-budget events is the option doing
  // the work — not an ingest skip or a missing archive.
  const sessionId = seedSession('s-63-stop', 2);
  const stop = await handleStop({ cwd: CWD, session_id: sessionId });
  assert.ok(
    stop.extract && typeof stop.extract.skipped === 'string',
    'Stop still enters the extract pass',
  );
  const endSession = seedSession('s-63-sessionend', 2);
  const sessionEnd = await handleSessionEnd({ cwd: CWD, session_id: endSession });
  assert.ok(
    sessionEnd.extract && typeof sessionEnd.extract.skipped === 'string',
    'SessionEnd still enters the extract pass',
  );
});

// ---- DEFECT 2: system-reminder stripper --------------------------------

// The pathological shape is repeated `<system-reminder` with no `>`
// anywhere: the old `[^>]*>` consumed to end-of-string and backtracked
// at every occurrence.
function stripMs(bytes) {
  const unit = '<system-reminder';
  const text = unit.repeat(Math.ceil(bytes / unit.length)) + ' tail';
  const t0 = performance.now();
  extractSummary({ type: 'turn.prompt', input: text });
  return performance.now() - t0;
}

test('system-reminder stripping stays linear on pathological input', () => {
  const t64 = stripMs(64 * 1024);
  const t128 = stripMs(128 * 1024);
  const t256 = stripMs(256 * 1024);
  console.log(
    `[63] system-reminder strip: 64KiB=${t64.toFixed(1)}ms ` +
      `128KiB=${t128.toFixed(1)}ms 256KiB=${t256.toFixed(1)}ms`,
  );
  // Measured on this machine: pre-fix 164ms / 762ms / 3259ms, post-fix
  // 63ms / 129ms / 232ms (up to ~410ms for the 256 KiB case when the
  // whole suite runs its files in parallel). The ceiling is deliberately
  // loose so a slow or loaded runner does not flake — the pre-fix shape
  // misses it by more than 2x — and the growth check below is the
  // primary discriminator.
  assert.ok(t256 < 1500, `256KiB path must not take ${t256.toFixed(1)}ms (was ~3.3s)`);
  // 4x the input: linear ~4x, quadratic ~16x. The 5ms floor keeps a
  // sub-millisecond measurement from producing a nonsense ratio.
  const growth = t256 / Math.max(t64, 5);
  assert.ok(growth < 8, `4x input grew strip time ${growth.toFixed(1)}x (quadratic is ~16x)`);
});

test('well-formed and fragment system-reminder blocks are still stripped', () => {
  assert.equal(
    extractSummary({
      type: 'turn.prompt',
      input: 'hello <system-reminder>noise</system-reminder> world',
    }),
    'hello  world',
    'an inline block is removed, the user text around it is kept',
  );
  assert.equal(
    extractSummary({
      type: 'turn.prompt',
      input: 'a\n<system-reminder count="2">\nlong\nbody\n</system-reminder>\nb',
    }),
    'a\n\nb',
    'a multi-line block with attributes is removed',
  );
  assert.equal(
    extractSummary({
      type: 'turn.prompt',
      input: '<system-reminder>a > b</system-reminder>kept',
    }),
    'kept',
    'a `>` inside the block body does not split the match',
  );
  assert.equal(
    extractSummary({
      type: 'turn.prompt',
      input: 'keep <system-reminder foo="bar"> dropped to end',
    }),
    'keep',
    'an unclosed fragment with a `>` still strips to end-of-string',
  );
});

// ---- DEFECT 3: proxy deny-list on the default bind ---------------------

function withDeny(value, fn) {
  const prev = process.env.KIMI_MEMORY_PROXY_DENY_TOOLS;
  try {
    if (value === undefined) delete process.env.KIMI_MEMORY_PROXY_DENY_TOOLS;
    else process.env.KIMI_MEMORY_PROXY_DENY_TOOLS = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KIMI_MEMORY_PROXY_DENY_TOOLS;
    else process.env.KIMI_MEMORY_PROXY_DENY_TOOLS = prev;
  }
}

function withAllow(value, fn) {
  const prev = process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS;
  try {
    if (value === undefined) delete process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS;
    else process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS;
    else process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS = prev;
  }
}

test('nonLoopbackToolGuard: the deny-list enforces on a loopback bind', () => {
  // AGENTS.md, `## Environment variables` → HTTP proxy:
  //   `KIMI_MEMORY_PROXY_DENY_TOOLS` | unset | "Comma-separated
  //   deny-list. Wins over the allow-list."
  // No loopback carve-out — and the proxy is documented to default to
  // 127.0.0.1, so a carve-out would make the control dead on the
  // default configuration.
  withDeny('memory_delete', () => {
    const err = nonLoopbackToolGuard('memory_delete', { host: '127.0.0.1' });
    assert.ok(err, 'the deny-list must apply on the default loopback bind');
    assert.ok(err.includes('KIMI_MEMORY_PROXY_DENY_TOOLS'));
    // Everything not denied is untouched on loopback: the destructive
    // default-deny stays a non-loopback rule.
    assert.equal(nonLoopbackToolGuard('memory_recall', { host: '127.0.0.1' }), null);
    assert.equal(nonLoopbackToolGuard('memory_reset_project', { host: '127.0.0.1' }), null);
    for (const host of ['::1', 'localhost', '127.0.0.2']) {
      assert.ok(
        nonLoopbackToolGuard('memory_delete', { host }),
        `deny-list must apply on loopback host ${host}`,
      );
    }
  });
});

test('nonLoopbackToolGuard: deny and allow lists match case-insensitively', () => {
  // Tool names are always lowercase; an operator typo in the env var
  // used to fail OPEN because the comparison was a raw `Array.includes`.
  withDeny('Memory_Delete', () => {
    assert.ok(
      nonLoopbackToolGuard('memory_delete', { host: '127.0.0.1' }),
      'a capitalised deny entry must still deny',
    );
    assert.ok(
      nonLoopbackToolGuard('MEMORY_DELETE', { host: '0.0.0.0' }),
      'a capitalised tool name must still be matched',
    );
  });
  withDeny(undefined, () =>
    withAllow('Memory_Reset_Project', () => {
      assert.equal(
        nonLoopbackToolGuard('memory_reset_project', { host: '0.0.0.0' }),
        null,
        'a capitalised allow entry must still allow',
      );
      assert.ok(
        nonLoopbackToolGuard('memory_delete', { host: '0.0.0.0' }),
        'tools outside the allow-list stay denied',
      );
    }),
  );
});
