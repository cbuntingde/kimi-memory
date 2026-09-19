// Tests for the PostToolUseFailure handler: payload validation,
// procedural memory recording, and the 1-hour dedup window.
//
// The handler reads HOME from process.env.KIMI_CODE_HOME at module
// load time, so the env has to be set before the dynamic import of
// the handler module runs. The temp home is created here and removed
// in `after()`.
//
// Each test uses a unique toolName (timestamp + random) so the
// cross-test dedup state in the shared temp DB does not interfere.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { pluginRoot, rmRf } from './_helpers.js';

const TMP_HOME = mkdtempSync(path.join(tmpdir(), 'km-pstuf-'));
process.env.KIMI_CODE_HOME = TMP_HOME;
process.env.KIMI_MEMORY_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;
process.env.KIMI_MEMORY_EMBEDDINGS = 'off';

const root = pluginRoot();
const projectRoot = path.join(TMP_HOME, 'smoke-project');

const { handlePostToolUseFailure } = await import(
  pathToFileURL(path.join(root, 'src/hooks/handlers/post-tool-use-failure.js')).href
);
const { deriveProjectKey, ensureProjectDir } = await import(
  pathToFileURL(path.join(root, 'src/project-key.js')).href
);
const { openDb } = await import(pathToFileURL(path.join(root, 'src/persist/connection.js')).href);

const projectKey = deriveProjectKey(projectRoot);
await ensureProjectDir(TMP_HOME, projectKey);

function openProjectDb() {
  return openDb(path.join(TMP_HOME, 'kimi-memory', projectKey, 'memory.sqlite'));
}

function call(payload) {
  return handlePostToolUseFailure({ ...payload, cwd: projectRoot, projectRoot });
}

function countFailuresFor(toolName) {
  // openDb caches connections by path, so we never close — closing
  // here would invalidate the handle for subsequent tests and the
  // handler. The temp dir is removed in `after()`; file handles are
  // released when the test process exits.
  const db = openProjectDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM memories
       WHERE project_key = ? AND type = 'procedural' AND title = ?`,
    )
    .get(projectKey, `Tool failure: ${toolName}`);
  return row.n;
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('PostToolUseFailure handler', () => {
  after(() => rmRf(TMP_HOME));

  it('rejects payloads with no project cwd', async () => {
    const result = await handlePostToolUseFailure({
      toolName: 'X',
      error: { message: 'boom' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_project_cwd');
  });

  it('rejects payloads with a missing toolName', async () => {
    const result = await call({ error: { message: 'boom' } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_payload');
    assert.match(result.detail, /missing toolName/);
  });

  it('rejects payloads with a missing error.message', async () => {
    const result = await call({ toolName: 'X' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_payload');
    assert.match(result.detail, /missing error.message/);
  });

  it('records a procedural memory on the first failure', async () => {
    const toolName = `Bash-rec-${uniqueSuffix()}`;
    const before = countFailuresFor(toolName);
    const result = await call({
      toolName,
      sessionId: 'sess-A',
      toolCallId: 'call-1',
      toolInput: { command: 'kimi --help' },
      error: { message: 'spawn EINVAL' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, undefined);
    assert.ok(
      typeof result.id === 'string' && result.id.length >= 8,
      'id should be a non-trivial string',
    );
    assert.equal(countFailuresFor(toolName), before + 1);
  });

  it('dedupes a second identical failure within the dedup window', async () => {
    const toolName = `Bash-dedup-${uniqueSuffix()}`;
    const before = countFailuresFor(toolName);
    const first = await call({
      toolName,
      sessionId: 'sess-B',
      error: { message: 'spawn EINVAL' },
    });
    const second = await call({
      toolName,
      sessionId: 'sess-C',
      error: { message: 'spawn EINVAL' },
    });
    assert.equal(first.ok, true);
    assert.equal(first.skipped, undefined);
    assert.equal(second.ok, true);
    assert.equal(second.skipped, 'duplicate');
    assert.equal(second.id, first.id);
    assert.equal(
      countFailuresFor(toolName),
      before + 1,
      'dedup should insert exactly one row across the pair',
    );
  });

  it('does not dedupe a different tool name', async () => {
    const toolName = `Edit-dedup-${uniqueSuffix()}`;
    const before = countFailuresFor(toolName);
    await call({ toolName, error: { message: 'boom' } });
    assert.equal(countFailuresFor(toolName), before + 1);
  });
});
