// Maintenance MCP handlers (3 tools).
//
//   memory_prune          — orphan-project DB cleanup (dry-run by default)
//   memory_diagnostics    — recent error logs + error summary
//   memory_reset_project  — wipe the per-project rows (dry-run by default)
//
// memory_prune and memory_diagnostics are read tools; reset_project
// is the only destructive one — gated by `confirm: true` so a
// dry-run is the default surface.

import { registerTool } from '../lib/register-tool.js';
import { toolError } from '../lib/tool-error.js';
import { TOOL_DEFS_BY_NAME } from '../tool-defs.js';
import { deriveProjectKey, projectDbPath } from '../../project-key.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { openDb, closeDb, resetProject, resetProjectDryRunCounts } from '../../persist.js';
import { detectReclone } from '../../persist/project.js';
import { enumeratePruneCandidates } from '../../prune.js';
import { getRecentLogs, getErrorSummary } from '../../diagnostics.js';

export function register(server, handlers, home) {
  const D = TOOL_DEFS_BY_NAME;

  // ---- memory_prune (orphan-project cleanup) ----
  registerTool(
    server,
    { ...D.memory_prune, skipScopeValidation: true, skipDb: true },
    async (args, ctx) => {
      const scope = args.scope === 'all-projects' ? 'all-projects' : 'project';
      const apply = !!args.apply;
      const activeKey = deriveProjectKey(ctx.cwd);
      const { candidates, note } = enumeratePruneCandidates({
        home,
        activeKey,
        scope,
        apply,
      });
      if (note) {
        return {
          operation: 'pruned',
          scope,
          apply,
          candidates: [],
          removed: 0,
          note,
        };
      }
      const removed = candidates.filter((c) => c.action === 'removed').length;
      return {
        operation: 'pruned',
        scope,
        apply,
        active_project_key: activeKey,
        candidates,
        orphan_count: candidates.filter(
          (c) => c.action === 'would-remove' || c.action === 'removed',
        ).length,
        removed,
        note: 'global database is preserved (cross-project by definition)',
      };
    },
    handlers,
    home,
  );

  // ---- memory_diagnostics (error logs and system observability) ----
  registerTool(
    server,
    D.memory_diagnostics,
    async (args) => {
      const hoursBack = args.hours_back || 24;
      const limit = args.limit || 100;
      const typeFilter = args.type_filter || null;
      const recent = await getRecentLogs(limit, typeFilter);
      const summary = await getErrorSummary(hoursBack);
      return {
        operation: 'diagnostics',
        recent_logs: recent,
        error_summary: summary,
        hours_back: hoursBack,
        log_location: path.join(home, 'kimi-memory', '_diagnostics', 'hooks.log'),
        note: 'Recent logs are ordered most-recent-first. Use type_filter to focus on specific error types.',
      };
    },
    handlers,
    home,
  );

  // ---- memory_reset_project (wipe a single project's data) ----
  // Re-cloned repos share the project_key with the previous incarnation
  // (project_key = SHA-256 prefix of canonical path), so the only way to
  // discard the stale memories + working memory + session archive is to
  // delete the rows. The global DB and every other project DB are never
  // touched. The call is a dry run unless `confirm: true` is set; the
  // dry-run path returns the same shape so the caller (or a slash
  // command UI) can render a confirmation prompt before deleting.
  //
  // skipDb: the handler manages its own DB handle via openDb() because
  // it must detect a missing project DB on the read path (a dry run
  // or a confirm=true call on a project that has never been written
  // to). The wrapper's openScopeDb would lazy-create the file via
  // openDb({create:true}), defeating that check.
  registerTool(
    server,
    { ...D.memory_reset_project, skipDb: true },
    async (args, ctx) => {
      const key = deriveProjectKey(ctx.cwd);
      const dbPath = projectDbPath(home, key);
      if (!existsSync(dbPath)) {
        throw toolError(`no project DB at ${dbPath} (project has not been written to yet)`);
      }
      // Re-clone check: when stale memory is the reason for the reset,
      // surface the diagnostic so the user can confirm. The check is
      // read-only and never blocks the call.
      const handle = openDb(dbPath);
      let reclone = null;
      try {
        reclone = detectReclone(handle, key, ctx.cwd);
      } catch (e) {
        reclone = { isReclone: false, reason: 'detect failed (see diagnostics)' };
      }
      // Always run the dry-run counter first so we can echo what would
      // be deleted. The destructive path uses a transaction, so a
      // confirm=true call that errors partway through still leaves the
      // DB in a known state (rolled back).
      const counts = resetProjectDryRunCounts(handle, key);
      const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
      const confirm = args.confirm === true;
      if (!confirm) {
        return {
          operation: 'reset_project_dry_run',
          project_key: key,
          cwd: ctx.cwd,
          reclone,
          row_counts: counts,
          total_rows: totalRows,
          note:
            'dry run: nothing was deleted. Pass confirm=true to wipe the per-project rows. ' +
            'The global database and every other project DB are never touched.',
        };
      }
      const summary = resetProject(handle, key, { canonicalRoot: ctx.cwd });
      // Drop the cached handle so the next open re-reads the file.
      closeDb(dbPath);
      return {
        operation: 'reset_project',
        project_key: key,
        cwd: ctx.cwd,
        reclone,
        ...summary,
        note:
          'per-project rows deleted. The global database and every other project DB were not touched. ' +
          'first_seen_at was reset to now, so the re-clone warning will not fire again until a new incarnation is recorded.',
      };
    },
    handlers,
    home,
  );
}
