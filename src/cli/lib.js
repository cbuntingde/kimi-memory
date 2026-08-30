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
import { canonicalizeRoot, projectDbPath } from '../project-key.js';

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
