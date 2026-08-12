#!/usr/bin/env node
// Syntax-check every .js file under src/ and hooks/ using node --check.
// Replaces the previous hand-maintained &&-chained list in package.json,
// which had drifted out of sync with the actual tree (referenced
// src/concurrency.js and src/search.js that no longer exist).
//
// Skip node_modules and this script's own directory. Failures are
// reported file-by-file so the first failing file is immediately visible.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'scripts', 'assets']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.js') && stat.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const targets = [];
for (const top of ['src', 'hooks', 'tests']) {
  const abs = path.join(ROOT, top);
  try {
    walk(abs, targets);
  } catch {
    // Missing directory — skip silently. Don't fail the check
    // just because the repo doesn't have a top-level dir today.
  }
}
targets.sort();

if (targets.length === 0) {
  console.error('check-syntax: no .js files found under src/, hooks/, or tests/');
  process.exit(2);
}

let failed = 0;
for (const file of targets) {
  const rel = path.relative(ROOT, file);
  const res = spawnSync(process.execPath, ['--check', file], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (res.status === 0) {
    console.log(`  ok  ${rel}`);
  } else {
    failed++;
    console.error(`FAIL  ${rel}`);
    if (res.stderr) console.error(res.stderr.trim());
  }
}

console.log(`\nchecked ${targets.length} files, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
