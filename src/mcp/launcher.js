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
  // On Windows, .cmd / .bat files require `shell: true` — without it
  // Node's child_process throws EINVAL before execve is ever called,
  // surfacing as `spawnSync npm.cmd EINVAL` and killing the plugin
  // bootstrap with an MCP "Connection closed" error. The hard-coded
  // binary path and the static argument vector below keep `shell: true`
  // safe (no user input reaches the command line). On non-Windows
  // platforms the default shell-less path applies.
  //
  // `--ignore-scripts` is a deliberate hardening measure — without it,
  // every transitive dependency's postinstall runs in the install
  // path, which is a known supply-chain risk. The trade-off is that
  // packages whose postinstall unpacks a prebuilt native binary
  // (`onnxruntime-node@1.24.3` via @huggingface/transformers, and
  // `protobufjs@7.6.5`) are left with their `.node` files still
  // inside the tarball. `npm rebuild <pkg>` re-runs ONLY the named
  // package's install lifecycle — so we keep the rest of the tree
  // scripts-off and explicitly opt these two in. This matches the
  // `package.json#allowScripts` whitelist (which is pnpm-only and
  // has no effect on npm).
  const result = spawnSync(
    npm,
    ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    {
      cwd: pluginRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: process.platform === 'win32',
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

  // Re-run the postinstall lifecycle for the two packages whose
  // prebuilt native binaries were skipped by `--ignore-scripts`.
  // Hard-coded names — no user input reaches this call.
  const rebuildResult = spawnSync(
    npm,
    ['rebuild', 'onnxruntime-node', 'protobufjs'],
    {
      cwd: pluginRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: process.platform === 'win32',
    },
  );

  if (rebuildResult.error) {
    process.stderr.write(`[kimi-memory] native rebuild failed: ${rebuildResult.error.message}\n`);
    process.exit(1);
  }
  if (rebuildResult.status !== 0) {
    process.stderr.write(`[kimi-memory] native rebuild exited with status ${rebuildResult.status}\n`);
    process.exit(rebuildResult.status || 1);
  }
}

await import('./main.js');
