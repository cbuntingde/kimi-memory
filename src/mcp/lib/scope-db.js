// Shared DB + response helpers for every MCP handler.
//
// Extracted from src/server.js so the per-domain handler modules
// (src/mcp/handlers/*.js) can call them without duplicating the
// `openScopeDb` logic, and so the `registerTool` wrapper has one
// canonical place to obtain a project-scope DB handle.
//
// The shape and semantics are byte-identical to the previous
// in-server.js versions: every caller (the 50 inline tool handlers
// in the old server.js) saw the same return values and side effects.

import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  canonicalizeRoot,
  deriveProjectKey,
  projectDbPath,
  globalDbPath,
  GLOBAL_PROJECT_KEY,
} from '../../project-key.js';
import { openDb } from '../../persist.js';
import { recordProjectPath } from '../../persist/project.js';

// Resolve the database handle and key for a given scope. `cwd` is
// required for `project` and `all`; for `global` it is audit context
// (caller must still pass it for provenance purposes) but does not
// choose the database.
//
// `record` controls whether the canonical project root is stamped
// into `project_paths` for this open, AND whether the parent
// directory is lazy-created. Write tools pass `true`; read tools
// pass `false` so a recall on a slow network share does not pay a
// write per call and does not produce a side effect on disk.
// (Audit finding B1-1 / B2-5.)
export function openScopeDb({ cwd, scope, record = false, home }) {
  if (!home) throw new Error('openScopeDb requires {home}');
  if (scope === 'global') {
    const dbPath = globalDbPath(home);
    // Read paths must not create the global DB on a fresh install —
    // PROJECT.md §3 contract. openDb's `create: true` flag would
    // otherwise touch the file on every `memory_recall` / `memory_list`
    // / `memory_status` over scope='global'. (Audit flag B1-1/B2-5.)
    if (!existsSync(dbPath)) {
      if (record) mkdirSync(path.dirname(dbPath), { recursive: true });
      else return { db: null, projectKey: GLOBAL_PROJECT_KEY, cwd: cwd || null };
    }
    if (record) mkdirSync(path.dirname(dbPath), { recursive: true });
    return { db: openDb(dbPath), projectKey: GLOBAL_PROJECT_KEY, cwd: cwd || null };
  }
  if (!cwd) throw new Error('project cwd is required');
  const c = canonicalizeRoot(cwd);
  if (!c) throw new Error('invalid project cwd');
  const key = deriveProjectKey(c);
  if (record) mkdirSync(path.dirname(projectDbPath(home, key)), { recursive: true });
  const db = openDb(projectDbPath(home, key));
  if (record) recordProjectPath(db, key, c);
  return { db, projectKey: key, cwd: c };
}

// Wrap a successful payload in the MCP tool-result content array.
// Kept identical to the in-server.js version: every existing tool
// depends on `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`.
export function ok(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
  };
}

// Wrap a user-facing error message in the MCP tool-result content
// array. The `isError: true` flag is honored by MCP-aware clients;
// older clients ignore it and still display the text body.
export function textError(message) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: message }),
      },
    ],
  };
}

// Best-effort, bounded merge. Sorts each scope independently by the
// caller-supplied timestamp (most-recent-first), then concatenates
// project rows first followed by global rows. This keeps the
// "project hits first" promise in the docs while still surfacing
// the freshest hits within each scope. The combined result is
// truncated to `limit` rows.
//
// Used by memory_recall and memory_list when scope='all'. Extracted
// from src/server.js so per-domain handler modules can import it
// without reaching back into the orchestrator.
export function mergeWithScope(projectRows, globalRows, { limit, deriveTimestamp }) {
  const byTimeDesc = (a, b) => {
    const ta = deriveTimestamp(a) || '';
    const tb = deriveTimestamp(b) || '';
    if (ta === tb) return 0;
    return tb.localeCompare(ta);
  };
  const projectSorted = [...projectRows].sort(byTimeDesc).map((r) => ({ ...r, scope: 'project' }));
  const globalSorted = [...globalRows].sort(byTimeDesc).map((r) => ({ ...r, scope: 'global' }));
  return {
    items: [...projectSorted, ...globalSorted].slice(0, limit),
    project_count: projectRows.length,
    global_count: globalRows.length,
  };
}
