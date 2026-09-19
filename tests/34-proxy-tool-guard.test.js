// Tests for the proxy non-loopback tool guard.
//
// (Prior audit flag F-003 — a network bind with a single shared bearer
// token is a network-wide admin path. Default-deny the destructive
// tools on non-loopback binds; let the operator opt in.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nonLoopbackToolGuard } from '../src/proxy/server.js';

test('nonLoopbackToolGuard: loopback hosts bypass the guard entirely', () => {
  assert.equal(nonLoopbackToolGuard('memory_reset_project', { host: '127.0.0.1' }), null);
  assert.equal(nonLoopbackToolGuard('memory_delete', { host: '::1' }), null);
  assert.equal(nonLoopbackToolGuard('memory_prune', { host: 'localhost' }), null);
  // Empty / undefined defaults to loopback (the safe default).
  assert.equal(nonLoopbackToolGuard('memory_reset_project', { host: '' }), null);
  assert.equal(nonLoopbackToolGuard('memory_reset_project', {}), null);
});

test('nonLoopbackToolGuard: non-loopback hosts deny destructive tools by default', () => {
  const err = nonLoopbackToolGuard('memory_reset_project', { host: '0.0.0.0' });
  assert.ok(err && err.includes('memory_reset_project'));
  assert.ok(err.includes('KIMI_MEMORY_PROXY_ALLOW_TOOLS'));
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
