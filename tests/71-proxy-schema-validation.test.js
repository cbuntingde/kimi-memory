// The HTTP proxy must run the tool's own Zod schema before dispatch.
//
// The registry handed the proxy the bare post-resolve callback and the
// proxy called it directly, so the SDK's `safeParseAsync` step never ran
// on an HTTP body. Two consequences, both reproduced through the real
// proxy below:
//   (a) undeclared keys survived — `POST /tools/working_memory_set` with a
//       `scope: "global"` reached `openScopeDb` with a scope the tool's
//       schema does not declare, so the call wrote to the GLOBAL store;
//   (b) no `.max()` cap applied — `memory_diagnostics {limit: 1000000}`
//       reached a handler that reads `args.limit || 100` and selected the
//       whole log instead of the schema's 500 ceiling.
// The registry value is now `{ schema, fn }` and dispatchTool parses the
// body through `schema` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { mkTempHome, rmRf, pluginRoot } from './_helpers.js';
import { closeDb } from '../src/persist/connection.js';
import { globalDbPath } from '../src/project-key.js';

// Ask the OS for a free port, then release it. The window before the
// proxy binds is small and the port comes from the ephemeral range.
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

// Start the real proxy (the same startProxy the CLI uses) against a
// throwaway home, hand the caller its port, and tear everything down —
// proxy, SQLite handles, temp home — on every path.
async function withProxy(fn) {
  const home = mkTempHome('pm-proxy-schema-');
  const port = await freePort();
  const prevAuth = process.env.KIMI_MEMORY_PROXY_AUTH;
  delete process.env.KIMI_MEMORY_PROXY_AUTH;
  const { startProxy } = await import('../src/proxy/server.js');
  let proxy = null;
  try {
    proxy = await startProxy({
      host: '127.0.0.1',
      port,
      kimiHomeDir: home,
      pluginRootDir: pluginRoot(),
      authToken: 'tok',
      logger: () => {},
    });
    await fn({ home, port });
  } finally {
    try {
      if (proxy) await proxy.close();
    } catch {
      /* ignore */
    }
    try {
      closeDb();
    } catch {
      /* ignore */
    }
    if (prevAuth === undefined) delete process.env.KIMI_MEMORY_PROXY_AUTH;
    else process.env.KIMI_MEMORY_PROXY_AUTH = prevAuth;
    rmRf(home);
  }
}

function callTool(port, toolName, body) {
  return fetch(`http://127.0.0.1:${port}/tools/${toolName}`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('proxy: a smuggled scope is stripped and the global DB is never created', async () => {
  await withProxy(async ({ home, port }) => {
    const res = await callTool(port, 'working_memory_set', {
      cwd: home,
      slot: 'current_focus',
      value: 'focus body',
      scope: 'global',
    });
    assert.equal(res.status, 200, 'the call itself is valid once `scope` is stripped');
    const body = await res.json();
    assert.equal(body.isError, undefined);
    const payload = JSON.parse(body.content[0].text);
    assert.equal(payload.slot, 'current_focus');
    assert.equal(payload.value, 'focus body');

    // working_memory_set's schema declares no `scope`, so scope validation
    // is skipped for it and the wrapper falls back to the project DB. If
    // the undeclared key had survived, openScopeDb would have opened (and
    // created) the global store.
    assert.equal(
      existsSync(globalDbPath(home)),
      false,
      'the global database must not be created by a project-scoped tool',
    );

    // The write really landed in the project DB: reading it back through
    // the same proxy returns the value.
    const read = await callTool(port, 'working_memory_get', {
      cwd: home,
      slot: 'current_focus',
    });
    assert.equal(read.status, 200);
    const readBody = await read.json();
    assert.equal(JSON.parse(readBody.content[0].text).value, 'focus body');
    assert.equal(existsSync(globalDbPath(home)), false, 'still no global database');
  });
});

test('proxy: memory_diagnostics {limit:1000000} is rejected with the schema message', async () => {
  await withProxy(async ({ port }) => {
    const res = await callTool(port, 'memory_diagnostics', { limit: 1000000 });
    assert.equal(res.status, 400, 'a schema rejection is a malformed body, not a server fault');
    const body = await res.json();
    assert.equal(body.code, 'invalid_args');
    assert.match(body.error, /less than or equal to 500/, 'the declared cap is enforced');
    assert.match(body.error, /at limit/, 'the SDK-style dot path is carried in the message');
  });
});

test('proxy: a wrong field type is rejected before the handler runs', async () => {
  await withProxy(async ({ port, home }) => {
    const res = await callTool(port, 'working_memory_set', {
      cwd: home,
      slot: 'current_focus',
      value: 42,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'invalid_args');
    assert.match(body.error, /expected string/i);
    assert.match(body.error, /at value/, 'the offending field is named');
  });
});

test('proxy: a valid call still dispatches and an unknown tool is still 404', async () => {
  await withProxy(async ({ home, port }) => {
    const ok = await callTool(port, 'working_memory_set', {
      cwd: home,
      slot: 'active_task',
      value: 'ship the audit fixes',
    });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    const payload = JSON.parse(okBody.content[0].text);
    assert.equal(payload.slot, 'active_task');
    assert.equal(payload.value, 'ship the audit fixes');

    const missing = await callTool(port, 'not_a_real_tool', {});
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'unknown_tool');

    // /tools reads the same Map through `.keys()` and must still work.
    const listed = await fetch(`http://127.0.0.1:${port}/tools`, {
      headers: { authorization: 'Bearer tok' },
    });
    assert.equal(listed.status, 200);
    const tools = await listed.json();
    assert.ok(tools.count > 0);
    assert.ok(tools.tools.includes('working_memory_set'));
  });
});

test('proxy: a tool-level failure is not returned as 200', async () => {
  await withProxy(async ({ home, port }) => {
    // A read tool on a project with no DB: the wrapped handler reports the
    // failure by RETURNING a tool-result with isError rather than throwing.
    const res = await callTool(port, 'memory_get', {
      cwd: home,
      id: 'no-such-memory',
      scope: 'project',
    });
    assert.equal(res.status, 400, 'an isError tool-result must not read as success');
    const body = await res.json();
    assert.equal(body.isError, true);
    assert.equal(body.code, 'tool_error');
  });
});
