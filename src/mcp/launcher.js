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
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npm,
    ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    {
      cwd: pluginRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: false,
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
