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

test('guardLlmBaseUrl: cleartext http to a public host is refused too', () => {
  // REQUIRE_HTTPS means exactly that: the operator who sets it is asking
  // for TLS on every request, so the old "public http is fine" carve-out
  // (which let http://api.example.com through) is gone.
  const r = guardLlmBaseUrl('http://api.example.com/v1');
  assert.equal(r.ok, false, 'cleartext http is refused regardless of the host');
  assert.match(r.reason, /cleartext_http/);
});

test('guardLlmBaseUrl: the whole loopback / private / link-local space is blocked', () => {
  // Every entry below reaches the private-host predicate. The IPv4 spellings
  // (decimal, octal, hex, short form, userinfo) are already normalised by
  // Node's URL parser — pinned here so a future hand-rolled host parser
  // cannot regress them. The IPv6 entries keep their bracket form in
  // `url.hostname`, which the previous exact-match check never handled.
  for (const url of [
    'http://127.0.0.2/',
    'http://127.1.2.3/',
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://0x7f000001/',
    'http://127.1/',
    'http://user@127.0.0.1/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fc00::1]/',
    'http://[fd12::1]/',
    'http://[fe80::1]/',
    'http://[::]/',
    'http://localhost./',
  ]) {
    const r = guardLlmBaseUrl(url);
    assert.equal(r.ok, false, `internal address should be blocked: ${url}`);
    assert.match(r.reason, /cleartext_local|private_host/, `wrong reason for ${url}`);
  }
});

test('guardLlmBaseUrl: a private host is refused over https as well', () => {
  // The guard is about the target, not the wire format: an SSRF sink like
  // the cloud metadata endpoint is not made legitimate by TLS, and the
  // redirect guard is a separate control.
  for (const url of [
    'https://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1:8443/v1',
    'https://[::ffff:169.254.169.254]/',
    'https://localhost/v1',
  ]) {
    const r = guardLlmBaseUrl(url);
    assert.equal(r.ok, false, `private https target should be blocked: ${url}`);
    assert.match(r.reason, /^private_host:/, `wrong reason for ${url}`);
  }
});

test('guardLlmBaseUrl: public https hostnames and IPs are still accepted', () => {
  for (const url of [
    'https://api.example.com/v1',
    'https://8.8.8.8/v1',
    'https://[2606:4700:4700::1111]/v1',
    'https://localhost.example.com/v1',
  ]) {
    assert.equal(guardLlmBaseUrl(url).ok, true, `public https should pass: ${url}`);
  }
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
