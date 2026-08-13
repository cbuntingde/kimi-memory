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
