#!/usr/bin/env node
// Backfill embeddings CLI. Walks every memory.sqlite under
// $KIMI_CODE_HOME/kimi-memory/, computes embeddings for rows that
// don't have one, and writes them back. Idempotent — safe to re-run.
//
// Usage:
//   npm run backfill-embeddings                # one pass
//   npm run backfill-embeddings -- --force     # also re-embed rows that already have one
//   npm run backfill-embeddings -- --quiet     # only print summary
//
// On first run the embedding model (~25 MB) downloads from
// Hugging Face. Set KIMI_MEMORY_EMBEDDINGS=off to skip entirely.
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { kimiHome } from './util.js';
import {
  projectDbPath,
  globalDbPath,
  deriveProjectKey,
  GLOBAL_PROJECT_KEY,
} from './project-key.js';
import { openDb, closeDb, backfillEmbeddings } from './persist.js';

function parseArgs(argv) {
  const out = { force: false, quiet: false };
  for (const a of argv.slice(2)) {
    if (a === '--force') out.force = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node src/backfill.js [--force] [--quiet]');
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const home = kimiHome();
  const base = path.join(home, 'kimi-memory');

  let projectKeys = [];
  try {
    const entries = readdirSync(base, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === '_global' || e.name === '_diagnostics') continue;
      const dbPath = path.join(base, e.name, 'memory.sqlite');
      try {
        if (statSync(dbPath).isFile()) projectKeys.push(e.name);
      } catch {
        /* missing */
      }
    }
  } catch (e) {
    console.error(`cannot read ${base}: ${e.message}`);
    process.exit(2);
  }

  // We treat each subdir name as the project_key directly (the same
  // convention used by discoverScopes in the dashboard). The
  // canonical hash is what openDb expects — but for the backfill
  // CLI we just want to walk every SQLite file we can find. The
  // persist layer doesn't care about the key value here because
  // backfillEmbeddings only touches rows whose project_key column
  // matches the key we pass.
  const targets = [];
  // Global DB uses the literal "_global" key.
  try {
    if (statSync(globalDbPath(home)).isFile()) {
      targets.push({ dbPath: globalDbPath(home), key: GLOBAL_PROJECT_KEY, label: '_global' });
    }
  } catch {
    /* no global yet */
  }
  for (const k of projectKeys) {
    targets.push({ dbPath: projectDbPath(home, k), key: k, label: k });
  }

  if (!args.quiet) {
    console.log(`[kimi-memos backfill] scanning ${targets.length} database(s) under ${base}`);
  }

  const totals = { scanned: 0, embedded: 0, skipped: 0, failed: 0 };
  for (const t of targets) {
    const db = openDb(t.dbPath);
    try {
      const r = await backfillEmbeddings(db, t.key, { force: args.force });
      totals.scanned += r.scanned;
      totals.embedded += r.embedded;
      totals.skipped += r.skipped;
      totals.failed += r.failed;
      if (!args.quiet) {
        console.log(
          `  ${t.label}: scanned=${r.scanned} embedded=${r.embedded} skipped=${r.skipped} failed=${r.failed}`,
        );
      }
    } finally {
      // closeDb() (vs raw db.close()) also evicts the cached handle
      // from persist.js's path-keyed map, so a later openDb(dbPath)
      // returns a fresh handle. Without it, the next caller inherits
      // the closed DatabaseSync.
      try {
        closeDb(t.dbPath);
      } catch {
        /* ignore */
      }
    }
  }
  closeDb();

  console.log(
    `[kimi-memos backfill] total: scanned=${totals.scanned} embedded=${totals.embedded} skipped=${totals.skipped} failed=${totals.failed}`,
  );
  if (totals.failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('[kimi-memos backfill] fatal:', e && e.stack ? e.stack : e);
  process.exit(2);
});
