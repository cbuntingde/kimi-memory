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
  // shell: false (the default) and windowsVerbatimArguments: true so the
  // argument vector is passed verbatim — without shell:true a future
  // arg that contains `&` or `|` would never be misinterpreted, and
  // we never pick up npm's `npm_config_*` env-var expansion. The fixed
  // binary path and fixed arg list make this call safe.
  const result = spawnSync(
    npm,
    ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    {
      cwd: pluginRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: false,
      windowsVerbatimArguments: true,
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
