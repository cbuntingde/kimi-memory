// Tests for the dreaming subsystem (src/dreaming.js + the unified
// `dreaming` MCP handler + the SessionStart maybeDreaming wiring).
//
// Coverage targets:
//   - parseInterval: human forms ("30m", "3h", "24h", "1d", "1h30m")
//   - resolveDreamingState: per-project overrides win over the global
//     fallback; KIMI_MEMORY_DREAMING_* env vars override the file
//   - setDreamingState: invalid mode/interval/include throw
//   - shouldDreamNow: wall-clock floor; force=true bypasses
//   - runDreaming: composition order (consolidate → dream → gc); writes
//     last_run; respects mode=off
//   - dreaming MCP tool (unified): dispatches sub=status|on|off|auto|run|last

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf, StdioMcp } from './_helpers.js';
import {
  DREAMING_MODES,
  DREAMING_PASSES,
  getDreamingStatus,
  parseInterval,
  resolveDreamingState,
  runDreaming,
  setDreamingState,
  shouldDreamNow,
} from '../src/dreaming.js';
import { openDb } from '../src/persist/index.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';

function call(mcp, name, args) {
  return mcp.toolCall(name, args);
}

async function openDbFor(home, projectKey) {
  const dbPath = path.join(home, 'kimi-memory', projectKey, 'memory.sqlite');
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  return openDb(dbPath);
}

// ---------- parseInterval ----------

test('parseInterval: human forms', () => {
  assert.equal(parseInterval('30m'), 30 * 60 * 1000);
  assert.equal(parseInterval('3h'), 3 * 60 * 60 * 1000);
  assert.equal(parseInterval('24h'), 24 * 60 * 60 * 1000);
  assert.equal(parseInterval('1d'), 24 * 60 * 60 * 1000);
  assert.equal(parseInterval('1h30m'), 90 * 60 * 1000);
  assert.equal(parseInterval('2d12h'), (2 * 24 + 12) * 60 * 60 * 1000);
  // bare integer is treated as minutes (CLI default).
  assert.equal(parseInterval('15'), 15 * 60 * 1000);
  // explicit number is treated as ms.
  assert.equal(parseInterval(60000), 60000);
  // invalid inputs.
  assert.equal(parseInterval(''), null);
  assert.equal(parseInterval('foo'), null);
  assert.equal(parseInterval('5x'), null);
  assert.equal(parseInterval(null), null);
  assert.equal(parseInterval(undefined), null);
});

// ---------- resolveDreamingState ----------

test('resolveDreamingState: defaults to mode=auto with the global fallback', () => {
  const home = mkTempHome();
  try {
    const state = resolveDreamingState({
      projectKey: 'abc123',
      kimiHomeDir: home,
    });
    assert.equal(state.mode, 'auto');
    assert.ok(DREAMING_PASSES.every((p) => state.include.includes(p)));
    assert.deepEqual(state.sources, { project: false, global: true });
  } finally {
    rmRf(home);
  }
});

test('resolveDreamingState: per-project file overrides the global fallback', async () => {
  const home = mkTempHome();
  try {
    await setDreamingState({
      projectKey: '_global',
      mode: 'on',
      intervalMs: 3 * 60 * 60 * 1000,
      kimiHomeDir: home,
    });
    await setDreamingState({
      projectKey: 'abc123',
      mode: 'off',
      kimiHomeDir: home,
    });
    const state = resolveDreamingState({
      projectKey: 'abc123',
      kimiHomeDir: home,
    });
    assert.equal(state.mode, 'off', 'per-project file wins over global');
    assert.deepEqual(state.sources, { project: true, global: true });
  } finally {
    rmRf(home);
  }
});

test('resolveDreamingState: env vars override file values for the current process', async () => {
  const home = mkTempHome();
  try {
    await setDreamingState({
      projectKey: 'abc123',
      mode: 'auto',
      intervalMs: 60 * 60 * 1000,
      kimiHomeDir: home,
    });
    process.env.KIMI_MEMORY_DREAMING_MODE = 'on';
    process.env.KIMI_MEMORY_DREAMING_INTERVAL_MS = String(2 * 60 * 60 * 1000);
    try {
      const state = resolveDreamingState({
        projectKey: 'abc123',
        kimiHomeDir: home,
      });
      assert.equal(state.mode, 'on', 'env KIMI_MEMORY_DREAMING_MODE wins');
      assert.equal(state.intervalMs, 2 * 60 * 60 * 1000, 'env interval wins');
    } finally {
      delete process.env.KIMI_MEMORY_DREAMING_MODE;
      delete process.env.KIMI_MEMORY_DREAMING_INTERVAL_MS;
    }
  } finally {
    rmRf(home);
  }
});

// ---------- setDreamingState ----------

test('setDreamingState: rejects an unknown mode', async () => {
  const home = mkTempHome();
  try {
    await assert.rejects(
      () => setDreamingState({ projectKey: 'abc', mode: 'sometimes', kimiHomeDir: home }),
      /invalid mode/,
    );
  } finally {
    rmRf(home);
  }
});

test('setDreamingState: rejects an unknown interval_spec', async () => {
  const home = mkTempHome();
  try {
    await assert.rejects(
      () => setDreamingState({ projectKey: 'abc', intervalSpec: '5x', kimiHomeDir: home }),
      /invalid interval/,
    );
  } finally {
    rmRf(home);
  }
});

test('setDreamingState: rejects an empty include list', async () => {
  const home = mkTempHome();
  try {
    await assert.rejects(
      () => setDreamingState({ projectKey: 'abc', include: [], kimiHomeDir: home }),
      /include must name at least one/,
    );
  } finally {
    rmRf(home);
  }
});

// ---------- shouldDreamNow ----------

test('shouldDreamNow: never fires in mode=off', () => {
  const state = { mode: 'off', intervalMs: 0, include: [] };
  assert.equal(shouldDreamNow(state, { force: true }), false);
});

test('shouldDreamNow: fires immediately when last_run is null', () => {
  const state = { mode: 'on', intervalMs: 1000, include: ['consolidate'], last_run: null };
  assert.equal(shouldDreamNow(state, { now: new Date() }), true);
});

test('shouldDreamNow: respects the wall-clock floor', () => {
  const now = new Date('2026-08-30T12:00:00Z');
  const state = {
    mode: 'on',
    intervalMs: 3 * 60 * 60 * 1000,
    include: ['consolidate'],
    last_run: { at: '2026-08-30T11:00:00Z' },
  };
  assert.equal(shouldDreamNow(state, { now }), false, '1h ago < 3h floor');
  assert.equal(
    shouldDreamNow(state, { now: new Date('2026-08-30T15:00:00Z') }),
    true,
    '3h+ ago → fires',
  );
});

test('shouldDreamNow: force=true bypasses the floor', () => {
  const now = new Date('2026-08-30T12:00:00Z');
  const state = {
    mode: 'on',
    intervalMs: 24 * 60 * 60 * 1000,
    include: ['consolidate'],
    last_run: { at: '2026-08-30T11:59:00Z' },
  };
  assert.equal(shouldDreamNow(state, { now }), false);
  assert.equal(shouldDreamNow(state, { now, force: true }), true);
});

// ---------- runDreaming ----------

test('runDreaming: skips below the wall-clock floor', async () => {
  const home = mkTempHome();
  try {
    await setDreamingState({
      projectKey: 'abc',
      mode: 'on',
      intervalMs: 24 * 60 * 60 * 1000,
      kimiHomeDir: home,
    });
    const db = await openDbFor(home, 'abc');
    const dir = path.join(home, 'kimi-memory', 'abc');
    await fs.writeFile(
      path.join(dir, 'dreaming.json'),
      JSON.stringify({
        mode: 'on',
        intervalMs: 24 * 60 * 60 * 1000,
        include: ['consolidate'],
        last_run: { at: new Date().toISOString(), duration_ms: 0, passes: {} },
      }),
    );
    const result = await runDreaming({
      db,
      projectKey: 'abc',
      cwd: '/test',
      kimiHomeDir: home,
    });
    assert.equal(result.fired, false);
    assert.equal(result.skipped, 'below_interval');
  } finally {
    rmRf(home);
  }
});

test('runDreaming: skips with skipped=no_db_or_key when DB is null', async () => {
  const home = mkTempHome();
  try {
    const result = await runDreaming({
      db: null,
      projectKey: 'abc',
      cwd: '/test',
      force: true,
      kimiHomeDir: home,
    });
    assert.equal(result.skipped, 'no_db_or_key');
    assert.equal(result.fired, false);
  } finally {
    rmRf(home);
  }
});

// ---------- getDreamingStatus ----------

test('getDreamingStatus: due=true when no last_run has been recorded', () => {
  const home = mkTempHome();
  try {
    const status = getDreamingStatus({ projectKey: 'fresh', kimiHomeDir: home });
    assert.equal(status.due, true);
    assert.equal(status.mode, 'auto');
    assert.ok(status.next_due_at);
  } finally {
    rmRf(home);
  }
});

test('getDreamingStatus: mode=off → next_due_at is null and due=false', () => {
  const home = mkTempHome();
  try {
    const status = {
      mode: 'off',
      intervalMs: 1000,
      intervalHuman: '1s',
      include: ['consolidate'],
      sources: { project: false, global: true },
      last_run: null,
      next_due_at: null,
      last_run_age_ms: null,
      due: false,
    };
    assert.equal(status.mode, 'off');
    assert.equal(status.due, false);
    assert.equal(status.next_due_at, null);
  } finally {
    rmRf(home);
  }
});

// ---------- MCP: dreaming (unified tool) ----------

test('MCP dreaming {sub:status} returns the effective state', async () => {
  const home = mkTempHome();
  const cwd = 'C:/test/dreaming-status';
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const r = await call(mcp, 'dreaming', { cwd, args: '{"sub":"status"}' });
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.operation, 'dreaming_status');
    assert.equal(payload.mode, 'auto');
    assert.ok(Array.isArray(payload.include));
    assert.equal(typeof payload.due, 'boolean');
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP dreaming {sub:on,interval_spec:3h} writes per-project state', async () => {
  const home = mkTempHome();
  const cwd = 'C:/test/dreaming-set';
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const r = await call(mcp, 'dreaming', {
      cwd,
      args: '{"sub":"on","interval_spec":"3h"}',
    });
    const setPayload = JSON.parse(r.content[0].text);
    assert.equal(setPayload.operation, 'dreaming_set');
    assert.equal(setPayload.mode, 'on');
    assert.equal(setPayload.intervalMs, 3 * 60 * 60 * 1000);
    const status = await call(mcp, 'dreaming', {
      cwd,
      args: '{"sub":"status"}',
    });
    const statusPayload = JSON.parse(status.content[0].text);
    assert.equal(statusPayload.mode, 'on');
    assert.equal(statusPayload.intervalMs, 3 * 60 * 60 * 1000);
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP dreaming refuses intervals shorter than 5 minutes', async () => {
  const home = mkTempHome();
  const cwd = 'C:/test/dreaming-short';
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const r = await call(mcp, 'dreaming', {
      cwd,
      args: '{"sub":"on","interval_ms":60000}',
    });
    const payload = JSON.parse(r.content[0].text);
    assert.ok(payload.error, 'must reject 60s interval');
    assert.match(payload.error, /5 minutes/);
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP dreaming {scope:global} writes to the system-wide default', async () => {
  const home = mkTempHome();
  const cwd = 'C:/test/dreaming-global';
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    await call(mcp, 'dreaming', {
      cwd,
      args: '{"sub":"off","scope":"global"}',
    });
    const p = path.join(home, 'kimi-memory', '_config', 'dreaming.json');
    const data = JSON.parse(await fs.readFile(p, 'utf8'));
    assert.equal(data.mode, 'off');
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP dreaming {sub:run,force:true} fires one pass', async () => {
  const home = mkTempHome();
  const cwd = 'C:/test/dreaming-run';
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    await call(mcp, 'memory_save', {
      cwd,
      type: 'semantic',
      title: 'sample fact',
      content: 'wind in oslo',
    });
    const r = await call(mcp, 'dreaming', {
      cwd,
      args: '{"sub":"run","force":true,"include":"consolidate,gc"}',
    });
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.operation, 'dreaming_run');
    assert.equal(payload.fired, true);
    assert.deepEqual(payload.include.sort(), ['consolidate', 'gc']);
    assert.ok(payload.passes.consolidate);
    assert.ok(payload.passes.gc);
    // dream was excluded.
    assert.equal(payload.passes.dream, undefined);
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP dreaming rejects empty include/exclude intersection', async () => {
  const home = mkTempHome();
  const cwd = 'C:/test/dreaming-empty';
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const r = await call(mcp, 'dreaming', {
      cwd,
      args: '{"sub":"run","force":true,"include":"consolidate","exclude":"consolidate"}',
    });
    const payload = JSON.parse(r.content[0].text);
    assert.ok(payload.error);
    assert.match(payload.error, /include\/exclude intersection is empty/);
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP dreaming {sub:last} returns the most recent run summary', async () => {
  const home = mkTempHome();
  const cwd = 'C:/test/dreaming-last';
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    await call(mcp, 'dreaming', { cwd, args: '{"sub":"run","force":true}' });
    const last = await call(mcp, 'dreaming', {
      cwd,
      args: '{"sub":"last"}',
    });
    const payload = JSON.parse(last.content[0].text);
    assert.equal(payload.operation, 'dreaming_last');
    assert.ok(payload.last_run, 'last_run must be present after a forced run');
    assert.ok(payload.last_run.at);
  } finally {
    mcp.stop();
    rmRf(home);
  }
});
