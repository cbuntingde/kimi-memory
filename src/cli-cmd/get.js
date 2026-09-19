// CLI: fetch one memory by id.
//
//   node src/cli.js get <memory-id> [--scope project|global] [--cwd <path>] [--json]
import { closeDb, getMemory } from '../persist.js';
import { homeDir, resolveCwd, emitJson, emitText, eachScopeDb } from '../cli/lib.js';

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
  await eachScopeDb({ home, scope, cwd: resolveCwd(args) }, (db, key, s) => {
    const m = getMemory(db, key, id, { includeSuperseded: true });
    if (m) found.push({ scope: s, memory: m });
  });
  if (found.length === 0) {
    process.stderr.write(`not found: ${id}\n`);
    process.exit(1);
  }
  if (asJson) emitJson({ operation: 'get', matches: found });
  else for (const f of found) emitText(`memory (${f.scope})`, f.memory);
  closeDb();
}
