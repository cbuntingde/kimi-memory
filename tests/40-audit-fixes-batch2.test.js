// Regression tests for the audit-fix batch applied after the v0.5.1
// review. Each test targets one specific Tier 2 finding so a future
// regression points back to the audit it came from. Pure unit tests
// where possible — no DB, no FS, no MCP — so they run in a few ms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeErrorMessage } from '../src/util.js';

test('safeErrorMessage: strips absolute paths', () => {
  const err = new Error('failed to open /Users/alice/.kimi-code/kimi-memory/foo/bar.sqlite');
  const out = safeErrorMessage(err);
  assert.equal(out.includes('/Users/alice'), false, 'POSIX path component is stripped');
  assert.equal(out.includes('<path>'), true, 'placeholder is present');
});

test('safeErrorMessage: strips Windows paths', () => {
  const err = new Error('cannot read C:\\Users\\alice\\kimi-memory\\db.sqlite');
  const out = safeErrorMessage(err);
  assert.equal(out.includes('C:\\Users'), false, 'Windows path is stripped');
  assert.equal(out.includes('<path>'), true, 'placeholder is present');
});

test('safeErrorMessage: strips host:port fragments', () => {
  const err = new Error('connect ECONNREFUSED 10.0.0.1:7331');
  const out = safeErrorMessage(err);
  assert.equal(out.includes('10.0.0.1'), false, 'host:port is stripped');
  assert.equal(out.includes('<addr>'), true, 'placeholder is present');
});

test('safeErrorMessage: strips scheme:// URLs', () => {
  const err = new Error('fetch failed: https://huggingface.co/api/models');
  const out = safeErrorMessage(err);
  assert.equal(out.includes('huggingface.co'), false, 'scheme URL is stripped');
  assert.equal(out.includes('<url>'), true, 'placeholder is present');
});

test('safeErrorMessage: returns "unknown error" for empty / null / non-string input', () => {
  assert.equal(safeErrorMessage(null), 'unknown error');
  assert.equal(safeErrorMessage(undefined), 'unknown error');
  assert.equal(safeErrorMessage(''), 'unknown error');
  assert.equal(safeErrorMessage({ message: '' }), 'unknown error');
});

test('safeErrorMessage: truncates very long messages', () => {
  const long = 'x'.repeat(5000);
  const out = safeErrorMessage(new Error(long));
  assert.ok(out.length <= 201, 'output is bounded near 200 chars');
  assert.match(out, /…$/, 'truncation marker is present');
});

test('safeErrorMessage: passes clean messages through unchanged', () => {
  const msg = 'connection refused by upstream';
  assert.equal(safeErrorMessage(new Error(msg)), msg);
  assert.equal(safeErrorMessage(msg), msg);
});
