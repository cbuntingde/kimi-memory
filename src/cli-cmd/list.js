// CLI: list memories across project and global scope.
//
//   node src/cli.js list [--cwd <path>] [--scope project|global|all]
//                        [--type <memory-type>] [--status active|superseded|deleted]
//                        [--limit N] [--include-expired] [--json] [-q]
import { closeDb, listMemories } from '../persist.js';
import { homeDir, resolveCwd, emitJson, eachScopeDb } from '../cli/lib.js';

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
  await eachScopeDb(
    {
      home,
      scope,
      cwd,
      onMissing: ({ scope: missing, dbPath }) => {
        // Only the project scope is announced: a missing global DB on a
        // fresh install is the normal state, not a note worth printing.
        if (missing === 'project') {
          process.stderr.write(`note: project DB does not exist yet (${dbPath})\n`);
        }
      },
    },
    (db, key, s) => {
      const rows = listMemories(db, key, { type, status, limit, includeExpired });
      for (const r of rows) items.push({ scope: s, ...r });
    },
  );
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
