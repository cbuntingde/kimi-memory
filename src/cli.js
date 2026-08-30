#!/usr/bin/env node
// Tiny CLI for kimi-memory: list / get / status / prune / export /
// import / reset-project / acl / dream / consolidate / serve-http
// without spinning up the MCP server. Intended for ops debugging and
// scripted cleanup; the agent should still use the MCP tools.
//
// Each per-command module lives in src/cli-cmd/<command>.js and exports
// an async function of the same name. This file is the dispatcher:
// argument parsing, command routing, usage text, top-level error
// handling.
//
// Usage:
//   node src/cli.js <command> [args]
//
// Common flags:
//   --cwd <abs path>       project root (required for project-scope reads/writes)
//   --home <dir>           override $KIMI_CODE_HOME
//   --json                 emit machine-readable JSON instead of formatted text
//   --quiet / -q           suppress per-row output, only print summary
//
// Exit code: 0 on success, 1 on user error, 2 on internal error.
import { closeDb } from './persist.js';
import { parseArgs } from './cli/lib.js';
import { cmdList } from './cli-cmd/list.js';
import { cmdGet } from './cli-cmd/get.js';
import { cmdStatus } from './cli-cmd/status.js';
import { cmdRecall } from './cli-cmd/recall.js';
import { cmdPrune } from './cli-cmd/prune.js';
import { cmdExport } from './cli-cmd/export.js';
import { cmdImport } from './cli-cmd/import.js';
import { cmdResetProject } from './cli-cmd/reset-project.js';
import { cmdAcl } from './cli-cmd/acl.js';
import { cmdDream } from './cli-cmd/dream.js';
import { cmdDreaming } from './cli-cmd/dreaming.js';
import { cmdConsolidate } from './cli-cmd/consolidate.js';
import { cmdServeHttp } from './cli-cmd/serve-http.js';

function printUsage() {
  process.stdout.write(
    [
      '',
      'Usage:',
      '  node src/cli.js list   [--cwd <path>] [--scope project|global|all] [--type <type>] [--status active|superseded|deleted] [--limit N] [--include-expired] [--json] [-q]',
      '  node src/cli.js get    <memory-id> [--scope project|global] [--cwd <path>] [--json]',
      '  node src/cli.js status [--cwd <path>] [--json]',
      '  node src/cli.js recall <query>       [--cwd <path>] [--limit N] [--per-type] [--fusion rrf|weighted] [--rrf-k 60] [--visibility team,private] [--json]',
      '  node src/cli.js prune  [--cwd <path>] [--all-projects] [--apply] [--json]',
      '  node src/cli.js reset-project [--cwd <path>] [--apply] [--json]',
      '  node src/cli.js export <output-file> [--cwd <path>] [--scope project|global|all]',
      '  node src/cli.js import <input-file>  [--cwd <path>] [--scope project|global|all] [--merge|--replace [--yes]]',
      '  node src/cli.js acl list   <memory-id> [--cwd <path>] [--scope project|global] [--json]',
      '  node src/cli.js acl grant  <memory-id> --principal-kind <k> --principal-id <id> [--cwd <path>] [--json]',
      '  node src/cli.js acl revoke <memory-id> --principal-kind <k> --principal-id <id> [--cwd <path>] [--json]',
      '  node src/cli.js dream status  [--cwd <path>] [--json]',
      '  node src/cli.js dream list    [--cwd <path>] [--status queued|ready|applied|stale|failed|cancelled] [--json]',
      '  node src/cli.js dream get     <job-id> [--cwd <path>] [--json]',
      '  node src/cli.js dream enqueue [--cwd <path>] [--json]',
      '  node src/cli.js dream generate <job-id> [--cwd <path>] [--json]',
      '  node src/cli.js dream apply   <job-id> [--cwd <path>] [--auto-apply-confidence N] [--json]',
      '  node src/cli.js dream discard <job-id> [--cwd <path>] [--reason <text>] [--json]',
      '  node src/cli.js dreaming on|off|auto    [--scope project|global] [--interval 3h] [--include consolidate,dream,gc] [--json]',
      '  node src/cli.js dreaming run            [--cwd <path>] [--force] [--include ...] [--exclude ...] [--json]',
      '  node src/cli.js consolidate run    [--cwd <path>] [--json]',
      '  node src/cli.js consolidate status [--cwd <path>] [--json]',
      '',
      'Options:',
      '  --home <dir>     override $KIMI_CODE_HOME',
      '  --json           emit machine-readable JSON',
      '  -q, --quiet      suppress per-row output, only print summary',
      '',
    ].join('\n'),
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (
    !args.command ||
    args.command === 'help' ||
    args.command === '--help' ||
    args.command === '-h'
  ) {
    printUsage();
    return;
  }
  try {
    switch (args.command) {
      case 'list':
        return await cmdList(args);
      case 'get':
        return await cmdGet(args);
      case 'status':
        return await cmdStatus(args);
      case 'recall':
        return await cmdRecall(args);
      case 'prune':
        return await cmdPrune(args);
      case 'reset-project':
        return await cmdResetProject(args);
      case 'export':
        return await cmdExport(args);
      case 'import':
        return await cmdImport(args);
      case 'acl':
        return await cmdAcl(args);
      case 'dreaming':
        return await cmdDreaming(args);
      case 'dream':
        return await cmdDream(args);
      case 'consolidate':
        return await cmdConsolidate(args);
      case 'serve-http':
        return await cmdServeHttp(args);
      default:
        printUsage();
        process.exit(1);
    }
  } catch (e) {
    process.stderr.write(`error: ${e && e.stack ? e.stack : e}\n`);
    try {
      closeDb();
    } catch {
      /* ignore */
    }
    process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e && e.stack ? e.stack : e}\n`);
  process.exit(2);
});
