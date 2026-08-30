// CLI: keyword / hybrid recall against the project's durable memories.
//
//   node src/cli.js recall <query>       [--cwd <path>] [--limit N]
//                                       [--per-type] [--fusion rrf|weighted]
//                                       [--rrf-k 60] [--visibility team,private] [--json]
import { existsSync } from 'node:fs';
import { openDb, closeDb, searchMemories } from '../persist.js';
import { deriveProjectKey, projectDbPath } from '../project-key.js';
import { homeDir, resolveCwd, emitJson } from '../cli/lib.js';

export async function cmdRecall(args) {
  const home = homeDir(args);
  const cwd = resolveCwd(args);
  if (!cwd) {
    process.stderr.write('error: --cwd is required for recall\n');
    process.exit(1);
  }
  const query = args.positional.join(' ').trim();
  if (!query) {
    process.stderr.write('error: query is required\n');
    process.exit(1);
  }
  const limit = args.flags.limit ? Number(args.flags.limit) : 10;
  const perType = !!args.flags['per-type'];
  const asJson = !!args.flags.json;
  // v10: fusion strategy + RRF_K. Default fusion='rrf' (k=60). The
  // legacy 'weighted' blend is preserved for callers that need it.
  const fusionFlag = args.flags.fusion ? String(args.flags.fusion) : 'rrf';
  if (fusionFlag !== 'rrf' && fusionFlag !== 'weighted') {
    process.stderr.write('error: --fusion must be rrf or weighted\n');
    process.exit(1);
  }
  const rrfKFlag = args.flags['rrf-k'] ? Number(args.flags['rrf-k']) : undefined;
  if (rrfKFlag !== undefined && (!Number.isFinite(rrfKFlag) || rrfKFlag < 1 || rrfKFlag > 1000)) {
    process.stderr.write('error: --rrf-k must be 1..1000\n');
    process.exit(1);
  }
  // v10: optional visibility filter (single string or comma-separated list).
  let visibilityFlag = undefined;
  if (typeof args.flags.visibility === 'string' && args.flags.visibility.length > 0) {
    visibilityFlag = args.flags.visibility
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (visibilityFlag.length === 0) visibilityFlag = undefined;
  }
  const key = deriveProjectKey(cwd);
  const dbPath = projectDbPath(home, key);
  if (!existsSync(dbPath)) {
    process.stderr.write('note: project DB does not exist yet\n');
    process.exit(0);
  }
  const db = openDb(dbPath);
  try {
    const rows = await searchMemories(db, key, query, {
      limit,
      perType,
      includeScore: true,
      fusion: fusionFlag,
      rrfK: rrfKFlag,
      visibility: visibilityFlag,
    });
    if (asJson) emitJson({ operation: 'recall', query, count: rows.length, items: rows });
    else {
      for (const m of rows) {
        const title = m.title ? `"${m.title}"` : '(no title)';
        const score = typeof m.score === 'number' ? ` (score=${m.score.toFixed(3)})` : '';
        process.stdout.write(
          `[${m.type}] ${m.id} ${title}${score} — ${(m.content || '').slice(0, 80).replace(/\s+/g, ' ')}\n`,
        );
      }
    }
  } catch (err) {
    process.stderr.write(`recall failed: ${err && err.message ? err.message : err}\n`);
    process.exit(2);
  } finally {
    closeDb();
  }
}
