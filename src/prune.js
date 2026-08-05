// Shared implementation of the memory_prune walk. Both the MCP tool
// (server.js → memory_prune) and the standalone CLI (cli.js → cmdPrune)
// need to enumerate project DBs, decide whether each is an orphan, and
// optionally delete the directory. The directory walk, DB inspection,
// and rmSync are identical between the two call sites; only the output
// rendering differs. This module owns the walk and returns a structured
// list; the call sites decorate it.
//
// `scope` is 'project' (active only) or 'all-projects' (every project
// except the active one, plus the active as 'kept-active'). `apply`
// controls destructive deletion — when false, the action is reported as
// 'would-remove' for orphans. The active project is never removed and
// is always reported so the user sees the check ran for it.
import { readdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { GLOBAL_PROJECT_KEY } from './project-key.js';
import { openDb, closeDb, listProjectPaths } from './persist.js';

export function enumeratePruneCandidates({ home, activeKey, scope, apply }) {
  const memDir = path.join(home, 'kimi-memory');
  const allProjects = scope === 'all-projects';
  let entries = [];
  try {
    entries = readdirSync(memDir, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return { candidates: [], note: 'no kimi-memory data directory yet' };
    throw e;
  }
  // Always include the active project so the user sees it was checked
  // (it is never removed). For all-projects we also include every
  // sibling project.
  const projectDirs = entries
    .filter((d) => d.isDirectory() && d.name !== GLOBAL_PROJECT_KEY)
    .filter((d) => d.name === activeKey || allProjects)
    .map((d) => ({
      key: d.name,
      dir: path.join(memDir, d.name),
      db: path.join(memDir, d.name, 'memory.sqlite'),
    }));

  const candidates = [];
  for (const p of projectDirs) {
    let recordedRoot = null;
    let firstSeenAt = null;
    let lastSeenAt = null;
    if (existsSync(p.db)) {
      try {
        const handle = openDb(p.db);
        const rows = listProjectPaths(handle);
        const row = rows.find((r) => r.project_key === p.key);
        if (row) {
          recordedRoot = row.canonical_root;
          firstSeenAt = row.first_seen_at;
          lastSeenAt = row.last_seen_at;
        }
        closeDb(p.db);
      } catch (e) {
        candidates.push({
          project_key: p.key,
          db_path: p.db,
          canonical_root: null,
          exists_on_disk: null,
          first_seen_at: null,
          last_seen_at: null,
          action: apply ? 'error' : 'would-keep',
          error: 'failed to read project_paths: ' + (e && e.message),
        });
        continue;
      }
    } else if (!existsSync(p.dir)) {
      // Empty project dir; nothing to do.
      continue;
    }
    const existsOnDisk = recordedRoot ? existsSync(recordedRoot) : null;
    const isActive = p.key === activeKey;
    if (isActive) {
      candidates.push({
        project_key: p.key,
        db_path: p.db,
        canonical_root: recordedRoot,
        exists_on_disk: existsOnDisk,
        first_seen_at: firstSeenAt,
        last_seen_at: lastSeenAt,
        action: 'kept-active',
      });
      continue;
    }
    if (existsOnDisk === false) {
      let action = 'would-remove';
      if (apply) {
        try {
          // Drop the cached handle before deleting the file.
          closeDb(p.db);
          rmSync(p.dir, { recursive: true, force: true });
          action = 'removed';
        } catch (e) {
          candidates.push({
            project_key: p.key,
            db_path: p.db,
            canonical_root: recordedRoot,
            exists_on_disk: existsOnDisk,
            first_seen_at: firstSeenAt,
            last_seen_at: lastSeenAt,
            action: 'error',
            error: e && e.message,
          });
          continue;
        }
      } else {
        // Dry run: ensure the DB handle isn't holding a lock on a file
        // we might want to keep.
        closeDb(p.db);
      }
      candidates.push({
        project_key: p.key,
        db_path: p.db,
        canonical_root: recordedRoot,
        exists_on_disk: existsOnDisk,
        first_seen_at: firstSeenAt,
        last_seen_at: lastSeenAt,
        action,
      });
    } else {
      candidates.push({
        project_key: p.key,
        db_path: p.db,
        canonical_root: recordedRoot,
        exists_on_disk: existsOnDisk,
        first_seen_at: firstSeenAt,
        last_seen_at: lastSeenAt,
        action: 'kept',
      });
    }
  }
  return { candidates, activeKey };
}
