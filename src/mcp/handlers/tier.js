// Tier / persona MCP handlers (4 tools, gated).
//
//   memory_set_tier      — explicit move to a target tier; writes audit row
//   memory_promote       — tier up by one
//   memory_demote        — tier down by one
//   memory_tier_history  — audit log of tier transitions for a memory
//
// Gated by KIMI_MEMORY_LEGACY_SUBSYSTEMS (default 'on'). See
// AGENTS.md §Subsystem deprecation. Schema columns stay in place
// when the gate is off so flipping back on requires no migration.

import { registerTool } from '../lib/register-tool.js';
import { toolError } from '../lib/tool-error.js';
import { TOOL_DEFS_BY_NAME } from '../tool-defs.js';
import { validateId, validateLimit } from '../../validation.js';
import {
  setMemoryTier,
  promoteMemory,
  demoteMemory,
  listTierHistory,
} from '../../persist/share.js';

export function register(server, handlers, home) {
  if (process.env.KIMI_MEMORY_LEGACY_SUBSYSTEMS === 'off') return;
  const D = TOOL_DEFS_BY_NAME;

  // ---- memory_set_tier ----
  registerTool(
    server,
    D.memory_set_tier,
    async (args, ctx) => {
      const memId = validateId(args.memory_id);
      if (!memId.ok) throw toolError(memId.error);
      const result = setMemoryTier(ctx.db, ctx.projectKey, memId.value, args.tier, {
        reason: args.reason || null,
      });
      if (!result.memory) throw toolError(`memory not found in ${ctx.scope}: ${memId.value}`);
      return {
        operation: 'set_tier',
        scope: ctx.scope,
        memory: result.memory,
        transition: result.transition,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- memory_promote ----
  registerTool(
    server,
    D.memory_promote,
    async (args, ctx) => {
      const memId = validateId(args.memory_id);
      if (!memId.ok) throw toolError(memId.error);
      const result = promoteMemory(ctx.db, ctx.projectKey, memId.value, {
        reason: args.reason || null,
      });
      if (!result.memory) throw toolError(`memory not found in ${ctx.scope}: ${memId.value}`);
      return {
        operation: 'promote',
        scope: ctx.scope,
        memory: result.memory,
        transition: result.transition,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- memory_demote ----
  registerTool(
    server,
    D.memory_demote,
    async (args, ctx) => {
      const memId = validateId(args.memory_id);
      if (!memId.ok) throw toolError(memId.error);
      const result = demoteMemory(ctx.db, ctx.projectKey, memId.value, {
        reason: args.reason || null,
      });
      if (!result.memory) throw toolError(`memory not found in ${ctx.scope}: ${memId.value}`);
      return {
        operation: 'demote',
        scope: ctx.scope,
        memory: result.memory,
        transition: result.transition,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- memory_tier_history ----
  registerTool(
    server,
    D.memory_tier_history,
    async (args, ctx) => {
      const memId = validateId(args.memory_id);
      if (!memId.ok) throw toolError(memId.error);
      const lim = validateLimit(args.limit, 1, 500, 200);
      if (!lim.ok) throw toolError(lim.error);
      const items = listTierHistory(ctx.db, ctx.projectKey, memId.value, {
        limit: lim.value,
      });
      return {
        operation: 'tier_history',
        scope: ctx.scope,
        memory_id: memId.value,
        items,
        count: items.length,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );
}
