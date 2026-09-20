// Two independent hardening defects.
//
// A. `saveIngestState` staged every write through one fixed temp path per
//    project, so two overlapping hook processes (a Stop still running when
//    the next UserPromptSubmit fires) wrote the same staging file and then
//    renamed each other's bytes into place — dropping the loser's session
//    cursor, or failing outright with EPERM on Windows.
//
// B. The SSRF guard's IPv6 classifier only knew ::ffff:<v4>, while its
//    docstring claimed that covered every non-public shape. NAT64
//    (64:ff9b::/96) and SIIT (::ffff:0:0:0/96) wrap an IPv4 address too,
//    so `64:ff9b::a9fe:a9fe` reached the guard as "public".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { guardLlmBaseUrl, isPrivateIpv6 } from '../src/extract.js';
import { saveIngestState, loadIngestState } from '../src/persist/project.js';
import { ingestStatePath } from '../src/project-key.js';
import { mkTempHome, rmRf } from './_helpers.js';

// ----- A. ingest-state temp-file collision -----

test('saveIngestState: concurrent writers stage through distinct temp files', async () => {
  const home = mkTempHome();
  const key = 'raceproject';
  const realWriteFile = fs.writeFile;
  const staged = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  // The first writer is parked inside writeFile until the second has
  // finished its whole write-and-rename. That is the shape of the real
  // overlap — a Stop hook still staging while the next UserPromptSubmit
  // has already published — and it keeps the two renames from racing onto
  // the same destination, which on Windows is a separate EPERM source.
  fs.writeFile = async (file, data, ...rest) => {
    staged.push(String(file));
    if (staged.length === 1) await gate;
    return realWriteFile.call(fs, file, data, ...rest);
  };
  const stateA = { sessions: { a: { session_id: 'a', line: 1 } } };
  const stateB = { sessions: { b: { session_id: 'b', line: 2 } } };
  try {
    // `a` is started first and is therefore the parked writer: wait until
    // it has reached writeFile before starting `b`.
    const a = saveIngestState(home, key, stateA);
    for (let i = 0; i < 400 && staged.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(staged.length, 1, 'the first writer must reach the staging write');
    const b = saveIngestState(home, key, stateB);
    await b;
    release();
    await a;
  } finally {
    fs.writeFile = realWriteFile;
  }
  try {
    assert.notEqual(
      staged[0],
      staged[1],
      'each writer needs its own staging path; a shared one lets one process rename the other process bytes',
    );
    const dest = ingestStatePath(home, key);
    for (const file of staged)
      assert.notEqual(file, dest, 'staging must not be the destination itself');
    // The destination holds one complete state, never a splice of both.
    const final = JSON.parse(await fs.readFile(dest, 'utf8'));
    assert.deepEqual(
      final,
      stateA,
      'the later writer wins with its own bytes, not the earlier writer staging',
    );
    const leftovers = readdirSync(path.dirname(dest)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'a successful save leaves no staging file behind');
  } finally {
    rmRf(home);
  }
});

test('saveIngestState: an occupied legacy ".tmp" path does not block the write', async () => {
  const home = mkTempHome();
  const key = 'squatproject';
  try {
    const dest = ingestStatePath(home, key);
    mkdirSync(`${dest}.tmp`, { recursive: true });
    await saveIngestState(home, key, { sessions: { s1: { session_id: 's1', line: 7 } } });
    const state = await loadIngestState(home, key);
    assert.equal(state.sessions.s1.line, 7, 'the write must not depend on the fixed temp name');
  } finally {
    rmRf(home);
  }
});

// ----- B. IPv6 SSRF classification -----

test('guardLlmBaseUrl: IPv4-in-IPv6 wrappers are judged by the embedded IPv4', () => {
  for (const [url, why] of [
    ['https://[::ffff:169.254.169.254]/latest/meta-data/', 'IPv4-mapped metadata'],
    ['https://[::ffff:127.0.0.1]:8443/v1', 'IPv4-mapped loopback'],
    ['https://[::ffff:10.0.0.5]/v1', 'IPv4-mapped private'],
    ['https://[::ffff:0:127.0.0.1]/v1', 'SIIT / IPv4-translated loopback'],
    ['https://[::ffff:0:169.254.169.254]/v1', 'SIIT / IPv4-translated metadata'],
    ['https://[64:ff9b::a9fe:a9fe]/v1', 'NAT64 metadata 169.254.169.254'],
    ['https://[64:ff9b:0:0:0:0:a9fe:a9fe]/v1', 'NAT64 metadata, fully expanded'],
    ['https://[64:ff9b::127.0.0.1]/v1', 'NAT64 loopback'],
    ['https://[64:ff9b::a00:5]/v1', 'NAT64 private 10.0.0.5'],
  ]) {
    const r = guardLlmBaseUrl(url);
    assert.equal(r.ok, false, `should be blocked (${why}): ${url}`);
    assert.match(r.reason, /^private_host:/, `wrong reason for ${url}`);
  }
});

test('guardLlmBaseUrl: non-2000::/3 IPv6 shapes are non-public', () => {
  for (const url of [
    'https://[::1]/v1',
    'https://[::]/v1',
    'https://[::2]/v1',
    'https://[::127.0.0.1]/v1',
    'https://[fc00::1]/v1',
    'https://[fd12:3456:789a::1]/v1',
    'https://[fe80::1]/v1',
    'https://[ff02::1]/v1',
    'https://[fec0::1]/v1',
    'https://[64:ff9b::a9fe:a9fe]:8080/v1',
  ]) {
    const r = guardLlmBaseUrl(url);
    assert.equal(r.ok, false, `internal IPv6 should be blocked: ${url}`);
    assert.match(r.reason, /^private_host:/, `wrong reason for ${url}`);
  }
});

test('isPrivateIpv6: only global unicast 2000::/3 is public without an IPv4 tail', () => {
  for (const addr of ['::1', '::', 'fc00::1', 'fe80::1', 'ff02::1']) {
    assert.equal(isPrivateIpv6(addr), true, `${addr} is not public`);
  }
  for (const addr of ['2606:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:80b::200e']) {
    assert.equal(isPrivateIpv6(addr), false, `${addr} is public global unicast`);
  }
});

test('guardLlmBaseUrl: genuinely public IPv6 and public IPv4 tails still pass', () => {
  for (const url of [
    'https://[2606:4700:4700::1111]/v1',
    'https://[2001:4860:4860::8888]/v1',
    'https://[::ffff:8.8.8.8]/v1',
    'https://[64:ff9b::808:808]/v1',
  ]) {
    assert.equal(guardLlmBaseUrl(url).ok, true, `public target should pass: ${url}`);
  }
});
