// CLI: export project + global memories to a JSON file.
//
//   node src/cli.js export <output-file> [--cwd <path>] [--scope project|global|all]
import { existsSync, writeFileSync } from 'node:fs';
import { openDb, closeDb, listMemories } from '../persist.js';
import {
  deriveProjectKey,
  projectDbPath,
  globalDbPath,
  GLOBAL_PROJECT_KEY,
} from '../project-key.js';
import { homeDir, resolveCwd } from '../cli/lib.js';

export async function cmdExport(args) {
  const home = homeDir(args);
  const outFile = args.positional[0];
  if (!outFile) {
    process.stderr.write('error: output file path is required\n');
    process.exit(1);
  }
  const cwd = resolveCwd(args);
  if (!cwd) {
    process.stderr.write('error: --cwd is required for export\n');
    process.exit(1);
  }
  const scope = (args.flags.scope || 'project').toString();
  const asJson = !!args.flags.json;

  if (!['project', 'global', 'all'].includes(scope)) {
    process.stderr.write(`error: invalid scope: ${scope}\n`);
    process.exit(1);
  }

  const scopes = {};

  if (scope === 'project' || scope === 'all') {
    const key = deriveProjectKey(cwd);
    const dbPath = projectDbPath(home, key);
    if (existsSync(dbPath)) {
      const db = openDb(dbPath);
      const memories = listMemories(db, key, { limit: 10000, status: null, includeExpired: true });
      const working = db
        .prepare('SELECT slot, value FROM working_memory WHERE project_key = ?')
        .all(key);
      closeDb(dbPath);
      scopes.project = {
        project_key: key,
        cwd,
        memories: memories.map((m) => {
          const copy = { ...m };
          delete copy.embedding;
          return copy;
        }),
        working_memory: working,
      };
    }
  }

  if (scope === 'global' || scope === 'all') {
    const gPath = globalDbPath(home);
    if (existsSync(gPath)) {
      const db = openDb(gPath);
      const memories = listMemories(db, GLOBAL_PROJECT_KEY, {
        limit: 10000,
        status: null,
        includeExpired: true,
      });
      closeDb(gPath);
      scopes.global = {
        project_key: GLOBAL_PROJECT_KEY,
        memories: memories.map((m) => {
          const copy = { ...m };
          delete copy.embedding;
          return copy;
        }),
        working_memory: [],
      };
    }
  }

  const doc = { version: 1, exported_at: new Date().toISOString(), scopes };
  try {
    writeFileSync(outFile, JSON.stringify(doc, null, 2));
    process.stdout.write(`exported to ${outFile}\n`);
  } catch (e) {
    process.stderr.write(`error writing export file: ${e && e.message ? e.message : e}\n`);
    process.exit(2);
  }
}
