import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { guardLlmBaseUrl, resolveLlmTarget } from '../src/extract.js';

// The base-URL guard is synchronous and offline by contract (tests/43 and
// tests/69 have 20+ synchronous call sites), so its pure half only judges
// literal IPs and the bare name `localhost`. These pin the two blocks the
// table was missing — CGNAT (100.64/10, RFC 6598) and benchmarking
// (198.18/15, RFC 2544), both routable to internal services on real
// networks — on and just outside their boundaries.
test('guardLlmBaseUrl refuses the CGNAT and benchmarking blocks', () => {
  assert.equal(guardLlmBaseUrl('https://100.64.0.1/v1').ok, false);
  assert.equal(guardLlmBaseUrl('https://100.127.255.254/v1').ok, false);
  assert.equal(guardLlmBaseUrl('https://198.18.0.1/v1').ok, false);
  assert.equal(guardLlmBaseUrl('https://198.19.255.254/v1').ok, false);

  // One octet outside each block stays public, so the range test is a
  // range test and not a blunt "starts with 100 / 198".
  assert.equal(guardLlmBaseUrl('https://100.63.255.254/v1').ok, true);
  assert.equal(guardLlmBaseUrl('https://100.128.0.1/v1').ok, true);
  assert.equal(guardLlmBaseUrl('https://198.17.0.1/v1').ok, true);
  assert.equal(guardLlmBaseUrl('https://198.20.0.1/v1').ok, true);
});

// One home per config: readConfig caches a parsed config.toml per homeDir
// for 30 s, so rewriting the file in place would serve the stale config.
function homeWithBaseUrl(baseUrl) {
  const home = mkdtempSync(path.join(tmpdir(), 'pm-ssrf-'));
  writeFileSync(
    path.join(home, 'config.toml'),
    [
      'default_model = "m"',
      '[models.m]',
      'provider = "p"',
      '[providers.p]',
      'type = "openai"',
      'api_key = "k"',
      `base_url = "${baseUrl}"`,
      '',
    ].join('\n'),
  );
  return home;
}

// The other half of that defect: a NAME that resolves to loopback passed
// the pure guard entirely (`https://127.0.0.1.nip.io/`, `https://localtest.me/`).
// resolveLlmTarget resolves the host at the single network boundary and
// refuses anything that maps to a private address, and refuses to proceed
// when the name cannot be resolved at all — the path is opt-in, so failing
// closed costs nothing.
test('resolveLlmTarget fails closed on an unresolvable provider host', async () => {
  const prev = process.env.KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS;
  process.env.KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS = '1';
  // RFC 2606 reserves .invalid for exactly this: it can never resolve, so
  // the refusal is deterministic with or without a working resolver.
  const unresolvable = homeWithBaseUrl('https://no-such-provider.invalid/v1');
  const literalPrivate = homeWithBaseUrl('https://198.18.0.1/v1');
  try {
    const target = await resolveLlmTarget(unresolvable);
    assert.match(String(target.error), /^base_url_unresolvable:/);
    assert.equal(target.baseUrl, 'https://no-such-provider.invalid/v1');
    assert.equal(target.provider, undefined, 'no provider is returned on a refusal');

    // A literal private address is refused by the pure half, before any
    // resolution is attempted.
    const blocked = await resolveLlmTarget(literalPrivate);
    assert.equal(blocked.error, 'base_url_blocked:private_host:198.18.0.1');
  } finally {
    if (prev === undefined) delete process.env.KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS;
    else process.env.KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS = prev;
    rmSync(unresolvable, { recursive: true, force: true });
    rmSync(literalPrivate, { recursive: true, force: true });
  }
});

// The resolution branch itself, driven through the lookupImpl seam so the
// three outcomes are exercised without depending on real DNS.
test('resolveLlmTarget judges every address a name resolves to', async () => {
  const prev = process.env.KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS;
  process.env.KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS = '1';
  const home = homeWithBaseUrl('https://provider.example/v1');
  try {
    // A name that maps to BOTH a public and a loopback address is refused:
    // the mixed answer is the attacker's, not the operator's.
    const mixed = await resolveLlmTarget(home, {
      lookupImpl: async () => [
        { address: '203.0.113.10', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    assert.equal(mixed.error, 'base_url_blocked:private_host:provider.example');

    // IPv6 is judged by the same table (fc00::/7 is unique-local).
    const ula = await resolveLlmTarget(home, {
      lookupImpl: async () => [{ address: 'fd00::1', family: 6 }],
    });
    assert.equal(ula.error, 'base_url_blocked:private_host:provider.example');

    // A genuinely public answer passes and yields a usable target.
    const publicName = await resolveLlmTarget(home, {
      lookupImpl: async () => [{ address: '203.0.113.10', family: 4 }],
    });
    assert.equal(publicName.error, undefined);
    assert.equal(publicName.provider, 'p');
    assert.equal(publicName.baseUrl, 'https://provider.example/v1');

    // An empty answer is not a working provider either.
    const empty = await resolveLlmTarget(home, { lookupImpl: async () => [] });
    assert.equal(empty.error, 'base_url_unresolvable:provider.example');
  } finally {
    if (prev === undefined) delete process.env.KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS;
    else process.env.KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// A resolver that never answers must not hold the Stop pass open: the
// resolution is bounded, and expiry is refused the same way an NXDOMAIN is.
// This runs on the Stop path before the ingest-state write
// (src/hooks/handlers/stop.js:100-105), so an unbounded getaddrinfo would
// cost the session cursor, not just the extraction.
test('a resolver that never answers is bounded and refused', async () => {
  const prev = process.env.KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS;
  process.env.KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS = '1';
  const home = homeWithBaseUrl('https://provider.example/v1');
  try {
    const startedAt = Date.now();
    const target = await resolveLlmTarget(home, { lookupImpl: () => new Promise(() => {}) });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(target.error, 'base_url_unresolvable:provider.example');
    assert.ok(elapsedMs >= 1900, `must wait for the bound, not answer early (${elapsedMs}ms)`);
    assert.ok(elapsedMs < 6000, `must give up inside the bound (${elapsedMs}ms)`);
  } finally {
    if (prev === undefined) delete process.env.KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS;
    else process.env.KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
