// CLI: export project + global memories to a JSON file.
//
//   node src/cli.js export <output-file> [--cwd <path>] [--scope project|global|all]
import { writeFileSync } from 'node:fs';
import { listMemories } from '../persist.js';
import { homeDir, resolveCwd, eachScopeDb } from '../cli/lib.js';

// The export shape drops the embedding vector: it is a large base64 blob
// that the importer cannot use (it re-embeds), and including it would
// inflate the file by roughly two orders of magnitude.
function stripEmbedding(m) {
  const copy = { ...m };
  delete copy.embedding;
  return copy;
}

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

  if (!['project', 'global', 'all'].includes(scope)) {
    process.stderr.write(`error: invalid scope: ${scope}\n`);
    process.exit(1);
  }

  const scopes = {};
  await eachScopeDb({ home, scope, cwd }, (db, key, s) => {
    const memories = listMemories(db, key, { limit: 10000, status: null, includeExpired: true });
    if (s === 'project') {
      const working = db
        .prepare('SELECT slot, value FROM working_memory WHERE project_key = ?')
        .all(key);
      scopes.project = {
        project_key: key,
        cwd,
        memories: memories.map(stripEmbedding),
        working_memory: working,
      };
      return;
    }
    scopes.global = {
      project_key: key,
      memories: memories.map(stripEmbedding),
      working_memory: [],
    };
  });

  const doc = { version: 1, exported_at: new Date().toISOString(), scopes };
  try {
    writeFileSync(outFile, JSON.stringify(doc, null, 2));
    process.stdout.write(`exported to ${outFile}\n`);
  } catch (e) {
    process.stderr.write(`error writing export file: ${e && e.message ? e.message : e}\n`);
    process.exit(2);
  }
}
