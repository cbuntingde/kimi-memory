// CLI: fetch one memory by id.
//
//   node src/cli.js get <memory-id> [--scope project|global] [--cwd <path>] [--json]
import { existsSync } from 'node:fs';
import { openDb, closeDb, getMemory } from '../persist.js';
import {
  deriveProjectKey,
  projectDbPath,
  globalDbPath,
  GLOBAL_PROJECT_KEY,
} from '../project-key.js';
import { homeDir, resolveCwd, emitJson, emitText } from '../cli/lib.js';

export async function cmdGet(args) {
  const home = homeDir(args);
  const id = args.positional[0];
  if (!id) {
    process.stderr.write('error: memory id is required\n');
    process.exit(1);
  }
  const scope = (args.flags.scope || 'project').toString();
  const asJson = !!args.flags.json;
  const found = [];
  if (scope === 'project' || scope === 'all') {
    const cwd = resolveCwd(args);
    if (!cwd) {
      process.stderr.write('error: --cwd is required for project scope\n');
      process.exit(1);
    }
    const key = deriveProjectKey(cwd);
    const dbPath = projectDbPath(home, key);
    if (existsSync(dbPath)) {
      const db = openDb(dbPath);
      const m = getMemory(db, key, id, { includeSuperseded: true });
      if (m) found.push({ scope: 'project', memory: m });
      closeDb(dbPath);
    }
  }
  if (scope === 'global' || scope === 'all') {
    const gPath = globalDbPath(home);
    if (existsSync(gPath)) {
      const db = openDb(gPath);
      const m = getMemory(db, GLOBAL_PROJECT_KEY, id, { includeSuperseded: true });
      if (m) found.push({ scope: 'global', memory: m });
      closeDb(gPath);
    }
  }
  if (found.length === 0) {
    process.stderr.write(`not found: ${id}\n`);
    process.exit(1);
  }
  if (asJson) emitJson({ operation: 'get', matches: found });
  else for (const f of found) emitText(`memory (${f.scope})`, f.memory);
  closeDb();
}
