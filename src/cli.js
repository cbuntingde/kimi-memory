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
  resetProject,
  detectReclone,
  resetProjectDryRunCounts,
  shareMemory,
} from './persist.js';
import { enumeratePruneCandidates } from './prune.js';
import { looksLikeSecret } from './extract.js';
import {
  grantMemoryAcl,
  revokeMemoryAcl,
  listMemoryAcls,
  parsePrincipalDescriptor,
} from './acl.js';
import { startProxy } from './proxy/server.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  searchMemories(db, key, query, {
    limit,
    perType,
    includeScore: true,
    fusion: fusionFlag,
    rrfK: rrfKFlag,
    visibility: visibilityFlag,
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
    for (const c of candidates) {
      process.stdout.write(
        `${c.project_key} action=${c.action} exists_on_disk=${c.exists_on_disk} canonical_root=${c.canonical_root || '(none)'}\n`,
      );
    }
    process.stdout.write(`removed=${removed} apply=${apply}\n`);
  }
  closeDb();
}

function cmdExport(args) {
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

function cmdImport(args) {
  const home = homeDir(args);
  const inFile = args.positional[0];
  if (!inFile) {
    process.stderr.write('error: input file path is required\n');
    process.exit(1);
  }
  const cwd = resolveCwd(args);
  if (!cwd) {
    process.stderr.write('error: --cwd is required for import\n');
    process.exit(1);
  }
  const scope = (args.flags.scope || 'project').toString();
  const merge = !!args.flags.merge;
  const replace = !!args.flags.replace;
  const yes = !!args.flags.yes;

  if (!['project', 'global', 'all'].includes(scope)) {
    process.stderr.write(`error: invalid scope: ${scope}\n`);
    process.exit(1);
  }

  if (replace && !yes) {
    process.stderr.write('error: refusing to replace without --yes flag\n');
    process.exit(1);
  }

  let doc;
  try {
    doc = JSON.parse(readFileSync(inFile, 'utf8'));
  } catch (e) {
    process.stderr.write(`error reading/parsing import file: ${e && e.message ? e.message : e}\n`);
    process.exit(2);
  }

  if (!doc.scopes) {
    process.stderr.write('error: invalid export file (no scopes)\n');
    process.exit(1);
  }

  let count = 0;
  // Defence-in-depth: the save path runs `assertNoSecret` so an MCP
  // call cannot persist a credential. The import path bypasses that
  // helper (raw INSERT), so an attacker who can drop a crafted export
  // JSON and persuade the operator to run `kimi-memory import` would
  // otherwise land a secret in the DB. Refuse up-front with the same
  // `secret_detected:` shape used elsewhere. opt-out via
  // KIMI_MEMORY_SECRET_SCAN=off for fixture-import workflows.
  if (process.env.KIMI_MEMORY_SECRET_SCAN !== 'off') {
    const all = [];
    if (doc.scopes.project?.memories) all.push(...doc.scopes.project.memories);
    if (doc.scopes.global?.memories) all.push(...doc.scopes.global.memories);
    for (const m of all) {
      if (looksLikeSecret(m.title || '') || looksLikeSecret(m.content || '')) {
        process.stderr.write(
          `error: refusing to import — memory ${m.id} matches a known credential shape. ` +
            `Set KIMI_MEMORY_SECRET_SCAN=off to bypass for fixture imports.\n`,
        );
        process.exit(1);
      }
    }
  }
  if ((scope === 'project' || scope === 'all') && doc.scopes.project) {
    const key = deriveProjectKey(cwd);
    const dbPath = projectDbPath(home, key);
    const db = openDb(dbPath);
    if (replace) {
      db.prepare('DELETE FROM memories WHERE project_key = ?').run(key);
      db.prepare('DELETE FROM working_memory WHERE project_key = ?').run(key);
    }
    for (const mem of doc.scopes.project.memories || []) {
      try {
        db.prepare(
          `INSERT INTO memories (id, project_key, type, title, content, tags, confidence, 
           priority, status, created_at, updated_at, provenance, access_count, last_accessed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          mem.id,
          key,
          mem.type,
          mem.title,
          mem.content,
          JSON.stringify(mem.tags || []),
          mem.confidence || 0.8,
          mem.priority || 0,
          mem.status || 'active',
          mem.created_at,
          mem.updated_at,
          JSON.stringify(mem.provenance || {}),
          mem.access_count || 0,
          mem.last_accessed_at || null,
        );
        count++;
      } catch (e) {
        // Log but continue
        process.stderr.write(`warning: failed to import memory ${mem.id}: ${e.message}\n`);
      }
    }
    for (const wm of doc.scopes.project.working_memory || []) {
      try {
        db.prepare(
          'INSERT OR REPLACE INTO working_memory (slot, project_key, value, updated_at) VALUES (?, ?, ?, ?)',
        ).run(wm.slot, key, wm.value, wm.updated_at || new Date().toISOString());
      } catch (e) {
        process.stderr.write(
          `warning: failed to import working_memory slot ${wm.slot}: ${e.message}\n`,
        );
      }
    }
    closeDb(dbPath);
  }

  if ((scope === 'global' || scope === 'all') && doc.scopes.global) {
    const gPath = globalDbPath(home);
    const db = openDb(gPath);
    if (replace) {
      db.prepare('DELETE FROM memories WHERE project_key = ?').run(GLOBAL_PROJECT_KEY);
    }
    for (const mem of doc.scopes.global.memories || []) {
      try {
        db.prepare(
          `INSERT INTO memories (id, project_key, type, title, content, tags, confidence,
           priority, status, created_at, updated_at, provenance, access_count, last_accessed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          mem.id,
          GLOBAL_PROJECT_KEY,
          mem.type,
          mem.title,
          mem.content,
          JSON.stringify(mem.tags || []),
          mem.confidence || 0.8,
          mem.priority || 0,
          mem.status || 'active',
          mem.created_at,
          mem.updated_at,
          JSON.stringify(mem.provenance || {}),
          mem.access_count || 0,
          mem.last_accessed_at || null,
        );
        count++;
      } catch (e) {
        process.stderr.write(`warning: failed to import global memory ${mem.id}: ${e.message}\n`);
      }
    }
    closeDb(gPath);
  }

  process.stdout.write(`imported ${count} items from ${inFile}\n`);
}

// Wipe every per-project row (memories, working memory, conversations,
// conversation events, edges, synthesizes) for the active project. Use
// this after a repo is re-cloned to the same canonical path: the
// project_key is a hash of the path, so kimi-memory cannot otherwise
// tell the new project apart from the old one.
//
// Dry run by default; pass --apply to actually delete. The global DB
// and every other project DB are never touched. Mirrors the
// memory_reset_project MCP tool for ops users who want to script the
// reset from a shell rather than via the agent.
function cmdResetProject(args) {
  const home = homeDir(args);
  const cwd = resolveCwd(args);
  if (!cwd) {
    process.stderr.write('error: --cwd is required for reset-project\n');
    process.exit(1);
  }
  const apply = !!args.flags.apply;
  const asJson = !!args.flags.json;
  const key = deriveProjectKey(cwd);
  const dbPath = projectDbPath(home, key);
  if (!existsSync(dbPath)) {
    process.stderr.write(`note: project DB does not exist yet (${dbPath})\n`);
    process.exit(0);
  }
  const db = openDb(dbPath);
  // Re-clone diagnostic: lets the operator confirm this is the right
  // project to wipe. isReclone may be false on long-lived projects;
  // that does not block the reset, it just means the user does not
  // have a re-clone signal to lean on.
  let reclone;
  try {
    reclone = detectReclone(db, key, cwd);
  } catch (e) {
    reclone = { isReclone: false, reason: 'detect failed: ' + (e && e.message) };
  }
  // Dry run: echo the row counts and the diagnostic. The agent or the
  // operator reads this and decides whether to invoke with --apply.
  if (!apply) {
    const counts = resetProjectDryRunCounts(db, key);
    const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
    const out = {
      operation: 'reset_project_dry_run',
      project_key: key,
      cwd,
      reclone,
      row_counts: counts,
      total_rows: totalRows,
      note:
        'dry run: nothing was deleted. Pass --apply to wipe the per-project rows. ' +
        'The global database and every other project DB are never touched.',
    };
    if (asJson) emitJson(out);
    else {
      process.stdout.write(`project_key=${key} cwd=${cwd}\n`);
      process.stdout.write(`reclone.isReclone=${reclone.isReclone}\n`);
      if (reclone.reason) process.stdout.write(`reclone.reason=${reclone.reason}\n`);
      for (const [k2, n] of Object.entries(counts)) {
        process.stdout.write(`${k2}=${n}\n`);
      }
      process.stdout.write(`total_rows=${totalRows}\n`);
      process.stdout.write('note: pass --apply to perform the reset.\n');
    }
    closeDb();
    return;
  }
  // Apply: wipe the per-project rows. resetProject runs in a
  // transaction so a mid-reset error leaves the DB untouched.
  const summary = resetProject(db, key);
  closeDb(dbPath);
  const out = {
    operation: 'reset_project',
    project_key: key,
    cwd,
    reclone,
    ...summary,
  };
  if (asJson) emitJson(out);
  else {
    process.stdout.write(`project_key=${key} cwd=${cwd}\n`);
    process.stdout.write(`memories_deleted=${summary.memories_deleted}\n`);
    process.stdout.write(`working_memory_deleted=${summary.working_memory_deleted}\n`);
    process.stdout.write(`conversations_deleted=${summary.conversations_deleted}\n`);
    process.stdout.write(`conversation_events_deleted=${summary.conversation_events_deleted}\n`);
    process.stdout.write(`memory_edges_deleted=${summary.memory_edges_deleted}\n`);
    process.stdout.write(`memory_synthesizes_deleted=${summary.memory_synthesizes_deleted}\n`);
    process.stdout.write(`project_path_preserved=${summary.project_path_preserved}\n`);
  }
}

// v10 ACL / visibility CLI. Three subcommands:
//
//   acl list   <memory-id> [--cwd <path>] [--scope project|global] [--json]
//     List every ACL grant for a memory.
//
//   acl grant  <memory-id> --principal-kind <user|team|role|agent> --principal-id <id>
//            [--cwd <path>] [--scope project|global] [--json]
//     Insert (or no-op via UNIQUE) a grant row into memories_acl.
//
//   acl revoke <memory-id> --principal-kind <k> --principal-id <id>
//            [--cwd <path>] [--scope project|global] [--json]
//     Delete a grant row. Returns removed=true|false.
function cmdAcl(args) {
  const home = homeDir(args);
  const cwd = resolveCwd(args);
  const sub = (args.positional[0] || '').toString();
  const memId = (args.positional[1] || '').toString();
  const scopeRaw = args.flags.scope ? String(args.flags.scope) : 'project';
  const asJson = !!args.flags.json;

  if (!sub) {
    process.stderr.write('error: acl requires a subcommand (list|grant|revoke)\n');
    process.exit(1);
  }
  if (!memId) {
    process.stderr.write('error: acl requires a memory id (positional)\n');
    process.exit(1);
  }
  if (scopeRaw !== 'project' && scopeRaw !== 'global') {
    process.stderr.write('error: --scope must be project or global\n');
    process.exit(1);
  }
  if (scopeRaw === 'project' && !cwd) {
    process.stderr.write('error: --cwd is required for --scope project\n');
    process.exit(1);
  }
  const key = scopeRaw === 'global' ? GLOBAL_PROJECT_KEY : deriveProjectKey(cwd);
  const dbPath = scopeRaw === 'global' ? globalDbPath(home) : projectDbPath(home, key);
  if (!existsSync(dbPath)) {
    process.stderr.write(`note: ${scopeRaw} DB does not exist yet (${dbPath})\n`);
    process.exit(0);
  }
  const db = openDb(dbPath);

  try {
    if (sub === 'list') {
      const items = listMemoryAcls(db, key, memId);
      const out = { operation: 'acl_list', memory_id: memId, items, count: items.length };
      if (asJson) {
        emitJson(out);
      } else {
        process.stdout.write(`memory_id=${memId}\n`);
        process.stdout.write(`count=${items.length}\n`);
        for (const it of items) {
          process.stdout.write(
            `grant=${it.principal_kind}:${it.principal_id} granted_at=${it.granted_at}\n`,
          );
        }
      }
      closeDb();
      return;
    }

    if (sub === 'grant') {
      const kindRaw = args.flags['principal-kind'] || args.flags.principal_kind;
      const idRaw = args.flags['principal-id'] || args.flags.principal_id;
      if (!kindRaw || !idRaw) {
        process.stderr.write('error: acl grant requires --principal-kind and --principal-id\n');
        process.exit(1);
      }
      try {
        const row = grantMemoryAcl(db, key, memId, String(kindRaw), String(idRaw));
        const out = { operation: 'acl_granted', grant: row };
        if (asJson) {
          emitJson(out);
        } else {
          process.stdout.write(`memory_id=${memId}\n`);
          process.stdout.write(`granted=${row.principal_kind}:${row.principal_id}\n`);
          process.stdout.write(`granted_at=${row.granted_at}\n`);
        }
      } catch (e) {
        process.stderr.write(`error: ${e.message}\n`);
        process.exit(1);
      }
      closeDb();
      return;
    }

    if (sub === 'revoke') {
      const kindRaw = args.flags['principal-kind'] || args.flags.principal_kind;
      const idRaw = args.flags['principal-id'] || args.flags.principal_id;
      if (!kindRaw || !idRaw) {
        process.stderr.write('error: acl revoke requires --principal-kind and --principal-id\n');
        process.exit(1);
      }
      const removed = revokeMemoryAcl(db, key, memId, String(kindRaw), String(idRaw));
      const out = {
        operation: 'acl_revoked',
        memory_id: memId,
        principal_kind: String(kindRaw),
        principal_id: String(idRaw),
        removed,
      };
      if (asJson) {
        emitJson(out);
      } else {
        process.stdout.write(`memory_id=${memId}\n`);
        process.stdout.write(
          `principal=${out.principal_kind}:${out.principal_id}\nremoved=${removed}\n`,
        );
      }
      closeDb();
      return;
    }

    process.stderr.write(`error: unknown acl subcommand: ${sub}\n`);
    process.exit(1);
  } catch (e) {
    try {
      closeDb();
    } catch {
      /* ignore */
    }
    throw e;
  }
}

// Phase 7 — Memory Proxy CLI. Starts an HTTP server that translates
// POST /tools/<name> into the same TOOL_DEFS handlers the stdio MCP
// server uses. Auth is via KIMI_MEMORY_PROXY_TOKEN by default; pass
// --auth-token-env to override, or --no-auth (sets
// KIMI_MEMORY_PROXY_AUTH=off) for dev only.
async function cmdServeHttp(args) {
  const home = homeDir(args);
  const port = args.flags.port ? Number(args.flags.port) : 7331;
  const host = args.flags.host ? String(args.flags.host) : '127.0.0.1';
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    process.stderr.write('error: --port must be 1..65535\n');
    process.exit(1);
  }
  if (args.flags['no-auth']) {
    process.env.KIMI_MEMORY_PROXY_AUTH = 'off';
  }
  const authTokenEnv = args.flags['auth-token-env'] ? String(args.flags['auth-token-env']) : null;
  const authToken = authTokenEnv ? process.env[authTokenEnv] || null : null;
  const proxy = await startProxy({
    host,
    port,
    kimiHomeDir: home,
    pluginRootDir: process.cwd(),
    authToken,
  });
  const shutdown = (signal) => {
    process.stderr.write(`\n[serve-http] received ${signal}, shutting down\n`);
    proxy
      .close()
      .then(() => closeDb())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
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
      '  node src/cli.js recall <query>       [--cwd <path>] [--limit N] [--per-type] [--fusion rrf|weighted] [--rrf-k 60] [--visibility team,private] [--json]',
      '  node src/cli.js prune  [--cwd <path>] [--all-projects] [--apply] [--json]',
      '  node src/cli.js reset-project [--cwd <path>] [--apply] [--json]',
      '  node src/cli.js export <output-file> [--cwd <path>] [--scope project|global|all]',
      '  node src/cli.js import <input-file>  [--cwd <path>] [--scope project|global|all] [--merge|--replace [--yes]]',
      '  node src/cli.js acl list   <memory-id> [--cwd <path>] [--scope project|global] [--json]',
      '  node src/cli.js acl grant  <memory-id> --principal-kind <k> --principal-id <id> [--cwd <path>] [--json]',
      '  node src/cli.js acl revoke <memory-id> --principal-kind <k> --principal-id <id> [--cwd <path>] [--json]',
      '  node src/cli.js serve-http [--port 7331] [--host 127.0.0.1] [--auth-token-env KIMI_MEMORY_PROXY_TOKEN] [--no-auth]',
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
        return cmdList(args);
      case 'get':
        return cmdGet(args);
      case 'status':
        return cmdStatus(args);
      case 'recall':
        return cmdRecall(args);
      case 'prune':
        return cmdPrune(args);
      case 'reset-project':
        return cmdResetProject(args);
      case 'export':
        return cmdExport(args);
      case 'import':
        return cmdImport(args);
      case 'acl':
        return cmdAcl(args);
      case 'serve-http':
        return await cmdServeHttp(args);
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

main().catch((e) => {
  process.stderr.write(`fatal: ${e && e.stack ? e.stack : e}\n`);
  process.exit(2);
});
