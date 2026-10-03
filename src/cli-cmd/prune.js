// CLI: orphan-project database cleanup.
//
//   node src/cli.js prune [--cwd <path>] [--all-projects] [--apply] [--json]
import { existsSync } from 'node:fs';
import path from 'node:path';
import { closeDb } from '../persist.js';
import { deriveProjectKey } from '../project-key.js';
import { enumeratePruneCandidates } from '../prune.js';
import { homeDir, resolveCwd, emitJson } from '../cli/lib.js';

export async function cmdPrune(args) {
  const home = homeDir(args);
  const all = !!args.flags['all-projects'];
  const apply = !!args.flags.apply;
  const asJson = !!args.flags.json;
  const quiet = !!args.flags.quiet;
  const cwd = resolveCwd(args);
  if (!cwd) {
    process.stderr.write('error: --cwd is required (the active project is never removed)\n');
    process.exit(1);
  }
  const activeKey = deriveProjectKey(cwd);
  const memDir = path.join(home, 'kimi-memory');
  if (!existsSync(memDir)) {
    process.stderr.write(`note: ${memDir} does not exist\n`);
    process.exit(0);
  }
  const { candidates } = enumeratePruneCandidates({
    home,
    activeKey,
    scope: all ? 'all-projects' : 'project',
    apply,
  });
  const removed = candidates.filter((c) => c.action === 'removed').length;
  const out = {
    operation: 'prune',
    apply,
    scope: all ? 'all-projects' : 'project',
    candidates,
    removed,
  };
  if (asJson) emitJson(out);
  else {
    // -q suppresses per-row output, mirroring `list`. (Review cli-2.)
    const rows = quiet ? [] : candidates;
    for (const c of rows) {
      process.stdout.write(
        `${c.project_key} action=${c.action} exists_on_disk=${c.exists_on_disk} canonical_root=${c.canonical_root || '(none)'}\n`,
      );
    }
    process.stdout.write(`removed=${removed} apply=${apply}\n`);
  }
  closeDb();
}
