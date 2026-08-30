// CLI: list memories across project and global scope.
//
//   node src/cli.js list [--cwd <path>] [--scope project|global|all]
//                        [--type <memory-type>] [--status active|superseded|deleted]
//                        [--limit N] [--include-expired] [--json] [-q]
import { existsSync } from 'node:fs';
import { openDb, closeDb, listMemories } from '../persist.js';
import {
  deriveProjectKey,
  projectDbPath,
  globalDbPath,
  GLOBAL_PROJECT_KEY,
} from '../project-key.js';
import { homeDir, resolveCwd, emitJson } from '../cli/lib.js';

export async function cmdList(args) {
  const home = homeDir(args);
  const scope = (args.flags.scope || 'all').toString();
  const type = args.flags.type ? String(args.flags.type) : undefined;
  const status = args.flags.status ? String(args.flags.status) : 'active';
  const limit = args.flags.limit ? Number(args.flags.limit) : 50;
  const includeExpired = !!args.flags['include-expired'];
  const cwd = resolveCwd(args);
  const quiet = !!args.flags.quiet;
  const asJson = !!args.flags.json;

  if (Number.isNaN(limit) || limit < 1 || limit > 500) {
    process.stderr.write('error: --limit must be 1..500\n');
    process.exit(1);
  }

  const items = [];
  if (scope === 'project' || scope === 'all') {
    if (!cwd) {
      process.stderr.write('error: --cwd is required for project scope\n');
      process.exit(1);
    }
    const key = deriveProjectKey(cwd);
    const dbPath = projectDbPath(home, key);
    if (!existsSync(dbPath)) {
      process.stderr.write(`note: project DB does not exist yet (${dbPath})\n`);
    } else {
      const db = openDb(dbPath);
      const rows = listMemories(db, key, {
        type,
        status,
        limit,
        includeExpired,
      });
      for (const r of rows) items.push({ scope: 'project', ...r });
      closeDb(dbPath);
    }
  }
  if (scope === 'global' || scope === 'all') {
    const gPath = globalDbPath(home);
    if (existsSync(gPath)) {
      const db = openDb(gPath);
      const rows = listMemories(db, GLOBAL_PROJECT_KEY, {
        type,
        status,
        limit,
        includeExpired,
      });
      for (const r of rows) items.push({ scope: 'global', ...r });
      closeDb(gPath);
    }
  }
  items.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  const limited = items.slice(0, limit);

  if (asJson) {
    emitJson({ operation: 'list', scope, count: limited.length, items: limited });
  } else if (quiet) {
    process.stdout.write(`${limited.length} memories\n`);
  } else {
    for (const m of limited) {
      const title = m.title ? `"${m.title}"` : '(no title)';
      process.stdout.write(
        `[${m.scope}] [${m.type}] ${m.id} ${title} — ${(m.content || '').slice(0, 80).replace(/\s+/g, ' ')}\n`,
      );
    }
  }
  closeDb();
}
