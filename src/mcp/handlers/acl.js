// ACL / visibility MCP handlers (5 tools, gated).
//
//   acl_grant            — insert a grant into memories_acl (idempotent)
//   acl_revoke           — delete a grant
//   acl_list             — enumerate grants for a memory
//   acl_share_memory     — promote rows to a new visibility level
//   acl_resolve_principal— parse a "kind:id" descriptor (pure)
//
// Gated by KIMI_MEMORY_LEGACY_SUBSYSTEMS (default 'on'). When the
// env var is 'off', register() returns early without touching the
// server, so the legacy tools vanish from the agent's tool surface.
// Schema tables stay in place so flipping the env var back on
// requires no migration. See AGENTS.md §Subsystem deprecation.

import { registerTool } from '../lib/register-tool.js';
import { toolError } from '../lib/tool-error.js';
import { TOOL_DEFS_BY_NAME } from '../tool-defs.js';
import { validateId } from '../../validation.js';
import {
  grantMemoryAcl,
  revokeMemoryAcl,
  listMemoryAcls,
  parsePrincipalDescriptor,
  validatePrincipalKind,
  validateSharedWith,
} from '../../acl.js';
import { shareMemory } from '../../persist/share.js';
import { sharedDbPath } from '../../persist.js';

export function register(server, handlers, home) {
  if (process.env.KIMI_MEMORY_LEGACY_SUBSYSTEMS === 'off') return;
  const D = TOOL_DEFS_BY_NAME;

  // ---- acl_grant ----
  registerTool(
    server,
    D.acl_grant,
    async (args, ctx) => {
      const memId = validateId(args.memory_id);
      if (!memId.ok) throw toolError(memId.error);
      const kind = validatePrincipalKind(args.principal_kind);
      const row = grantMemoryAcl(ctx.db, ctx.projectKey, memId.value, kind, args.principal_id);
      return {
        operation: 'acl_granted',
        scope: ctx.scope,
        grant: row,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- acl_revoke ----
  registerTool(
    server,
    D.acl_revoke,
    async (args, ctx) => {
      const memId = validateId(args.memory_id);
      if (!memId.ok) throw toolError(memId.error);
      const kind = validatePrincipalKind(args.principal_kind);
      const removed = revokeMemoryAcl(ctx.db, ctx.projectKey, memId.value, kind, args.principal_id);
      return {
        operation: 'acl_revoked',
        scope: ctx.scope,
        memory_id: memId.value,
        principal_kind: kind,
        principal_id: args.principal_id,
        removed,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- acl_list ----
  registerTool(
    server,
    D.acl_list,
    async (args, ctx) => {
      const memId = validateId(args.memory_id);
      if (!memId.ok) throw toolError(memId.error);
      const items = listMemoryAcls(ctx.db, ctx.projectKey, memId.value);
      return {
        operation: 'acl_list',
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

  // ---- acl_share_memory ----
  registerTool(
    server,
    D.acl_share_memory,
    async (args, ctx) => {
      if (!Array.isArray(args.memory_ids) || args.memory_ids.length === 0) {
        throw toolError('memory_ids must be a non-empty array');
      }
      if (args.memory_ids.length > 500) {
        throw toolError('memory_ids must contain at most 500 entries');
      }
      const swResult = validateSharedWith(args.shared_with);
      const sharedWith = swResult.value;
      const droppedSharedWith = swResult.dropped;
      const result = shareMemory(ctx.db, ctx.projectKey, args.memory_ids, {
        visibility: args.visibility,
        sharedWith,
        toSharedPool: !!args.to_shared_pool,
        kimiHomeDir: home,
      });
      // Surface dropped entries so the caller knows input was lost.
      // (Audit finding B4-10.)
      return {
        operation: 'acl_shared',
        scope: ctx.scope,
        visibility: args.visibility,
        shared_with: sharedWith,
        dropped_shared_with: droppedSharedWith.length ? droppedSharedWith : undefined,
        to_shared_pool: !!args.to_shared_pool,
        moved: result.moved,
        updated: result.updated,
        target_shared_db_path: args.to_shared_pool ? sharedDbPath(home) : null,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- acl_resolve_principal (pure / read-only) ----
  registerTool(
    server,
    D.acl_resolve_principal,
    async (args) => {
      if (!args.descriptor) throw toolError('descriptor is required');
      const parsed = parsePrincipalDescriptor(args.descriptor);
      return {
        operation: 'acl_resolve_principal',
        descriptor: args.descriptor,
        kind: parsed ? parsed.kind : null,
        id: parsed ? parsed.id : null,
        valid: !!parsed,
      };
    },
    handlers,
    home,
  );
}
