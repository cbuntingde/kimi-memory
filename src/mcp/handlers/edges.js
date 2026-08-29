// Edges + similarity MCP handlers (7 tools).
//
//   memory_similar          — vector-only similarity search by seed id
//   memory_link             — typed edge insert (idempotent)
//   memory_unlink           — edge delete by edge_id
//   memory_edges            — list edges touching a memory id
//   memory_merge            — soft-supersede fromId into intoId
//   memory_conclusions_for  — find conclusions that synthesize a memory
//   memory_parents          — parents of a conclusion (inverse of above)
//
// Similar / edges / conclusions_for are read tools that honour the
// read scope semantics (project | global | all); link / unlink /
// merge are write tools (project | global).

import { registerTool } from '../lib/register-tool.js';
import { toolError } from '../lib/tool-error.js';
import { openScopeDb as openScopeDbInner } from '../lib/scope-db.js';
import { TOOL_DEFS_BY_NAME } from '../tool-defs.js';
import {
  validateScope,
  validateId,
  validateLimit,
  validateEdgeKind,
  validateEdgeDirection,
  validateWeight,
} from '../../validation.js';
import {
  similarMemories,
  linkMemory,
  unlinkMemory,
  listEdges,
  mergeMemory,
  listConclusionsFor,
  getParents,
} from '../../persist.js';
import { GLOBAL_PROJECT_KEY, canonicalizeRoot, deriveProjectKey } from '../../project-key.js';

export function register(server, handlers, home) {
  const D = TOOL_DEFS_BY_NAME;

  // ---- memory_similar (vector-only similarity search) ----
  registerTool(
    server,
    D.memory_similar,
    async (args, ctx) => {
      const id = validateId(args.id);
      if (!id.ok) throw toolError(id.error);
      const lim = validateLimit(args.limit, 1, 50, 10);
      if (!lim.ok) throw toolError(lim.error);
      const sc = validateScope(args.scope, { read: true });
      if (!sc.ok) throw toolError(sc.error);
      const threshold =
        typeof args.threshold === 'number' ? Math.max(0, Math.min(1, args.threshold)) : 0.6;
      const scope = sc.value;
      const merged = [];
      if (scope === 'project' || scope === 'all') {
        const target = openScopeDbInner({ cwd: ctx.cwd, scope: 'project', home });
        const items = await similarMemories(target.db, target.projectKey, id.value, {
          limit: lim.value,
          threshold,
        });
        merged.push(...items.map((m) => ({ ...m, scope: 'project' })));
      }
      if (scope === 'global' || scope === 'all') {
        const target = openScopeDbInner({ cwd: ctx.cwd, scope: 'global', home });
        if (target.db) {
          const items = await similarMemories(target.db, GLOBAL_PROJECT_KEY, id.value, {
            limit: lim.value,
            threshold,
          });
          merged.push(...items.map((m) => ({ ...m, scope: 'global' })));
        }
      }
      // Sort across scopes by similarity desc, then trim to limit.
      merged.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
      const items = merged.slice(0, lim.value);
      return {
        operation: 'similar',
        scope,
        id: id.value,
        threshold,
        items,
        count: items.length,
        project_key:
          scope === 'global'
            ? GLOBAL_PROJECT_KEY
            : deriveProjectKey(canonicalizeRoot(ctx.cwd) || ctx.cwd),
      };
    },
    handlers,
    home,
  );

  // ---- memory_link (typed edge insert; idempotent) ----
  registerTool(
    server,
    D.memory_link,
    async (args, ctx) => {
      const fromId = validateId(args.from_id);
      if (!fromId.ok) throw toolError(fromId.error);
      const toId = validateId(args.to_id);
      if (!toId.ok) throw toolError(toId.error);
      if (fromId.value === toId.value) throw toolError('from_id and to_id must differ');
      const kind = validateEdgeKind(args.kind);
      if (!kind.ok) throw toolError(kind.error);
      const w = validateWeight(args.weight);
      if (!w.ok) throw toolError(w.error);
      const edge = linkMemory(ctx.db, ctx.projectKey, fromId.value, toId.value, kind.value, {
        weight: w.value,
      });
      return { operation: 'linked', scope: ctx.scope, edge, project_key: ctx.projectKey };
    },
    handlers,
    home,
  );

  // ---- memory_unlink (edge delete by id) ----
  registerTool(
    server,
    D.memory_unlink,
    async (args, ctx) => {
      const edgeId = validateId(args.edge_id);
      if (!edgeId.ok) throw toolError(edgeId.error);
      const removed = unlinkMemory(ctx.db, ctx.projectKey, edgeId.value);
      return {
        operation: 'unlinked',
        scope: ctx.scope,
        edge_id: edgeId.value,
        removed,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- memory_edges (list edges touching a memory; scope='all' merges) ----
  registerTool(
    server,
    D.memory_edges,
    async (args, ctx) => {
      const sc = validateScope(args.scope, { read: true });
      if (!sc.ok) throw toolError(sc.error);
      const id = validateId(args.id);
      if (!id.ok) throw toolError(id.error);
      const dir = validateEdgeDirection(args.direction);
      if (!dir.ok) throw toolError(dir.error);
      const kind = args.kind ? validateEdgeKind(args.kind) : { ok: true, value: null };
      if (!kind.ok) throw toolError(kind.error);
      const scope = sc.value;
      const merged = [];
      if (scope === 'project' || scope === 'all') {
        const target = openScopeDbInner({ cwd: ctx.cwd, scope: 'project', home });
        const items = listEdges(target.db, target.projectKey, id.value, {
          direction: dir.value,
          kind: kind.value,
        });
        merged.push(...items.map((e) => ({ ...e, scope: 'project' })));
      }
      if (scope === 'global' || scope === 'all') {
        const target = openScopeDbInner({ cwd: ctx.cwd, scope: 'global', home });
        if (target.db) {
          const items = listEdges(target.db, GLOBAL_PROJECT_KEY, id.value, {
            direction: dir.value,
            kind: kind.value,
          });
          merged.push(...items.map((e) => ({ ...e, scope: 'global' })));
        }
      }
      // Sort by created_at desc; ties broken by kind alphabetical.
      merged.sort((a, b) => {
        const tc = (b.created_at || '').localeCompare(a.created_at || '');
        return tc !== 0 ? tc : (a.kind || '').localeCompare(b.kind || '');
      });
      return {
        operation: 'edges',
        scope,
        id: id.value,
        direction: dir.value,
        kind: kind.value,
        items: merged,
        count: merged.length,
        project_key:
          scope === 'global'
            ? GLOBAL_PROJECT_KEY
            : deriveProjectKey(canonicalizeRoot(ctx.cwd) || ctx.cwd),
      };
    },
    handlers,
    home,
  );

  // ---- memory_merge (soft-supersede fromId into intoId; union tags; record supersedes edge) ----
  registerTool(
    server,
    D.memory_merge,
    async (args, ctx) => {
      const into = validateId(args.into_id);
      if (!into.ok) throw toolError(into.error);
      const from = validateId(args.from_id);
      if (!from.ok) throw toolError(from.error);
      if (into.value === from.value) throw toolError('into_id and from_id must differ');
      const w = validateWeight(args.weight);
      if (!w.ok) throw toolError(w.error);
      const r = mergeMemory(ctx.db, ctx.projectKey, into.value, from.value, {
        mergedContent: typeof args.merged_content === 'string' ? args.merged_content : null,
        weight: w.value,
      });
      return {
        operation: 'merged',
        scope: ctx.scope,
        into: r.into,
        from: r.from,
        edge: r.edge,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- memory_conclusions_for (find conclusions that synthesize a memory) ----
  registerTool(
    server,
    D.memory_conclusions_for,
    async (args, ctx) => {
      const sc = validateScope(args.scope, { read: true });
      if (!sc.ok) throw toolError(sc.error);
      const id = validateId(args.id);
      if (!id.ok) throw toolError(id.error);
      const lim = validateLimit(args.limit, 1, 200, 50);
      if (!lim.ok) throw toolError(lim.error);
      const scope = sc.value;
      const merged = [];
      if (scope === 'project' || scope === 'all') {
        const target = openScopeDbInner({ cwd: ctx.cwd, scope: 'project', home });
        const items = listConclusionsFor(target.db, target.projectKey, id.value, {
          limit: lim.value,
        });
        merged.push(...items.map((m) => ({ ...m, scope: 'project' })));
      }
      if (scope === 'global' || scope === 'all') {
        const target = openScopeDbInner({ cwd: ctx.cwd, scope: 'global', home });
        if (target.db) {
          const items = listConclusionsFor(target.db, GLOBAL_PROJECT_KEY, id.value, {
            limit: lim.value,
          });
          merged.push(...items.map((m) => ({ ...m, scope: 'global' })));
        }
      }
      merged.sort((a, b) => {
        const tc = (b.updated_at || '').localeCompare(a.updated_at || '');
        return tc !== 0 ? tc : (b.priority || 0) - (a.priority || 0);
      });
      const items = merged.slice(0, lim.value);
      return {
        operation: 'conclusions_for',
        scope,
        id: id.value,
        items,
        count: items.length,
        project_key:
          scope === 'global'
            ? GLOBAL_PROJECT_KEY
            : deriveProjectKey(canonicalizeRoot(ctx.cwd) || ctx.cwd),
      };
    },
    handlers,
    home,
  );

  // ---- memory_parents (inverse: parents of a conclusion) ----
  registerTool(
    server,
    D.memory_parents,
    async (args, ctx) => {
      const id = validateId(args.id);
      if (!id.ok) throw toolError(id.error);
      const lim = validateLimit(args.limit, 1, 500, 200);
      if (!lim.ok) throw toolError(lim.error);
      if (!ctx.db) throw toolError(`memory not found: ${id.value}`);
      const items = getParents(ctx.db, ctx.projectKey, id.value, { limit: lim.value });
      return {
        operation: 'parents',
        scope: ctx.scope,
        id: id.value,
        items,
        count: items.length,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );
}
