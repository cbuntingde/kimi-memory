// Regression test for the Windows "spawnSync npm.cmd EINVAL" bootstrap
// failure that surfaced as
//   MCP server "plugin-kimi-memory:kimi-memory" failed: MCP error -32000:
//   Connection closed
//   stderr: [kimi-memory] dependency install failed: spawnSync npm.cmd EINVAL
//
// On Windows, .cmd / .bat files require `shell: true`; without it Node
// throws EINVAL before execve is reached. The launcher must set
// `shell: process.platform === 'win32'` and must not set
// `windowsVerbatimArguments` (which is only meaningful with `shell:
// false` and is a Windows-only concern that no longer applies once we
// route through cmd.exe on Windows).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const LAUNCHER = path.resolve(path.dirname(__filename), '..', 'src', 'mcp', 'launcher.js');

test('launcher pins shell to true on Windows for the npm ci bootstrap', () => {
  const src = readFileSync(LAUNCHER, 'utf8');
  // The exact platform-aware shell setting that fixes EINVAL on Windows
  // while keeping the standard shell-less path on Linux/macOS.
  assert.match(
    src,
    /shell:\s*process\.platform\s*===\s*['"]win32['"]/,
    'launcher must set shell:true when running on Windows',
  );
});

test('launcher does not pass windowsVerbatimArguments', () => {
  const src = readFileSync(LAUNCHER, 'utf8');
  assert.ok(
    !/windowsVerbatimArguments/.test(src),
    'launcher should not set windowsVerbatimArguments (it only matters with shell:false)',
  );
});

test('spawning npm with the same shell flag as the launcher does not EINVAL', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(npm, ['--version'], {
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  assert.ok(
    !res.error,
    `spawning npm with shell:${process.platform === 'win32'} must not fail: ${res.error && res.error.message}`,
  );
  assert.equal(res.status, 0, 'npm --version should exit 0');
  assert.match((res.stdout || '').trim(), /\d+\.\d+\.\d+/, 'npm --version should print a semver');
});
