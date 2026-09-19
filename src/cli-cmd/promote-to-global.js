// CLI: promote one or more project memories to the cross-project
// _global store. Use when auto-extract (Fix 1) under-classified a fact
// or when the operator is reconciling a project cache.
//
// Dry run by default; pass --apply to actually move the rows. The
// source rows are removed from the project DB; the rows are rewritten
// into _global/memory.sqlite with project_key='_global'. The id is
// preserved across the move.
//
//   node src/cli.js promote-to-global --memory-id <id> [--memory-id <id> ...] [--cwd <path>] [--apply] [--json]
//   node src/cli.js promote-to-global --memory-ids <csv>            [--cwd <path>] [--apply] [--json]
import { openDb, closeDb, getMemory, promoteMemoryToGlobal } from '../persist.js';
import { deriveProjectKey, projectDbPath } from '../project-key.js';
import { homeDir, resolveCwd, emitJson } from '../cli/lib.js';

export async function cmdPromoteToGlobal(args) {
  const home = homeDir(args);
  const cwd = resolveCwd(args);
  if (!cwd) {
    process.stderr.write('error: --cwd is required for promote-to-global\n');
    process.exit(1);
  }
  const asJson = !!args.flags.json;
  const apply = !!args.flags.apply;
  // Collect ids from both --memory-id (repeatable) and --memory-ids (csv).
  const ids = [];
  if (Array.isArray(args.flags['memory-id'])) {
    for (const v of args.flags['memory-id']) ids.push(String(v));
  } else if (typeof args.flags['memory-id'] === 'string') {
    ids.push(args.flags['memory-id']);
  }
  if (typeof args.flags['memory-ids'] === 'string') {
    for (const v of args.flags['memory-ids']
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      ids.push(v);
    }
  }
  // Also accept positional ids.
  for (const v of args.positional || []) ids.push(String(v));
  // Dedupe while preserving order.
  const seen = new Set();
  const uniqueIds = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }
  if (uniqueIds.length === 0) {
    process.stderr.write('error: at least one --memory-id is required\n');
    process.exit(1);
  }
  for (const id of uniqueIds) {
    if (id.length < 4 || id.length > 64) {
      process.stderr.write(`error: invalid memory id length: ${id}\n`);
      process.exit(1);
    }
  }
  const key = deriveProjectKey(cwd);
  const dbPath = projectDbPath(home, key);
  const db = openDb(dbPath);
  // Dry run: print the rows that WOULD be moved and exit without
  // touching either DB. The agent or operator reads this and
  // decides whether to invoke with --apply.
  if (!apply) {
    const found = [];
    const missing = [];
    for (const id of uniqueIds) {
      const row = getMemory(db, key, id);
      if (!row) missing.push(id);
      else {
        found.push({
          id: row.id,
          type: row.type,
          title: row.title,
          tags: row.tags,
        });
      }
    }
    const out = {
      operation: 'promote_to_global_dry_run',
      project_key: key,
      cwd,
      would_move: found,
      missing,
      note: 'dry run: nothing was moved. Pass --apply to move the listed rows into the cross-project _global store. The source rows are deleted from the project DB; the global DB is created on first move if it does not exist.',
    };
    if (asJson) emitJson(out);
    else {
      process.stdout.write(`project_key=${key} cwd=${cwd}\n`);
      process.stdout.write(`would_move=${found.length}\n`);
      for (const r of found) {
        process.stdout.write(`  - ${r.id} (${r.type}) ${r.title}\n`);
      }
      if (missing.length) {
        process.stdout.write(`missing=${missing.length}\n`);
        for (const id of missing) process.stdout.write(`  - ${id}\n`);
      }
      process.stdout.write('note: pass --apply to perform the move.\n');
    }
    closeDb();
    return;
  }
  // Apply: run the persist-layer move.
  const result = promoteMemoryToGlobal(db, key, uniqueIds, { kimiHomeDir: home });
  closeDb();
  const out = {
    operation: 'promote_to_global',
    project_key: key,
    cwd,
    moved: result.moved,
    skipped: result.skipped,
  };
  if (asJson) emitJson(out);
  else {
    process.stdout.write(`project_key=${key} cwd=${cwd}\n`);
    process.stdout.write(`moved=${result.moved.length}\n`);
    for (const r of result.moved) {
      process.stdout.write(`  - ${r.id} → _global\n`);
    }
    if (result.skipped.length) {
      process.stdout.write(`skipped=${result.skipped.length}\n`);
      for (const r of result.skipped) {
        process.stdout.write(`  - ${r.id} (${r.reason})\n`);
      }
    }
  }
}
