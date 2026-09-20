// Tests for the proxy non-loopback tool guard.
//
// (Prior audit flag F-003 — a network bind with a single shared bearer
// token is a network-wide admin path. Default-deny the destructive
// tools on non-loopback binds; let the operator opt in.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nonLoopbackToolGuard } from '../src/proxy/server.js';

test('nonLoopbackToolGuard: loopback binds bypass the destructive-set guard, never the deny-list', () => {
  // AGENTS.md, `## Environment variables` → HTTP proxy:
  //   `KIMI_MEMORY_PROXY_DENY_TOOLS` | unset | "Comma-separated
  //   deny-list. Wins over the allow-list."
  // The contract carries no loopback carve-out, and the proxy is
  // documented to default to 127.0.0.1 — so the deny-list has to
  // enforce there too. This test used to assert `null` for a loopback
  // host while DENY_TOOLS was set, which pinned the defect: the control
  // was silently inert on the documented default bind.
  const prevDeny = process.env.KIMI_MEMORY_PROXY_DENY_TOOLS;
  try {
    delete process.env.KIMI_MEMORY_PROXY_DENY_TOOLS;
    assert.equal(nonLoopbackToolGuard('memory_reset_project', { host: '127.0.0.1' }), null);
    assert.equal(nonLoopbackToolGuard('memory_delete', { host: '::1' }), null);
    assert.equal(nonLoopbackToolGuard('memory_prune', { host: 'localhost' }), null);
    // An omitted host is unspecified, not loopback: the guard falls back to
    // KIMI_MEMORY_PROXY_HOST and then to the 127.0.0.1 default, so the guard
    // stays off. An empty string is a *wildcard bind* (Node binds `::`), so it
    // must never be classified as loopback.
    assert.equal(nonLoopbackToolGuard('memory_reset_project', {}), null);
    assert.ok(nonLoopbackToolGuard('memory_reset_project', { host: '' }));

    // With the deny-list set, the same loopback bind denies — and an
    // unlisted tool is still untouched.
    process.env.KIMI_MEMORY_PROXY_DENY_TOOLS = 'memory_delete';
    const err = nonLoopbackToolGuard('memory_delete', { host: '127.0.0.1' });
    assert.ok(err, 'the operator deny-list must apply on the default loopback bind');
    assert.ok(err.includes('KIMI_MEMORY_PROXY_DENY_TOOLS'));
    assert.equal(nonLoopbackToolGuard('memory_recall', { host: '127.0.0.1' }), null);
    assert.equal(nonLoopbackToolGuard('memory_reset_project', { host: '127.0.0.1' }), null);
  } finally {
    if (prevDeny === undefined) delete process.env.KIMI_MEMORY_PROXY_DENY_TOOLS;
    else process.env.KIMI_MEMORY_PROXY_DENY_TOOLS = prevDeny;
  }
});

test('nonLoopbackToolGuard: non-loopback hosts deny destructive tools by default', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.10', '', 'localhost.evil.com']) {
    const err = nonLoopbackToolGuard('memory_reset_project', { host });
    assert.ok(err, `host ${JSON.stringify(host)} must deny`);
    assert.ok(err.includes('memory_reset_project'));
    assert.ok(err.includes('KIMI_MEMORY_PROXY_ALLOW_TOOLS'));
  }
});

test('nonLoopbackToolGuard: the whole 127/8 range is loopback', () => {
  // Only 127.0.0.1 used to be recognised; 127.0.0.2 is equally loopback.
  for (const host of ['127.0.0.2', '127.1.2.3', '[::1]', 'localhost.', 'LOCALHOST']) {
    assert.equal(
      nonLoopbackToolGuard('memory_reset_project', { host }),
      null,
      `host ${JSON.stringify(host)} must be treated as loopback`,
    );
  }
});

test('nonLoopbackToolGuard: read tools stay available on non-loopback binds', () => {
  // Non-destructive tools must not be denied — the guard only filters
  // the destructive subset.
  assert.equal(nonLoopbackToolGuard('memory_recall', { host: '0.0.0.0' }), null);
  assert.equal(nonLoopbackToolGuard('memory_list', { host: '0.0.0.0' }), null);
  assert.equal(nonLoopbackToolGuard('memory_get', { host: '0.0.0.0' }), null);
  assert.equal(nonLoopbackToolGuard('memory_save', { host: '0.0.0.0' }), null);
  assert.equal(nonLoopbackToolGuard('memory_status', { host: '0.0.0.0' }), null);
});

test('nonLoopbackToolGuard: operator opt-in via env var lifts the deny', () => {
  const previous = process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS;
  try {
    process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS = 'memory_reset_project,memory_prune';
    assert.equal(
      nonLoopbackToolGuard('memory_reset_project', { host: '0.0.0.0' }),
      null,
      'memory_reset_project opted in',
    );
    assert.equal(
      nonLoopbackToolGuard('memory_prune', { host: '0.0.0.0' }),
      null,
      'memory_prune opted in',
    );
    assert.ok(
      nonLoopbackToolGuard('memory_delete', { host: '0.0.0.0' }),
      'memory_delete still denied (not in allow list)',
    );
  } finally {
    if (previous === undefined) delete process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS;
    else process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS = previous;
  }
});

test('nonLoopbackToolGuard: empty allow list leaves everything denied', () => {
  const previous = process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS;
  try {
    process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS = '';
    assert.ok(nonLoopbackToolGuard('memory_delete', { host: '0.0.0.0' }));
    assert.ok(nonLoopbackToolGuard('acl_grant', { host: '0.0.0.0' }));
    assert.equal(nonLoopbackToolGuard('memory_recall', { host: '0.0.0.0' }), null);
  } finally {
    if (previous === undefined) delete process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS;
    else process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS = previous;
  }
});

test('nonLoopbackToolGuard: KIMI_MEMORY_PROXY_DENY_TOOLS wins over ALLOW_TOOLS', () => {
  const prevAllow = process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS;
  const prevDeny = process.env.KIMI_MEMORY_PROXY_DENY_TOOLS;
  try {
    process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS = 'memory_reset_project,memory_prune';
    process.env.KIMI_MEMORY_PROXY_DENY_TOOLS = 'memory_reset_project';
    // The deny-list overrides the allow-list.
    const err = nonLoopbackToolGuard('memory_reset_project', { host: '0.0.0.0' });
    assert.ok(err && err.includes('KIMI_MEMORY_PROXY_DENY_TOOLS'));
    // A non-denylisted tool still passes through the allow-list.
    assert.equal(nonLoopbackToolGuard('memory_prune', { host: '0.0.0.0' }), null);
    // Non-destructive tools are unaffected.
    assert.equal(nonLoopbackToolGuard('memory_recall', { host: '0.0.0.0' }), null);
  } finally {
    if (prevAllow === undefined) delete process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS;
    else process.env.KIMI_MEMORY_PROXY_ALLOW_TOOLS = prevAllow;
    if (prevDeny === undefined) delete process.env.KIMI_MEMORY_PROXY_DENY_TOOLS;
    else process.env.KIMI_MEMORY_PROXY_DENY_TOOLS = prevDeny;
  }
});

test('nonLoopbackToolGuard: deny-list applies to non-destructive tools too', () => {
  const prevDeny = process.env.KIMI_MEMORY_PROXY_DENY_TOOLS;
  try {
    process.env.KIMI_MEMORY_PROXY_DENY_TOOLS = 'memory_recall';
    const err = nonLoopbackToolGuard('memory_recall', { host: '0.0.0.0' });
    assert.ok(err && err.includes('KIMI_MEMORY_PROXY_DENY_TOOLS'));
  } finally {
    if (prevDeny === undefined) delete process.env.KIMI_MEMORY_PROXY_DENY_TOOLS;
    else process.env.KIMI_MEMORY_PROXY_DENY_TOOLS = prevDeny;
  }
});

test('startProxy: refuses to start on a non-loopback host without KIMI_MEMORY_PROXY_REQUIRE_HTTPS', async () => {
  const prev = process.env.KIMI_MEMORY_PROXY_REQUIRE_HTTPS;
  try {
    delete process.env.KIMI_MEMORY_PROXY_REQUIRE_HTTPS;
    const { startProxy } = await import('../src/proxy/server.js');
    await assert.rejects(
      () =>
        startProxy({
          host: '0.0.0.0',
          port: 0,
          kimiHomeDir: process.env.KIMI_CODE_HOME,
          pluginRootDir: process.cwd(),
          authToken: 'tok',
        }),
      /refusing to start/,
    );
  } finally {
    if (prev === undefined) delete process.env.KIMI_MEMORY_PROXY_REQUIRE_HTTPS;
    else process.env.KIMI_MEMORY_PROXY_REQUIRE_HTTPS = prev;
  }
});

test('startProxy: KIMI_MEMORY_PROXY_REQUIRE_HTTPS=off lets the operator opt in to cleartext', async () => {
  const prev = process.env.KIMI_MEMORY_PROXY_REQUIRE_HTTPS;
  try {
    process.env.KIMI_MEMORY_PROXY_REQUIRE_HTTPS = 'off';
    const { startProxy } = await import('../src/proxy/server.js');
    const proxy = await startProxy({
      host: '127.0.0.1',
      port: 0,
      kimiHomeDir: process.env.KIMI_CODE_HOME,
      pluginRootDir: process.cwd(),
      authToken: 'tok',
    });
    try {
      assert.equal(proxy.host, '127.0.0.1');
    } finally {
      await proxy.close();
    }
  } finally {
    if (prev === undefined) delete process.env.KIMI_MEMORY_PROXY_REQUIRE_HTTPS;
    else process.env.KIMI_MEMORY_PROXY_REQUIRE_HTTPS = prev;
  }
});
