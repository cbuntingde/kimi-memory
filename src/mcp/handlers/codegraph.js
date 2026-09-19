// CodeGraph MCP handlers (6 tools, gated).
//
//   codegraph_extract       — walk a directory, emit per-file symbol lists
//   codegraph_build_edges   — form call-graph edges between memories
//   codegraph_query_symbol  — BFS from a seed
//   codegraph_impact_path   — BFS shortest path between two ids
//   codegraph_callers       — neighbours with the given kind
//   codegraph_callees       — neighbours with the given kind
//
// Gated by KIMI_MEMORY_LEGACY_SUBSYSTEMS (default 'on'). See
// AGENTS.md §Subsystem deprecation.
//
// codegraph_extract carries a project-boundary guard at server.js:1731
// — the root must resolve inside the project cwd; otherwise a
// recalled memory could walk arbitrary directories (audit H1/B1-2).
// The same guard is preserved here.

import { registerTool } from '../lib/register-tool.js';
import { toolError } from '../lib/tool-error.js';
import { TOOL_DEFS_BY_NAME } from '../tool-defs.js';
import { validateLimit, validateId } from '../../validation.js';
import { extractCodeGraph, buildCodeGraphEdges, queryMemoryGraph } from '../../codegraph.js';
import path from 'node:path';

export function register(server, handlers, home) {
  if (process.env.KIMI_MEMORY_LEGACY_SUBSYSTEMS === 'off') return;
  const D = TOOL_DEFS_BY_NAME;

  // ---- codegraph_extract ----
  registerTool(
    server,
    D.codegraph_extract,
    async (args, ctx) => {
      const rawRoot = args.root && args.root.length > 0 ? args.root : ctx.cwd;
      // Refuse roots that escape the project boundary — otherwise a
      // prompt-injection attack via a recalled memory could walk
      // arbitrary directories. (Audit finding H1 / B1-2.)
      const root = path.resolve(rawRoot);
      const projectRoot = path.resolve(ctx.cwd);
      if (root !== projectRoot && !root.startsWith(projectRoot + path.sep)) {
        throw toolError(
          `codegraph_extract root must be within the project directory (${projectRoot}); got ${root}`,
        );
      }
      const lim = validateLimit(args.limit, 1, 5000, 200);
      if (!lim.ok) throw toolError(lim.error);
      const files = await extractCodeGraph(root, { limit: lim.value });
      return {
        operation: 'codegraph_extract',
        root,
        files,
        count: files.length,
      };
    },
    handlers,
    home,
  );

  // ---- codegraph_build_edges ----
  registerTool(
    server,
    D.codegraph_build_edges,
    async (args, ctx) => {
      const result = buildCodeGraphEdges(
        ctx.db,
        ctx.projectKey,
        Array.isArray(args.files) ? args.files : [],
        { apply: !!args.apply, kind: args.kind || 'calls' },
      );
      return {
        operation: 'codegraph_build_edges',
        kind: args.kind || 'calls',
        apply: !!args.apply,
        inserted: result.inserted,
        candidates: result.candidates,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- codegraph_query_symbol ----
  registerTool(
    server,
    D.codegraph_query_symbol,
    async (args, ctx) => {
      const lim = validateLimit(args.max_depth, 0, 20, 5);
      if (!lim.ok) throw toolError(lim.error);
      const memId = validateId(args.memory_id);
      if (!memId.ok) throw toolError(memId.error);
      const out = queryMemoryGraph(ctx.db, ctx.projectKey, memId.value, {
        kind: args.kind || null,
        max_depth: lim.value,
      });
      return {
        operation: 'codegraph_query_symbol',
        memory_id: memId.value,
        kind: args.kind || null,
        max_depth: lim.value,
        nodes: out.nodes,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- codegraph_impact_path ----
  registerTool(
    server,
    D.codegraph_impact_path,
    async (args, ctx) => {
      const fromId = validateId(args.from_id);
      if (!fromId.ok) throw toolError(fromId.error);
      const toId = validateId(args.to_id);
      if (!toId.ok) throw toolError(toId.error);
      const lim = validateLimit(args.max_hops, 1, 20, 6);
      if (!lim.ok) throw toolError(lim.error);
      const out = bfsPath(
        ctx.db,
        ctx.projectKey,
        fromId.value,
        toId.value,
        lim.value,
        args.kind || null,
      );
      return {
        operation: 'codegraph_impact_path',
        from_id: fromId.value,
        to_id: toId.value,
        path: out.path,
        hops: out.hops,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- codegraph_callers ----
  registerTool(
    server,
    D.codegraph_callers,
    async (args, ctx) => {
      const memId = validateId(args.memory_id);
      if (!memId.ok) throw toolError(memId.error);
      const out = queryMemoryGraph(ctx.db, ctx.projectKey, memId.value, {
        kind: args.kind || null,
        max_depth: Math.max(1, Math.min(20, args.depth || 1)),
      });
      return {
        operation: 'codegraph_callers',
        memory_id: memId.value,
        nodes: out.nodes,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- codegraph_callees ----
  registerTool(
    server,
    D.codegraph_callees,
    async (args, ctx) => {
      const memId = validateId(args.memory_id);
      if (!memId.ok) throw toolError(memId.error);
      const out = queryMemoryGraph(ctx.db, ctx.projectKey, memId.value, {
        kind: args.kind || null,
        max_depth: Math.max(1, Math.min(20, args.depth || 1)),
      });
      return {
        operation: 'codegraph_callees',
        memory_id: memId.value,
        nodes: out.nodes,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );
}

// Local BFS helper for codegraph_impact_path. Kept module-scoped so
// it can be shared by callers + callees without re-defining. The
// bound check at `length > maxHops + 1` prevents a run from
// returning `hops: maxHops + 1`; without it, the boundary extension
// could grow past the cap (audit finding H1/B1-2 follow-up).
function bfsPath(db, projectKey, fromId, toId, maxHops, kind) {
  if (fromId === toId) return { path: [fromId], hops: 0 };
  const kindList = kind ? [kind] : ['imports', 'calls', 'defines'];
  const placeholders = kindList.map(() => '?').join(',');
  const queue = [[fromId]];
  const visited = new Set([fromId]);
  while (queue.length > 0) {
    const path = queue.shift();
    if (path.length > maxHops + 1) continue;
    const head = path[path.length - 1];
    const edges = db
      .prepare(
        `SELECT from_id, to_id FROM memory_edges
         WHERE project_key = ? AND (from_id = ? OR to_id = ?)
           AND kind IN (${placeholders})`,
      )
      .all(projectKey, head, head, ...kindList);
    for (const e of edges) {
      const next = e.from_id === head ? e.to_id : e.from_id;
      if (visited.has(next)) continue;
      const newPath = [...path, next];
      if (next === toId) return { path: newPath, hops: newPath.length - 1 };
      if (newPath.length > maxHops + 1) continue;
      visited.add(next);
      queue.push(newPath);
    }
  }
  return { path: [], hops: -1 };
}
