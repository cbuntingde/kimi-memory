#!/usr/bin/env node
// Tiny CLI for kimi-memory: list / get / status / prune without
// spinning up the MCP server. Intended for ops debugging and
// scripted cleanup; the agent should still use the MCP tools.
//
// Usage:
//   node src/cli.js list [--cwd <path>] [--scope project|global|all]
//                        [--type <memory-type>] [--status active|superseded|deleted]
//                        [--limit N] [--include-expired]
//   node src/cli.js get <memory-id> [--scope project|global]
//   node src/cli.js status [--cwd <path>]
//   node src/cli.js prune [--all-projects] [--apply]
//   node src/cli.js recall <query> [--cwd <path>] [--limit N]
//
// Common flags:
//   --cwd <abs path>       project root (required for project-scope reads/writes)
//   --home <dir>           override $KIMI_CODE_HOME
//   --json                 emit machine-readable JSON instead of formatted text
//   --quiet / -q           suppress per-row output, only print summary
//
// Exit code: 0 on success, 1 on user error, 2 on internal error.
import { kimiHome } from './util.js';
import {
  canonicalizeRoot,
  deriveProjectKey,
  projectDbPath,
  globalDbPath,
  GLOBAL_PROJECT_KEY,
} from './project-key.js';
import {
  openDb,
  closeDb,
  listMemories,
  getMemory,
  memoryCounts,
  searchMemories,
  listProjectPaths,
} from './persist.js';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = {
    command: argv[2],
    positional: [],
    flags: {},
  };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next != null && !next.startsWith('--')) {
          out.flags[key] = next;
          i++;
        } else {
          out.flags[key] = true;
        }
      }
    } else if (a === '-q' || a === '--quiet') {
      out.flags.quiet = true;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function homeDir(args) {
  return args.flags.home ? String(args.flags.home) : kimiHome();
}

function resolveCwd(args) {
  const cwd = args.flags.cwd;
  if (!cwd) return null;
  const c = canonicalizeRoot(String(cwd));
  if (!c) {
    process.stderr.write(`error: invalid --cwd: ${cwd}\n`);
    process.exit(1);
  }
  return c;
}

function emitJson(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function emitText(label, payload) {
  process.stdout.write(`# ${label}\n`);
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function cmdList(args) {
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

function cmdGet(args) {
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

function cmdStatus(args) {
  const home = homeDir(args);
  const cwd = resolveCwd(args);
  const asJson = !!args.flags.json;
  const out = { home };
  if (cwd) {
    const key = deriveProjectKey(cwd);
    const dbPath = projectDbPath(home, key);
    if (existsSync(dbPath)) {
      const db = openDb(dbPath);
      out.project = { project_key: key, cwd, ...memoryCounts(db, key) };
      out.project_paths = listProjectPaths(db);
      closeDb(dbPath);
    } else {
      out.project = { project_key: key, cwd, note: 'no DB yet' };
    }
  }
  const gPath = globalDbPath(home);
  if (existsSync(gPath)) {
    const db = openDb(gPath);
    out.global = { ...memoryCounts(db, GLOBAL_PROJECT_KEY) };
    closeDb(gPath);
  } else {
    out.global = { note: 'no global DB yet' };
  }
  if (asJson) emitJson({ operation: 'status', ...out });
  else emitText('memory status', out);
  closeDb();
}

function cmdRecall(args) {
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
  const key = deriveProjectKey(cwd);
  const dbPath = projectDbPath(home, key);
  if (!existsSync(dbPath)) {
    process.stderr.write('note: project DB does not exist yet\n');
    process.exit(0);
  }
  const db = openDb(dbPath);
  searchMemories(db, key, query, {
    limit,
    perType,
    includeScore: true,
  })
    .then((rows) => {
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
      closeDb();
    })
    .catch((err) => {
      process.stderr.write(`recall failed: ${err && err.message ? err.message : err}\n`);
      closeDb();
      process.exit(2);
    });
}

function cmdPrune(args) {
  const home = homeDir(args);
  const all = !!args.flags['all-projects'];
  const apply = !!args.flags.apply;
  const asJson = !!args.flags.json;
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
  const entries = readdirSync(memDir, { withFileTypes: true });
  const projectDirs = entries
    .filter((d) => d.isDirectory() && d.name !== GLOBAL_PROJECT_KEY && d.name !== '_diagnostics')
    .filter((d) => (all ? d.name !== activeKey : d.name === activeKey))
    .map((d) => ({
      key: d.name,
      dir: path.join(memDir, d.name),
      db: path.join(memDir, d.name, 'memory.sqlite'),
    }));

  const candidates = [];
  for (const p of projectDirs) {
    let recordedRoot = null;
    if (existsSync(p.db)) {
      const db = openDb(p.db);
      const rows = listProjectPaths(db);
      const row = rows.find((r) => r.project_key === p.key);
      if (row) recordedRoot = row.canonical_root;
      closeDb(p.db);
    } else {
      continue;
    }
    const isActive = p.key === activeKey;
    const existsOnDisk = recordedRoot ? existsSync(recordedRoot) : null;
    let action;
    if (isActive) action = 'kept-active';
    else if (existsOnDisk === false) {
      if (apply) {
        try {
          closeDb(p.db);
          rmSync(p.dir, { recursive: true, force: true });
          action = 'removed';
        } catch (e) {
          action = 'error';
          candidates.push({ project_key: p.key, action, error: e.message });
          continue;
        }
      } else {
        action = 'would-remove';
      }
    } else {
      action = 'kept';
    }
    candidates.push({
      project_key: p.key,
      canonical_root: recordedRoot,
      exists_on_disk: existsOnDisk,
      action,
    });
  }
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
    for (const c of candidates) {
      process.stdout.write(
        `${c.project_key} action=${c.action} exists_on_disk=${c.exists_on_disk} canonical_root=${c.canonical_root || '(none)'}\n`,
      );
    }
    process.stdout.write(`removed=${removed} apply=${apply}\n`);
  }
  closeDb();
}

function printUsage() {
  process.stdout.write(
    [
      'kimi-memory CLI',
      '',
      'Usage:',
      '  node src/cli.js list   [--cwd <path>] [--scope project|global|all] [--type <type>] [--status active|superseded|deleted] [--limit N] [--include-expired] [--json] [-q]',
      '  node src/cli.js get    <memory-id> [--scope project|global] [--cwd <path>] [--json]',
      '  node src/cli.js status [--cwd <path>] [--json]',
      '  node src/cli.js recall <query>       [--cwd <path>] [--limit N] [--per-type] [--json]',
      '  node src/cli.js prune  [--cwd <path>] [--all-projects] [--apply] [--json]',
      '',
      'Options:',
      '  --home <dir>     override $KIMI_CODE_HOME',
      '  --json           emit machine-readable JSON',
      '  -q, --quiet      suppress per-row output, only print summary',
      '',
    ].join('\n'),
  );
}

function main() {
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
        return cmdList(args);
      case 'get':
        return cmdGet(args);
      case 'status':
        return cmdStatus(args);
      case 'recall':
        return cmdRecall(args);
      case 'prune':
        return cmdPrune(args);
      default:
        process.stderr.write(`error: unknown command: ${args.command}\n`);
        printUsage();
        process.exit(1);
    }
  } catch (e) {
    process.stderr.write(`error: ${e && e.stack ? e.stack : e}\n`);
    closeDb();
    process.exit(2);
  }
}

main();
