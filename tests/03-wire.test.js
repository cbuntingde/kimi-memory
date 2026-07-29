// Tests for the wire.jsonl reader: malformed lines, partial JSON, role
// extraction, idempotent incremental ingest, and bounded discovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkTempHome, rmRf, writeJsonl, writeRaw, pluginRoot, StdioMcp } from './_helpers.js';
import { classifyEvent, extractSummary, extractCreatedAt, walkWire, locateSessionArchive, readSessionIndex } from '../src/wire.js';
import { openDb, listConversations, getConversationEvents, projectStatus } from '../src/persist.js';
import { projectDbPath, deriveProjectKey, ensureProjectDir } from '../src/project-key.js';

test('classifyEvent maps common kinds to roles', () => {
  assert.equal(classifyEvent({ kind: 'user' }).role, 'user');
  assert.equal(classifyEvent({ type: 'assistant' }).role, 'assistant');
  assert.equal(classifyEvent({ role: 'tool' }).role, 'tool');
  assert.equal(classifyEvent({ kind: 'tool_call' }).role, 'tool');
  assert.equal(classifyEvent({ kind: 'function_result' }).role, 'tool');
  assert.equal(classifyEvent({ kind: 'system' }).role, 'system');
  assert.equal(classifyEvent({}).role, null);
  assert.equal(classifyEvent(null).role, null);
});

test('extractSummary finds text in common shapes', () => {
  assert.equal(extractSummary({ message: 'hi' }), 'hi');
  assert.equal(extractSummary({ content: 'bye' }), 'bye');
  assert.equal(extractSummary({ content: [{ text: 'a' }, { text: 'b' }] }), 'ab');
  assert.equal(extractSummary({ message: { content: 'nested' } }), 'nested');
  assert.equal(extractSummary({ tool_call: { name: 'Bash', args: { cmd: 'ls' } } }).startsWith('[tool_call] Bash'), true);
  assert.equal(extractSummary(null), null);
});

test('extractSummary understands current Kimi wire event shapes', () => {
  const user = { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'remember this' }] } };
  const tool = { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Read', args: { path: 'a.js' } } };
  assert.equal(classifyEvent(user).role, 'user');
  assert.equal(extractSummary(user), 'remember this');
  assert.equal(classifyEvent(tool).role, 'tool');
  assert.match(extractSummary(tool), /^\[tool_call\] Read/);
});

test('extractCreatedAt preserves numeric Kimi timestamps', () => {
  assert.equal(extractCreatedAt({ time: 1785180915985 }), '2026-07-27T19:35:15.985Z');
  assert.equal(extractCreatedAt({ time: 1785180915 }), '2026-07-27T19:35:15.000Z');
});

test('walkWire preserves malformed lines without crashing', async () => {
  const tmp = mkTempHome();
  try {
    const file = path.join(tmp, 'wire.jsonl');
    const lines = [
      { role: 'user', text: 'hi' },
      'not-json-line',
      '{"role":"assistant","text":"hello"}',
      '{"incomplete":',
      '',
      { role: 'tool', kind: 'tool_call', tool_call: { name: 'Read', args: { file: 'a' } } },
    ];
    writeJsonl(file, lines);
    const out = [];
    for await (const ev of walkWire(file, 0)) out.push(ev);
    // 5 real lines (one is empty — readJsonl skips empty trailing); the
    // walk yields a record for every line with bytes consumed.
    assert.ok(out.length >= 4, 'should yield most lines');
    const kinds = out.map((e) => e.kind);
    assert.ok(kinds.includes('user'));
    assert.ok(kinds.includes('assistant'));
    assert.ok(out.some((event) => event.role === 'tool'));
    // At least one malformed entry (the partial JSON or non-JSON).
    assert.ok(out.some((e) => e.kind === 'malformed' || e.error), 'should record at least one malformed/parse error');
  } finally { rmRf(tmp); }
});

test('incremental ingest is idempotent across re-runs', async () => {
  const tmp = mkTempHome();
  try {
    const session = 'sess-abc';
    const workKey = 'wk1';
    const sessDir = path.join(tmp, 'sessions', workKey, session);
    const wire = path.join(sessDir, 'wire.jsonl');
    const idx = path.join(tmp, 'session_index.jsonl');
    writeJsonl(idx, [{ session_id: session, work_dir_key: workKey }]);
    writeJsonl(wire, [
      { role: 'user', text: 'first', created_at: '2026-07-01T00:00:00Z' },
      { role: 'assistant', text: 'reply', created_at: '2026-07-01T00:00:01Z' },
    ]);

    const mcp = new StdioMcp({ home: tmp });
    mcp.start();
    try {
      await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      const r1 = await mcp.toolCall('conversation_ingest', { cwd: 'C:/proj-test', session_id: session, work_dir_key: workKey });
      assert.equal(r1.isError, undefined);
      const j1 = JSON.parse(r1.content[0].text);
      assert.equal(j1.ingested, 2);
      assert.equal(j1.status, 'ok');

      // Second call: no new bytes — should ingest 0.
      const r2 = await mcp.toolCall('conversation_ingest', { cwd: 'C:/proj-test', session_id: session, work_dir_key: workKey });
      const j2 = JSON.parse(r2.content[0].text);
      assert.equal(j2.ingested, 0);

      // Append a new line, ingest again — should pick up 1 new event.
      const fs = await import('node:fs/promises');
      await fs.appendFile(wire, JSON.stringify({ role: 'user', text: 'second', created_at: '2026-07-01T00:00:02Z' }) + '\n');
      const r3 = await mcp.toolCall('conversation_ingest', { cwd: 'C:/proj-test', session_id: session, work_dir_key: workKey });
      const j3 = JSON.parse(r3.content[0].text);
      assert.equal(j3.ingested, 1);

      // Listing the project should show 1 conversation with 3 events.
      const list = await mcp.toolCall('conversation_list', { cwd: 'C:/proj-test' });
      const lj = JSON.parse(list.content[0].text);
      assert.equal(lj.count, 1);
      const get = await mcp.toolCall('conversation_get', { cwd: 'C:/proj-test', session_id: session });
      const gj = JSON.parse(get.content[0].text);
      assert.equal(gj.count, 3);
    } finally {
      mcp.stop();
    }
  } finally { rmRf(tmp); }
});

test('locateSessionArchive finds wire.jsonl via work_dir_key and via session index', async () => {
  const tmp = mkTempHome();
  try {
    const session = 'sess-xyz';
    const wk = 'wk2';
    const sessDir = path.join(tmp, 'sessions', wk, session);
    writeRaw(path.join(sessDir, 'agents', 'main', 'wire.jsonl'), '{}\n');
    const f1 = await locateSessionArchive(tmp, wk, session);
    assert.ok(f1 && f1.endsWith(path.join('agents', 'main', 'wire.jsonl')));

    // No work_dir_key, but current camelCase session_index fields locate it.
    const idx = path.join(tmp, 'session_index.jsonl');
    writeJsonl(idx, [{ sessionId: session, sessionDir: sessDir, workDirKey: wk }]);
    const f2 = await locateSessionArchive(tmp, null, session);
    assert.ok(f2 && f2.endsWith('wire.jsonl'));
  } finally { rmRf(tmp); }
});

test('readSessionIndex is tolerant of empty/missing file', async () => {
  const tmp = mkTempHome();
  try {
    const a = await readSessionIndex(tmp);
    assert.deepEqual(a, []);
    writeJsonl(path.join(tmp, 'session_index.jsonl'), [
      { session_id: 's1', work_dir_key: 'w1' },
      'not-json',
      { session_id: 's2' },
    ]);
    const b = await readSessionIndex(tmp);
    assert.equal(b.length, 2, 'non-JSON lines are skipped');
  } finally { rmRf(tmp); }
});
