// CLI: wipe every per-project row (memories, working memory,
// conversations, conversation events, edges, synthesizes) for the
// active project. Use after a repo is re-cloned to the same canonical
// path: the project_key is a hash of the path, so kimi-memory cannot
// otherwise tell the new project apart from the old one.
//
// Dry run by default; pass --apply to actually delete. The global DB
// and every other project DB are never touched.
//
//   node src/cli.js reset-project [--cwd <path>] [--apply] [--json]
import { existsSync } from 'node:fs';
import {
  openDb,
  closeDb,
  resetProject,
  resetProjectDryRunCounts,
  detectReclone,
} from '../persist.js';
import { deriveProjectKey, projectDbPath } from '../project-key.js';
import { homeDir, resolveCwd, emitJson } from '../cli/lib.js';

export async function cmdResetProject(args) {
  const home = homeDir(args);
  const cwd = resolveCwd(args);
  if (!cwd) {
    process.stderr.write('error: --cwd is required for reset-project\n');
    process.exit(1);
  }
  const apply = !!args.flags.apply;
  const asJson = !!args.flags.json;
  const key = deriveProjectKey(cwd);
  const dbPath = projectDbPath(home, key);
  if (!existsSync(dbPath)) {
    process.stderr.write(`note: project DB does not exist yet (${dbPath})\n`);
    process.exit(0);
  }
  const db = openDb(dbPath);
  // Re-clone diagnostic: lets the operator confirm this is the right
  // project to wipe.
  let reclone;
  try {
    reclone = detectReclone(db, key, cwd);
  } catch (e) {
    reclone = { isReclone: false, reason: 'detect failed (see diagnostics)' };
  }
  // Dry run: echo the row counts and the diagnostic. The agent or the
  // operator reads this and decides whether to invoke with --apply.
  if (!apply) {
    const counts = resetProjectDryRunCounts(db, key);
    const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
    const out = {
      operation: 'reset_project_dry_run',
      project_key: key,
      cwd,
      reclone,
      row_counts: counts,
      total_rows: totalRows,
      note:
        'dry run: nothing was deleted. Pass --apply to wipe the per-project rows. ' +
        'The global database and every other project DB are never touched.',
    };
    if (asJson) emitJson(out);
    else {
      process.stdout.write(`project_key=${key} cwd=${cwd}\n`);
      process.stdout.write(`reclone.isReclone=${reclone.isReclone}\n`);
      if (reclone.reason) process.stdout.write(`reclone.reason=${reclone.reason}\n`);
      for (const [k2, n] of Object.entries(counts)) {
        process.stdout.write(`${k2}=${n}\n`);
      }
      process.stdout.write(`total_rows=${totalRows}\n`);
      process.stdout.write('note: pass --apply to perform the reset.\n');
    }
    closeDb();
    return;
  }
  // Apply: wipe the per-project rows. resetProject runs in a
  // transaction so a mid-reset error leaves the DB untouched.
  const summary = resetProject(db, key, { canonicalRoot: cwd });
  closeDb(dbPath);
  const out = {
    operation: 'reset_project',
    project_key: key,
    cwd,
    reclone,
    ...summary,
  };
  if (asJson) emitJson(out);
  else {
    process.stdout.write(`project_key=${key} cwd=${cwd}\n`);
    process.stdout.write(`memories_deleted=${summary.memories_deleted}\n`);
    process.stdout.write(`working_memory_deleted=${summary.working_memory_deleted}\n`);
    process.stdout.write(`conversations_deleted=${summary.conversations_deleted}\n`);
    process.stdout.write(`conversation_events_deleted=${summary.conversation_events_deleted}\n`);
    process.stdout.write(`memory_edges_deleted=${summary.memory_edges_deleted}\n`);
    process.stdout.write(`memory_synthesizes_deleted=${summary.memory_synthesizes_deleted}\n`);
    process.stdout.write(`project_path_preserved=${summary.project_path_preserved}\n`);
  }
}
