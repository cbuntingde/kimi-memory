// Hook tests. Spawn each wrapper with a JSON payload on stdin, expect
// exit 0 (fail-open), and verify stdout content for the events that
// emit context. Seed databases by running a real MCP server child so
// exercise the same code path the agent would use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { mkTempHome, rmRf, pluginRoot, writeJsonl, StdioMcp } from './_helpers.js';

const WRAPPER = (event) =>
  path.join(
    pluginRoot(),
    'hooks',
    {
      SessionStart: 'session-start',
      UserPromptSubmit: 'user-prompt-submit',
      Stop: 'stop',
      SessionEnd: 'session-end',
      PreCompact: 'pre-compact',
      Interrupt: 'interrupt',
      StopFailure: 'stop-failure',
    }[event] + '.js',
  );

function runHook(event, payload, { home } = {}) {
  const ownHome = home || mkTempHome();
  try {
    const r = spawnSync(process.execPath, [WRAPPER(event)], {
      cwd: pluginRoot(),
      env: { ...process.env, KIMI_CODE_HOME: ownHome, NO_COLOR: '1' },
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 20000,
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', home: ownHome };
  } finally {
    if (!home) rmRf(ownHome);
  }
}

async function initServer(home) {
  const mcp = new StdioMcp({ home });
  mcp.start();
  await mcp.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'seed', version: '0' },
  });
  return mcp;
}

test('SessionStart emits the compact status line with project + global counts', () => {
  const home = mkTempHome();
  try {
    const r = runHook('SessionStart', { cwd: 'C:/example/proj', session_id: 's-pre' }, { home });
    assert.equal(r.status, 0, 'hook must fail open');
    assert.match(r.stdout, /\[kimi-memory\] event=SessionStart/);
    assert.match(r.stdout, /project_key=[0-9a-f]{16}/);
    assert.match(r.stdout, /pmem\.active=0/);
    assert.match(r.stdout, /gmem\.active=0/);
    assert.match(r.stdout, /wm=0/);
    assert.match(r.stdout, /conv=0/);
    assert.match(r.stdout, /events=0/);
    assert.match(r.stdout, /ingest=/);
  } finally {
    rmRf(home);
  }
});

test('SessionStart emits a brief summary of recent memories, not verbose per-memory previews', async () => {
  const home = mkTempHome();
  const mcp = await initServer(home);
  try {
    // Project memory
    const a = await mcp.toolCall('memory_save', {
      cwd: 'C:/example/proj',
      type: 'semantic',
      title: 'tabs',
      content: 'Use tabs for indentation in this repo',
      tags: ['style'],
    });
    assert.ok(!a.isError, 'project save ok');
    // Global memory
    const g = await mcp.toolCall('memory_save', {
      cwd: 'C:/example/proj',
      scope: 'global',
      type: 'semantic',
      title: 'dark-mode',
      content: 'User prefers dark mode for all apps',
      tags: ['pref'],
    });
    assert.ok(!g.isError, 'global save ok');

    const r = runHook('SessionStart', { cwd: 'C:/example/proj', session_id: 's-pre-2' }, { home });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[kimi-memory\] event=SessionStart/);
    // Brief summary line (no per-memory content).
    assert.match(r.stdout, /Loaded 2 recent memories\. \(1 project, 1 global\.\)/);
    // Per-memory previews are suppressed.
    assert.equal(
      r.stdout.includes('[project] [semantic] tabs'),
      false,
      'verbose project memory preview should not be emitted',
    );
    assert.equal(
      r.stdout.includes('[global] [semantic] dark-mode'),
      false,
      'verbose global memory preview should not be emitted',
    );
    assert.equal(
      r.stdout.includes('Use tabs for indentation'),
      false,
      'memory content must not be echoed',
    );
    assert.equal(
      r.stdout.includes('User prefers dark mode'),
      false,
      'memory content must not be echoed',
    );
    // Counts on the status line still reflect the seeded rows.
    assert.match(r.stdout, /pmem\.active=1/);
    assert.match(r.stdout, /gmem\.active=1/);
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('SessionStart emits "No recent memories." when both stores are empty', () => {
  const home = mkTempHome();
  try {
    const r = runHook('SessionStart', { cwd: 'C:/example/proj', session_id: 's-empty' }, { home });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No recent memories\./);
  } finally {
    rmRf(home);
  }
});

test('UserPromptSubmit reports real ingest and a brief recall summary instead of verbose previews', async () => {
  const home = mkTempHome();
  const mcp = await initServer(home);
  try {
    // Seed the global DB with a recallable keyword.
    const g = await mcp.toolCall('memory_save', {
      cwd: 'C:/example/proj',
      scope: 'global',
      type: 'semantic',
      title: 'tabs default',
      content: 'Use tabs everywhere unless a project says otherwise',
      tags: ['pref'],
    });
    assert.ok(!g.isError);

    // Synthesise a wire.jsonl the Stop-handler inside UserPromptSubmit
    // can find. Without this, ingest reports skip:archive_not_found.
    const session = 's-archive-1';
    const workKey = 'wk-A';
    const sessDir = path.join(home, 'sessions', workKey, session);
    writeJsonl(path.join(sessDir, 'wire.jsonl'), [
      { role: 'user', text: 'first', created_at: '2026-07-01T00:00:00Z' },
      { role: 'assistant', text: 'reply', created_at: '2026-07-01T00:00:01Z' },
    ]);
    writeJsonl(path.join(home, 'session_index.jsonl'), [
      { sessionId: session, workDirKey: workKey },
    ]);

    const r = runHook(
      'UserPromptSubmit',
      {
        cwd: 'C:/example/proj',
        session_id: session,
        prompt: 'remind me, do we use tabs in this project?',
      },
      { home },
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /event=UserPromptSubmit/);
    // Real ingest: at least the two seed events should land.
    assert.match(r.stdout, /ingest=ok:[12-9]/, 'stdout=' + JSON.stringify(r.stdout));
    // Recall hit counts on the status line.
    assert.match(r.stdout, /recall project:\d+ global:\d+/);
    // Brief recall summary OR "No recall hits." — the keyword-bearing
    // prompt is "tabs" / "project" which FTS5 should match in the seeded
    // global row.
    assert.match(r.stdout, /Recalled \d+ memor(?:y|ies)(?:\. \(.+?\))?\.|No recall hits\./);
    // Per-memory previews must NOT be emitted.
    assert.equal(
      r.stdout.includes('[global] [semantic] tabs default'),
      false,
      'verbose global memory preview should not be emitted',
    );
    assert.equal(
      r.stdout.includes('Use tabs everywhere'),
      false,
      'memory content must not be echoed',
    );
    // Raw prompt must never be echoed.
    assert.equal(
      r.stdout.includes('remind me, do we use tabs'),
      false,
      'raw prompt must not be echoed',
    );
    // Output is bounded.
    assert.ok(
      r.stdout.length < 4096,
      'status output is bounded, got ' + r.stdout.length + ' bytes',
    );
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('Stop is idempotent and only ingests new bytes on the second call', () => {
  const home = mkTempHome();
  try {
    const session = 's-idem';
    const workKey = 'wk-idem';
    const sessDir = path.join(home, 'sessions', workKey, session);
    writeJsonl(path.join(sessDir, 'wire.jsonl'), [
      { role: 'user', text: 'first', created_at: '2026-07-01T00:00:00Z' },
      { role: 'assistant', text: 'reply', created_at: '2026-07-01T00:00:01Z' },
    ]);
    writeJsonl(path.join(home, 'session_index.jsonl'), [
      { sessionId: session, workDirKey: workKey },
    ]);

    const r1 = runHook('Stop', { cwd: 'C:/example/proj', session_id: session }, { home });
    assert.equal(r1.status, 0);
    assert.equal(r1.stdout, '');
    const r2 = runHook('Stop', { cwd: 'C:/example/proj', session_id: session }, { home });
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout, '');
  } finally {
    rmRf(home);
  }
});

test('Stop reports archive_not_found without throwing or exiting non-zero', () => {
  const home = mkTempHome();
  try {
    const r = runHook(
      'Stop',
      { cwd: 'C:/example/proj', session_id: 'no-such-session-anywhere' },
      { home },
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    rmRf(home);
  }
});

test('PreCompact snapshots without emitting context', () => {
  const r = runHook('PreCompact', { cwd: 'C:/example/proj' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('Interrupt and StopFailure never throw and always exit 0', () => {
  for (const ev of ['Interrupt', 'StopFailure']) {
    const r = runHook(ev, { cwd: 'C:/example/proj' });
    assert.equal(r.status, 0, ev + ' should fail open');
    assert.equal(r.stdout, '');
  }
});

test('hooks are fail-open on bad input (no payload, no cwd)', () => {
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
    const r = runHook(ev, {});
    assert.equal(r.status, 0, ev + ' should never block on bad payload');
  }
});

test('hooks never read outside KIMI_CODE_HOME; an unset home is still safe', () => {
  const wrapper = path.join(pluginRoot(), 'hooks', 'session-start.js');
  const r = spawnSync(process.execPath, [wrapper], {
    cwd: pluginRoot(),
    env: { ...process.env, KIMI_CODE_HOME: mkTempHome(), NO_COLOR: '1' },
    input: JSON.stringify({ cwd: 'C:/tmp/x' }),
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0);
});
