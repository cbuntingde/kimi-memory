// Cross-project promotion MCP handler.
//
//   memory_promote_to_global — move one or more project memories into
//                              the cross-project _global store.
//
// This handler is intentionally separate from the ACL share surface
// (src/mcp/handlers/acl.js): acl_share_memory targets the deprecated
// _shared/memory.sqlite pool (gated behind
// KIMI_MEMORY_LEGACY_SUBSYSTEMS), while memory_promote_to_global
// targets the always-on _global/memory.sqlite store. The two surfaces
// have different semantics (ACL-gated vs user-private), different
// visibility defaults, and different lifecycles; conflating them
// would re-introduce the deprecated behaviour under a new name.

import { registerTool } from '../lib/register-tool.js';
import { toolError } from '../lib/tool-error.js';
import { TOOL_DEFS_BY_NAME } from '../tool-defs.js';
import { validateId } from '../../validation.js';
import { promoteMemoryToGlobal } from '../../persist.js';
import { openDb } from '../../persist.js';
import { globalDbPath } from '../../project-key.js';

export function register(server, handlers, home) {
  const D = TOOL_DEFS_BY_NAME;

  // ---- memory_promote_to_global ----
  registerTool(
    server,
    D.memory_promote_to_global,
    async (args, ctx) => {
      // Validate the id list. Each id is checked individually so the
      // caller sees every bad id in a single response rather than
      // fixing them one round-trip at a time.
      if (!Array.isArray(args.memory_ids) || args.memory_ids.length === 0) {
        throw toolError('memory_ids must be a non-empty array');
      }
      if (args.memory_ids.length > 500) {
        throw toolError('memory_ids must contain at most 500 entries');
      }
      const cleaned = [];
      const dropped = [];
      const seen = new Set();
      for (const raw of args.memory_ids) {
        const v = validateId(raw);
        if (!v.ok) {
          dropped.push({ id: String(raw), reason: v.error });
          continue;
        }
        if (seen.has(v.value)) {
          dropped.push({ id: v.value, reason: 'duplicate' });
          continue;
        }
        seen.add(v.value);
        cleaned.push(v.value);
      }
      if (cleaned.length === 0) {
        throw toolError(
          `every memory id failed validation: ${dropped.map((d) => d.reason).join('; ')}`,
        );
      }
      // Run the move. promoteMemoryToGlobal opens the global DB
      // itself (lazily creating the file on first write) so the MCP
      // layer only needs to pass the project DB and the home dir.
      const result = promoteMemoryToGlobal(ctx.db, ctx.projectKey, cleaned, {
        kimiHomeDir: home,
      });
      // Defensive confirm: open the global DB and verify a row landed
      // for each moved id. Skipped rows carry the persist-layer reason;
      // we surface them so the agent can decide whether to retry or
      // bail.
      const globalDb = openDb(globalDbPath(home));
      const confirmedMoves = [];
      const droppedMoves = [];
      for (const m of result.moved) {
        const row = globalDb
          .prepare('SELECT id, type, title FROM memories WHERE id=? AND project_key=?')
          .get(m.id, '_global');
        if (row) {
          confirmedMoves.push({
            id: m.id,
            new_global_id: m.new_global_id,
            type: row.type,
            title: row.title,
          });
        } else {
          // The move reports success but the row is absent — surface
          // this as a dropped move so the agent can retry.
          droppedMoves.push({ id: m.id, reason: 'global_write_missing' });
        }
      }
      const allSkipped = [...result.skipped, ...dropped, ...droppedMoves];
      return {
        operation: 'promoted_to_global',
        scope: ctx.scope,
        project_key: ctx.projectKey,
        moved: confirmedMoves,
        skipped: allSkipped.length ? allSkipped : undefined,
        // Convenience count so dashboards can show one number without
        // iterating the moved array.
        moved_count: confirmedMoves.length,
        skipped_count: allSkipped.length,
      };
    },
    handlers,
    home,
  );
}
