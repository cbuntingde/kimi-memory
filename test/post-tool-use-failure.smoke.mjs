#!/usr/bin/env node
// Smoke test for the PostToolUseFailure handler. Exercises the handler
// against a temporary project DB and verifies the success, dedup, and
// invalid-payload paths. Run via:
//   KIMI_MEMORY_HOME=/tmp/km-test node test/post-tool-use-failure.smoke.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TMP_HOME = mkdtempSync(path.join(tmpdir(), 'km-hook-smoke-'));
process.env.KIMI_CODE_HOME = TMP_HOME;
process.env.KIMI_MEMORY_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const cwd = process.cwd();
const projectRoot = path.join(TMP_HOME, 'smoke-project');

const { handlePostToolUseFailure } = await import(
  pathToFileURL(path.join(cwd, 'src/hooks/handlers/post-tool-use-failure.js')).href
);
const { deriveProjectKey } = await import(pathToFileURL(path.join(cwd, 'src/project-key.js')).href);
const { ensureProjectDir } = await import(pathToFileURL(path.join(cwd, 'src/project-key.js')).href);

ensureProjectDir(TMP_HOME, deriveProjectKey(projectRoot));
const { listMemories } = await import(
  pathToFileURL(path.join(cwd, 'src/persist/memories.js')).href
);

async function readProjectDb() {
  const projectKey = deriveProjectKey(projectRoot);
  const { openDb } = await import(pathToFileURL(path.join(cwd, 'src/persist/connection.js')).href);
  return openDb(path.join(TMP_HOME, 'kimi-memory', projectKey, 'memory.sqlite'));
}

const cases = [];
function it(name, fn) {
  cases.push({ name, fn });
}

it('rejects payloads with no project cwd', async () => {
  const result = await handlePostToolUseFailure({ toolName: 'X', error: { message: 'boom' } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_project_cwd');
});

it('rejects payloads with a missing toolName', async () => {
  const result = await handlePostUseFailureFor(projectRoot, { error: { message: 'boom' } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_payload');
  assert.match(result.detail, /missing toolName/);
});

it('rejects payloads with a missing error.message', async () => {
  const result = await handlePostUseFailureFor(projectRoot, { toolName: 'X' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_payload');
  assert.match(result.detail, /missing error.message/);
});

it('records a procedural memory on the first failure', async () => {
  const before = await countFailures();
  const result = await handlePostUseFailureFor(projectRoot, {
    toolName: 'Bash',
    sessionId: 'sess-A',
    toolCallId: 'call-1',
    toolInput: { command: 'kimi --help' },
    error: { message: 'spawn EINVAL' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, undefined);
  assert.match(result.id, /^[a-f0-9]+$/);
  const after = await countFailures();
  assert.equal(after, before + 1);
});

it('dedupes a second identical failure within the dedup window', async () => {
  const toolName = `Bash-dedup-${Date.now()}`;
  const before = await countFailures();
  const first = await handlePostUseFailureFor(projectRoot, {
    toolName,
    sessionId: 'sess-B',
    error: { message: 'spawn EINVAL' },
  });
  const second = await handlePostUseFailureFor(projectRoot, {
    toolName,
    sessionId: 'sess-C',
    error: { message: 'spawn EINVAL' },
  });
  assert.equal(first.ok, true);
  assert.equal(first.skipped, undefined);
  assert.equal(second.ok, true);
  assert.equal(second.skipped, 'duplicate');
  assert.equal(second.id, first.id);
  const after = await countFailures();
  assert.equal(after, before + 1, 'dedup should insert exactly one row across the pair');
});

it('does not dedupe a different tool name', async () => {
  const toolName = `Edit-dedup-${Date.now()}`;
  const before = await countFailures();
  await handlePostUseFailureFor(projectRoot, {
    toolName,
    error: { message: 'boom' },
  });
  const after = await countFailures();
  assert.equal(after, before + 1);
});

async function handlePostUseFailureFor(cwdValue, payload) {
  return handlePostToolUseFailure({ ...payload, cwd: cwdValue, projectRoot: cwdValue });
}

async function countFailures() {
  const projectKey = deriveProjectKey(projectRoot);
  const db = await readProjectDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM memories
       WHERE project_key = ? AND type = 'procedural' AND tags LIKE '%tool-failure%'`,
    )
    .get(projectKey);
  return row.n;
}

let failures = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}

try {
  rmSync(TMP_HOME, { recursive: true, force: true });
} catch {
  // ignore: WAL files may still be locked on Windows; cleanup is best-effort.
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log(`\n${cases.length} case(s) passed`);
