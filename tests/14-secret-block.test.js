// Tests for the server-side secret block on saveMemory / memory_save
// / memory_save_bulk. The plugin's docs and SKILL.md claim that
// secrets are never persisted; the auto-extract path already scrubs
// candidates, but the user-facing tools (memory_save, memory_save_bulk,
// memory_update, memory_merge) all funnel through saveMemory, so the
// lowest layer is the right place to enforce. This file proves:
//   - persist.saveMemory throws KIMI_MEMORY_SECRET_DETECTED on
//     secret-shaped content or title.
//   - the KIMI_MEMORY_SECRET_SCAN=off env var disables the block.
//   - memory_save (MCP) surfaces the error as a text tool response.
//   - memory_save_bulk (MCP) rolls back the entire batch when any one
//     item is a secret, so a partial leak is impossible.
//   - a non-secret memory in the same save call still succeeds after
//     a clean retry (i.e. the error is per-call, not sticky on the db).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf, StdioMcp } from './_helpers.js';
import { openDb, closeDb, memoryCounts, listMemories } from '../src/persist.js';
import { saveMemory, saveMemoryBulk } from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

const SECRET_SAMPLES = [
  { kind: 'openai', content: 'Use the key sk-abcdefghijklmnopqrstuvwxyz0123456789 for tests.' },
  {
    kind: 'anthropic',
    content: 'Anthropic key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789AB',
  },
  { kind: 'aws', content: 'AWS access key id is AKIAIOSFODNN7EXAMPLE for the staging env.' },
  { kind: 'github_pat', content: 'GitHub PAT: ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
  { kind: 'generic_assignment', content: 'api_key = abcdefghijklmnop' },
  { kind: 'bearer', content: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890' },
  { kind: 'pem', content: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK...' },
];

test('persist.saveMemory: refuses to persist secret-shaped content', () => {
  const home = mkTempHome();
  try {
    const key = deriveProjectKey('C:/test/secret-block-content');
    const dbPath = projectDbPath(home, key);
    const db = openDb(dbPath);
    for (const s of SECRET_SAMPLES) {
      assert.throws(
        () => saveMemory(db, key, { type: 'semantic', title: 'note', content: s.content }),
        (err) => {
          assert.equal(err.code, 'KIMI_MEMORY_SECRET_DETECTED', `${s.kind} content matched`);
          assert.match(err.message, /refusing to persist/);
          return true;
        },
        `${s.kind} content should trigger the secret block`,
      );
    }
    closeDb();
    // Re-open and confirm no row was written.
    const db2 = openDb(dbPath);
    const rows = listMemories(db2, key, {});
    assert.equal(rows.length, 0, 'no memory was persisted');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('persist.saveMemory: also blocks when the TITLE carries the secret', () => {
  const home = mkTempHome();
  try {
    const key = deriveProjectKey('C:/test/secret-block-title');
    const dbPath = projectDbPath(home, key);
    const db = openDb(dbPath);
    assert.throws(
      () =>
        saveMemory(db, key, {
          type: 'semantic',
          title: 'api_key = abcdefghijklmnop',
          content: 'clean content',
        }),
      (err) => {
        assert.equal(err.code, 'KIMI_MEMORY_SECRET_DETECTED');
        assert.match(err.message, /title/);
        return true;
      },
      'title with secret shape should be blocked',
    );
    closeDb();
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('persist.saveMemory: KIMI_MEMORY_SECRET_SCAN=off bypasses the block', () => {
  const prev = process.env.KIMI_MEMORY_SECRET_SCAN;
  process.env.KIMI_MEMORY_SECRET_SCAN = 'off';
  try {
    const home = mkTempHome();
    try {
      const key = deriveProjectKey('C:/test/secret-block-bypass');
      const dbPath = projectDbPath(home, key);
      const db = openDb(dbPath);
      const saved = saveMemory(db, key, {
        type: 'semantic',
        title: 'fixture',
        content: 'fixture: sk-abcdefghijklmnopqrstuvwxyz0123456789',
      });
      assert.ok(saved && saved.id, 'secret-shaped content saved when scanner is off');
      closeDb();
    } finally {
      rmRf(home);
    }
  } finally {
    if (prev === undefined) delete process.env.KIMI_MEMORY_SECRET_SCAN;
    else process.env.KIMI_MEMORY_SECRET_SCAN = prev;
  }
});

test('MCP round-trip: memory_save returns a secret_detected error and persists nothing', async () => {
  const home = mkTempHome();
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const cwd = 'C:/test/mcp-secret-block-save';
    const r = await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 'api_key',
      content: 'api_key = abcdefghijklmnop',
    });
    assert.equal(r.isError, true, 'memory_save returns an error result');
    const text = r.content[0].text;
    assert.match(text, /secret_detected/, 'error names the secret_detected code');
    assert.match(text, /refusing to persist/, 'error explains the refusal');
    // Confirm nothing landed in the DB.
    const status = await mcp.toolCall('memory_status', { cwd });
    const j = JSON.parse(status.content[0].text);
    assert.equal(j.memories.active, 0, 'no project memory was persisted');
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP round-trip: memory_save_bulk rolls back the whole batch on a secret', async () => {
  const home = mkTempHome();
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const cwd = 'C:/test/mcp-secret-block-bulk';
    const r = await mcp.toolCall('memory_save_bulk', {
      cwd,
      items: [
        { type: 'semantic', title: 'clean one', content: 'this is fine' },
        { type: 'semantic', title: 'clean two', content: 'also fine' },
        { type: 'semantic', title: 'oops', content: 'api_key = abcdefghijklmnop' },
      ],
    });
    assert.equal(r.isError, true, 'bulk save returns an error when one item is a secret');
    const text = r.content[0].text;
    assert.match(text, /secret_detected/, 'error names the secret_detected code');
    // The whole batch must be rolled back: the two clean items must NOT
    // be persisted alongside the bad one. This is the all-or-nothing
    // contract the bulk tool promises.
    const status = await mcp.toolCall('memory_status', { cwd });
    const j = JSON.parse(status.content[0].text);
    assert.equal(j.memories.active, 0, 'batch was rolled back; no memories persisted');
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP round-trip: a clean save after a blocked attempt still works', async () => {
  const home = mkTempHome();
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const cwd = 'C:/test/mcp-secret-block-recover';
    // First call: blocked.
    const bad = await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 'api_key',
      content: 'api_key = abcdefghijklmnop',
    });
    assert.equal(bad.isError, true, 'first call is blocked');
    // Second call: clean content, same db — should succeed.
    const good = await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 'note',
      content: 'this is a regular note with no secrets',
    });
    assert.equal(good.isError, undefined, 'second call succeeds');
    const j = JSON.parse(good.content[0].text);
    assert.equal(j.operation, 'saved');
    assert.ok(j.memory && j.memory.id);
  } finally {
    mcp.stop();
    rmRf(home);
  }
});
