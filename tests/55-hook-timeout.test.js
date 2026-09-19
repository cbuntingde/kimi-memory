// Regression test for the per-event hook dispatcher timeout.
//
// The dispatcher enforces a hard ceiling on each hook so it can
// release SQLite handles and exit cleanly while the runtime is
// still alive. The ceiling MUST be strictly less than the manifest
// budget for that event — see kimi.plugin.json. Pin the relationship
// so a future refactor cannot silently regress the safety margin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// Read the manifest's timeout for each event by name.
function manifestTimeouts() {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'kimi.plugin.json'), 'utf8'));
  const out = {};
  for (const hook of manifest.hooks || []) {
    out[hook.event] = hook.timeout;
  }
  return out;
}

// Read the dispatcher's per-event timeout by importing run.js's
// internal HOOK_TIMEOUTS_MS. The hook dispatcher does not export
// the table, so re-derive the expected numbers from the source.
function dispatcherTimeouts() {
  const src = readFileSync(path.join(ROOT, 'src/hooks/run.js'), 'utf8');
  // Match the table literal. Format: "<Event>: <ms>," inside the
  // HOOK_TIMEOUTS_MS block.
  const match = src.match(/HOOK_TIMEOUTS_MS\s*=\s*\{([\s\S]*?)\}/);
  assert.ok(match, 'dispatcher must define HOOK_TIMEOUTS_MS');
  const out = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^\s*(\w+):\s*(\d+)/);
    if (m) out[m[1]] = parseInt(m[2], 10);
  }
  return out;
}

test('every hook in kimi.plugin.json has a dispatcher timeout', () => {
  const m = manifestTimeouts();
  const d = dispatcherTimeouts();
  for (const event of Object.keys(m)) {
    assert.ok(
      Number.isFinite(d[event]),
      `dispatcher must have a timeout for ${event}; got ${d[event]}`,
    );
  }
});

test('every dispatcher timeout is strictly less than the manifest budget', () => {
  const m = manifestTimeouts();
  const d = dispatcherTimeouts();
  for (const event of Object.keys(m)) {
    const manifestMs = m[event] * 1000;
    assert.ok(
      d[event] < manifestMs,
      `${event}: dispatcher=${d[event]}ms must be < manifest=${manifestMs}ms (cleanup must run before the runtime force-kills the process)`,
    );
  }
});

test('the safety margin between dispatcher and manifest is at least 1 second', () => {
  // 1s gives the runtime a chance to start its force-kill before the
  // dispatcher races it. Without the margin, dispatcher cleanup runs
  // against an already-dying process.
  const m = manifestTimeouts();
  const d = dispatcherTimeouts();
  for (const event of Object.keys(m)) {
    const gapMs = m[event] * 1000 - d[event];
    assert.ok(gapMs >= 1000, `${event}: gap=${gapMs}ms must be >= 1000ms`);
  }
});
