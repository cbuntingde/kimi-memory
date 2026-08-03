#!/usr/bin/env node

// Kimi installs plugin files but does not run npm install. Bootstrap runtime
// dependencies immediately before loading the MCP server so a GitHub install
// is usable without a second manual setup step.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const requiredPackages = [
  '@modelcontextprotocol/sdk/package.json',
  '@huggingface/transformers/package.json',
  'zod/package.json',
];

if (requiredPackages.some((file) => !existsSync(path.join(pluginRoot, 'node_modules', file)))) {
  const isWin = process.platform === 'win32';
  // On Windows, npm ships as `npm.cmd`. Node >=18 refuses to spawn a
  // .cmd / .bat shim without `shell: true` (CVE-2024-27980 mitigation),
  // which surfaces as `spawnSync EINVAL`. Args below are static, so the
  // shell interpolation is safe.
  const npm = isWin ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npm,
    ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    {
      cwd: pluginRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: isWin,
    },
  );

  if (result.error) {
    process.stderr.write(`[kimi-memory] dependency install failed: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(`[kimi-memory] dependency install exited with status ${result.status}\n`);
    process.exit(result.status || 1);
  }
}

await import('./main.js');
