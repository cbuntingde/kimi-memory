// Tests for guardLlmBaseUrl — the opt-in SSRF guard on the auto-extract
// provider base URL. The guard only fires when the operator sets
// `KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS=1`, but the predicate itself
// is pure and worth pinning so a future refactor cannot silently weaken
// the blocklist. (Production-readiness review finding F-6.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardLlmBaseUrl } from '../src/extract.js';

test('guardLlmBaseUrl: public https is always accepted', () => {
  for (const url of [
    'https://api.openai.com/v1',
    'https://api.anthropic.com',
    'https://generativelanguage.googleapis.com/v1beta',
    'https://api.example.com:8443/v1',
  ]) {
    const r = guardLlmBaseUrl(url);
    assert.equal(r.ok, true, `public https URL should pass: ${url}`);
  }
});

test('guardLlmBaseUrl: cleartext http to loopback / private is blocked', () => {
  for (const url of [
    'http://127.0.0.1:8080/v1',
    'http://localhost:5000/v1',
    'http://10.0.0.5:5000/v1',
    'http://192.168.1.42/v1',
    'http://172.16.5.5/v1',
    'http://169.254.169.254/latest/meta-data/',
  ]) {
    const r = guardLlmBaseUrl(url);
    assert.equal(r.ok, false, `cleartext local URL should be blocked: ${url}`);
    assert.match(r.reason, /cleartext_local/);
  }
});

test('guardLlmBaseUrl: cleartext http to a public host is permitted', () => {
  // Operators who terminate TLS at a sibling LB should still be able
  // to point at a public host over http://.
  const r = guardLlmBaseUrl('http://api.example.com/v1');
  assert.equal(r.ok, true, 'public cleartext http is permitted');
});

test('guardLlmBaseUrl: non-http(s) schemes are refused outright', () => {
  for (const url of [
    'file:///etc/passwd',
    'ssh://example.com',
    'ftp://example.com/v1',
    'javascript:alert(1)',
    '',
    null,
    undefined,
  ]) {
    const r = guardLlmBaseUrl(url);
    assert.equal(r.ok, false, `non-http URL should be blocked: ${String(url).slice(0, 30)}`);
  }
});

test('guardLlmBaseUrl: unparseable input is refused', () => {
  const r = guardLlmBaseUrl('not a url');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unparseable_url');
});
