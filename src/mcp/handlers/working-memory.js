// Working-memory MCP handlers (3 tools, project-scoped only).
//
//   working_memory_set    — write a slot
//   working_memory_get    — read a slot
//   working_memory_clear  — drop a slot
//
// Working memory lives per-project (no scope arg on the wire —
// the tool surface rejects the scope parameter and the wrapper's
// default `validateScope` would reject `global` for a write tool).

import { registerTool } from '../lib/register-tool.js';
import { toolError } from '../lib/tool-error.js';
import { TOOL_DEFS_BY_NAME } from '../tool-defs.js';
import { validateSlot } from '../../validation.js';
import { setWorkingMemory, getWorkingMemory, clearWorkingMemory } from '../../persist.js';

export function register(server, handlers, home) {
  const D = TOOL_DEFS_BY_NAME;

  // ---- working_memory_set ----
  registerTool(
    server,
    D.working_memory_set,
    async (args, ctx) => {
      const slot = validateSlot(args.slot);
      if (!slot.ok) throw toolError(slot.error);
      if (!args.value) throw toolError('value is required');
      const r = setWorkingMemory(ctx.db, ctx.projectKey, slot.value, args.value);
      return {
        operation: 'wm_set',
        slot: r.slot,
        value: r.value,
        updated_at: r.updated_at,
        project_key: ctx.projectKey,
        warning: slot.warning || null,
      };
    },
    handlers,
    home,
  );

  // ---- working_memory_get ----
  registerTool(
    server,
    D.working_memory_get,
    async (args, ctx) => {
      const slot = validateSlot(args.slot);
      if (!slot.ok) throw toolError(slot.error);
      const r = getWorkingMemory(ctx.db, ctx.projectKey, slot.value);
      return {
        operation: 'wm_get',
        slot: slot.value,
        value: r ? r.value : null,
        updated_at: r ? r.updated_at : null,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- working_memory_clear ----
  registerTool(
    server,
    D.working_memory_clear,
    async (args, ctx) => {
      const slot = validateSlot(args.slot);
      if (!slot.ok) throw toolError(slot.error);
      const cleared = clearWorkingMemory(ctx.db, ctx.projectKey, slot.value);
      return { operation: 'wm_clear', slot: slot.value, cleared, project_key: ctx.projectKey };
    },
    handlers,
    home,
  );
}
