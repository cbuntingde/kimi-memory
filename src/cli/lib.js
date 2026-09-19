// Shared helpers for the kimi-memory CLI.
//
// Every per-command module imports these:
//   - parseArgs(argv): minimal flag parser (--key value, --key=value, -q)
//   - homeDir(args): honour --home override or default $KIMI_CODE_HOME
//   - resolveCwd(args): canonicalize --cwd and exit 1 on missing/invalid
//   - emitJson(payload): write pretty JSON to stdout
//   - emitText(label, payload): write a labelled JSON block
//   - safeJson(text): parse JSON or {} on failure
//
// Exit code policy: 0 on success, 1 on user error, 2 on internal error.
// This file deliberately has no side effects — each command module
// imports the helpers it needs.
import { kimiHome } from '../util.js';
import { existsSync } from 'node:fs';
import {
  canonicalizeRoot,
  deriveProjectKey,
  projectDbPath,
  globalDbPath,
  GLOBAL_PROJECT_KEY,
} from '../project-key.js';
import { openDb, closeDb } from '../persist.js';

export function parseArgs(argv) {
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

export function homeDir(args) {
  return args.flags.home ? String(args.flags.home) : kimiHome();
}

export function resolveCwd(args) {
  const cwd = args.flags.cwd;
  if (!cwd) return null;
  const c = canonicalizeRoot(String(cwd));
  if (!c) {
    process.stderr.write(`error: invalid --cwd: ${cwd}\n`);
    process.exit(1);
  }
  return c;
}

export function emitJson(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

export function emitText(label, payload) {
  process.stdout.write(`# ${label}\n`);
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

export function safeJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

export { projectDbPath };

// The project scope needs a canonical cwd. Exits with the CLI's
// user-error code rather than returning, so each command does not have to
// repeat the message.
export function requireProjectCwd(scope, cwd) {
  if (scope !== 'project' && scope !== 'all') return;
  if (!cwd) {
    process.stderr.write('error: --cwd is required for project scope\n');
    process.exit(1);
  }
}

// Visit each requested scope that actually has a database on disk,
// calling `fn(db, projectKey, scope, dbPath)` and closing the handle
// afterwards — including when `fn` throws.
//
// Scopes with no database yet are skipped and reported through
// `onMissing({ scope, projectKey, dbPath })` so the caller can decide
// whether to announce it. Four subcommands had each grown their own copy
// of this open/exists/close block; this is the single implementation.
export async function eachScopeDb({ home, scope, cwd, onMissing }, fn) {
  const scopes = scope === 'all' ? ['project', 'global'] : [scope];
  for (const s of scopes) {
    if (s === 'global') {
      const dbPath = globalDbPath(home);
      if (!existsSync(dbPath)) {
        if (onMissing) onMissing({ scope: s, projectKey: GLOBAL_PROJECT_KEY, dbPath });
        continue;
      }
      const db = openDb(dbPath);
      try {
        await fn(db, GLOBAL_PROJECT_KEY, s, dbPath);
      } finally {
        closeDb(dbPath);
      }
      continue;
    }
    if (s !== 'project') continue;
    requireProjectCwd(s, cwd);
    const key = deriveProjectKey(cwd);
    const dbPath = projectDbPath(home, key);
    if (!existsSync(dbPath)) {
      if (onMissing) onMissing({ scope: s, projectKey: key, dbPath });
      continue;
    }
    const db = openDb(dbPath);
    try {
      await fn(db, key, s, dbPath);
    } finally {
      closeDb(dbPath);
    }
  }
}
