// MCP server implementation. The transport is stdio. The server is
// pinned to run from the plugin root (the manifest's "cwd": "./"). All
// tools take a `cwd` so the agent always identifies the project it is
// working on — the server never infers it.
//
// Three-layer storage model:
//   - per-project durable + working memory + conversations live under
//     <kimiHome>/kimi-memory/<projectKey>/memory.sqlite
//   - global/user durable memory lives under
//     <kimiHome>/kimi-memory/_global/memory.sqlite
//   - shared hook diagnostics live under
//     <kimiHome>/kimi-memory/_diagnostics/hooks.log
//
// Scope semantics on durable-memory tools:
//   - memory_save / memory_update / memory_delete:
//       scope ∈ { project | global }, default = project
//   - memory_recall / memory_list / memory_get:
//       scope ∈ { project | global | all }, default = all
//   - working_memory_* and conversation_* tools are explicitly project-
//     scoped; no scope argument is accepted.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { kimiHome, nowIso, asString } from './util.js';
import {
  canonicalizeRoot,
  deriveProjectKey,
  projectDbPath,
  globalDbPath,
  ensureProjectDir,
  GLOBAL_PROJECT_KEY,
} from './project-key.js';
import {
  openDb,
  closeDb,
  saveMemory,
  saveMemoryBulk,
  getMemory,
  listMemories,
  deleteMemory,
  searchMemories,
  similarMemories,
  reinforceMemory,
  decayMemories,
  listConclusionsFor,
  getParents,
  setWorkingMemory,
  getWorkingMemory,
  clearWorkingMemory,
  listConversations,
  getConversation,
  getConversationEvents,
  recordConversationEvent,
  updateConversationProgress,
  searchConversationEvents,
  upsertConversation,
  memoryCounts,
  loadIngestState,
  saveIngestState,
  mergeMemory,
  linkMemory,
  unlinkMemory,
  listEdges,
  recordProjectPath,
  listProjectPaths,
} from './persist.js';
import { locateSessionArchive, walkWire, readSessionIndex } from './wire.js';
import {
  resolveProjectRoot,
  validateType,
  validateStatus,
  validateSlot,
  validateRole,
  validateConfidence,
  validateLimit,
  validateOffset,
  validateTags,
  validateMetadata,
  validateProvenance,
  validateExpiresAt,
  validateId,
  validatePriority,
  validateScope,
  validateEdgeKind,
  validateEdgeDirection,
  validateWeight,
  toError,
} from './validation.js';
import { getRecentLogs, getErrorSummary } from './diagnostics.js';

const TOOL_DEFS = [
  {
    name: 'memory_save',
    desc: 'Persist a memory entry. type \u2208 working|episodic|semantic|procedural|conclusion.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global'])
        .optional()
        .describe(
          'project: per-project durable memory (default). global: cross-project user memory under $KIMI_CODE_HOME/kimi-memory/_global/.',
        ),
      type: z
        .enum(['working', 'episodic', 'semantic', 'procedural', 'conclusion'])
        .describe(
          'Memory type. conclusion is the higher-order type that synthesizes N underlying memories via the synthesizes[] input.',
        ),
      title: z.string().max(500).optional(),
      content: z.string().min(1).max(200000).describe('Memory body.'),
      tags: z.array(z.string().min(1).max(64)).max(32).optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      provenance: z.record(z.string(), z.any()).optional(),
      confidence: z.number().min(0).max(1).optional(),
      priority: z.number().int().optional(),
      expires_at: z.string().optional(),
      supersede: z.boolean().optional(),
      synthesizes: z
        .array(z.string().min(4).max(64))
        .max(500)
        .optional()
        .describe(
          'For type=conclusion: ids of underlying memories this conclusion synthesizes. Recorded in memory_synthesizes for bidirectional lookup.',
        ),
    },
  },
  {
    name: 'memory_recall',
    desc: 'Keyword search across the active scope\u2019s durable memories using FTS5. Supports hybrid ranking with title boosting and optional temporal ordering.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global', 'all'])
        .optional()
        .describe(
          'project: this project only. global: _global DB only. all: project + global, project hits first (default all).',
        ),
      query: z.string().min(1).max(500).describe('Search query. Supports basic FTS5 operators: "exact phrase" or -exclude.'),
      type: z.enum(['working', 'episodic', 'semantic', 'procedural']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      recent_first: z.boolean().optional().describe('When true, sort by updated_at DESC (most recent first) instead of FTS5 relevance.'),
      sort_by: z.enum(['relevance', 'recent', 'confidence', 'priority']).optional().describe('Sort order. Default: relevance.'),
    },
  },
  {
    name: 'memory_list',
    desc: 'List durable memories in the active scope.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global', 'all'])
        .optional()
        .describe(
          'project: this project only. global: _global DB only. all: project + global, project first (default all).',
        ),
      type: z.enum(['working', 'episodic', 'semantic', 'procedural', 'conclusion']).optional(),
      status: z.enum(['active', 'superseded', 'deleted']).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
      includeExpired: z.boolean().optional(),
    },
  },
  {
    name: 'memory_get',
    desc: 'Fetch a single memory by id from the active scope.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global', 'all'])
        .optional()
        .describe(
          'project: this project only. global: _global DB only. all: project first, then global (default all).',
        ),
      id: z.string().min(4).max(64).describe('Memory id.'),
    },
  },
  {
    name: 'memory_update',
    desc: 'Patch a memory\u2019s fields. Provide only fields to change.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global'])
        .optional()
        .describe('project: this project only (default). global: _global DB only.'),
      id: z.string().min(4).max(64).describe('Memory id.'),
      title: z.string().max(500).optional(),
      content: z.string().min(1).max(200000).optional(),
      tags: z.array(z.string()).optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      provenance: z.record(z.string(), z.any()).optional(),
      confidence: z.number().min(0).max(1).optional(),
      status: z.enum(['active', 'superseded', 'deleted']).optional(),
      priority: z.number().int().optional(),
      expires_at: z.string().optional(),
    },
  },
  {
    name: 'memory_delete',
    desc: 'Soft-delete a memory by id. Pass hard=true for permanent removal.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global'])
        .optional()
        .describe('project: this project only (default). global: _global DB only.'),
      id: z.string().min(4).max(64).describe('Memory id.'),
      hard: z.boolean().optional(),
    },
  },
  {
    name: 'working_memory_set',
    desc: 'Set a named working-memory slot for the current focus. Project-scoped only.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      slot: z
        .string()
        .min(1)
        .max(64)
        .describe('Slot name, e.g. current_focus, active_task, recent_decision.'),
      value: z.string().min(1).max(20000).describe('Slot value.'),
    },
  },
  {
    name: 'working_memory_get',
    desc: 'Read a working-memory slot. Project-scoped only.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      slot: z.string().describe('Slot name.'),
    },
  },
  {
    name: 'working_memory_clear',
    desc: 'Clear a working-memory slot. Project-scoped only.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      slot: z.string().describe('Slot name.'),
    },
  },
  {
    name: 'conversation_list',
    desc: 'List conversations (sessions) whose archive has been ingested for this project. Project-scoped only.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  {
    name: 'conversation_get',
    desc: 'Fetch events for one session starting at an optional line cursor. Project-scoped only.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      session_id: z.string().min(1).max(128).describe('Session id.'),
      since: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
  },
  {
    name: 'conversation_search',
    desc: 'Search ingested conversation events for a substring / token. Project-scoped only.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      query: z.string().min(1).max(500).describe('Search query.'),
      session_id: z.string().optional(),
      role: z.enum(['user', 'assistant', 'tool', 'system']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  {
    name: 'conversation_ingest',
    desc: 'Incrementally ingest a Kimi session wire.jsonl into the project. Idempotent: safe to re-run; only new bytes are read. Project-scoped only.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      session_id: z
        .string()
        .min(1)
        .max(128)
        .describe('Session id (the directory name under sessions/).'),
      work_dir_key: z
        .string()
        .optional()
        .describe('Optional pre-hashed work-dir key; if absent we derive it from cwd.'),
      force: z.boolean().optional().describe('Re-ingest from byte 0 even when the cursor matches.'),
    },
  },
  {
    name: 'memory_status',
    desc: 'Return aggregate counts for the project memory store plus a parallel summary for the global store.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
    },
  },
  {
    name: 'memory_save_bulk',
    desc: 'Save multiple memories atomically in a single transaction. All-or-nothing; rolls back on any error. Within a batch, later items can supersede earlier ones that share the same (type, title).',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global'])
        .optional()
        .describe(
          'project: per-project durable memory (default). global: cross-project user memory under $KIMI_CODE_HOME/kimi-memory/_global/.',
        ),
      items: z
        .array(
          z.object({
            type: z
              .enum(['working', 'episodic', 'semantic', 'procedural', 'conclusion'])
              .describe('Memory type.'),
            title: z.string().max(500).optional(),
            content: z.string().min(1).max(200000).describe('Memory body.'),
            tags: z.array(z.string().min(1).max(64)).max(32).optional(),
            metadata: z.record(z.string(), z.any()).optional(),
            provenance: z.record(z.string(), z.any()).optional(),
            confidence: z.number().min(0).max(1).optional(),
            priority: z.number().int().optional(),
            expires_at: z.string().optional(),
            supersede: z.boolean().optional(),
            synthesizes: z
              .array(z.string().min(4).max(64))
              .max(500)
              .optional()
              .describe(
                'For type=conclusion: ids of underlying memories this conclusion synthesizes.',
              ),
          }),
        )
        .min(1)
        .max(500)
        .describe('Memories to save in one transaction.'),
    },
  },
  {
    name: 'memory_similar',
    desc: 'Find memories semantically similar to a given memory id using cosine similarity over stored embeddings. Returns [] if the target has no embedding yet.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global', 'all'])
        .optional()
        .describe(
          'project: this project only. global: _global DB only. all: project + global (default all).',
        ),
      id: z.string().min(4).max(64).describe('Seed memory id.'),
      limit: z.number().int().min(1).max(50).optional(),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Minimum cosine similarity, default 0.6.'),
    },
  },
  {
    name: 'memory_link',
    desc: 'Create a typed edge between two memories: kind ∈ {related, supports, contradicts, supersedes, synthesizes}. Idempotent: re-linking the same (from, to, kind) returns the existing edge instead of erroring.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global'])
        .optional()
        .describe('project: per-project durable memory (default). global: _global DB only.'),
      from_id: z.string().min(4).max(64).describe('Source memory id.'),
      to_id: z.string().min(4).max(64).describe('Target memory id.'),
      kind: z
        .enum(['related', 'supports', 'contradicts', 'supersedes', 'synthesizes'])
        .describe('Edge kind.'),
      weight: z
        .number()
        .min(0)
        .max(10)
        .optional()
        .describe('Optional edge weight in [0, 10]. Default 1.0.'),
    },
  },
  {
    name: 'memory_unlink',
    desc: 'Remove an edge by its id (the value returned by memory_link or memory_edges).',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global'])
        .optional()
        .describe('project: per-project durable memory (default). global: _global DB only.'),
      edge_id: z.string().min(4).max(64).describe('Edge id to remove.'),
    },
  },
  {
    name: 'memory_edges',
    desc: 'List every typed edge touching a memory in the active scope. direction ∈ {out, in, both}; kind is an optional filter.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global', 'all'])
        .optional()
        .describe(
          'project: this project only. global: _global DB only. all: project + global (default all).',
        ),
      id: z.string().min(4).max(64).describe('Memory id whose edges should be listed.'),
      direction: z
        .enum(['out', 'in', 'both'])
        .optional()
        .describe('Edge direction filter. Default both.'),
      kind: z
        .enum(['related', 'supports', 'contradicts', 'supersedes', 'synthesizes'])
        .optional()
        .describe('Edge kind filter.'),
    },
  },
  {
    name: 'memory_merge',
    desc: "Merge one memory into another: fromId becomes soft-superseded with a supersedes edge to intoId, intoId gains the union of tags + a provenance.merge_from entry. Use merged_content to replace intoId's content; otherwise intoId keeps its existing body.",
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global'])
        .optional()
        .describe('project: per-project durable memory (default). global: _global DB only.'),
      into_id: z
        .string()
        .min(4)
        .max(64)
        .describe('Destination memory id (kept active, gains tags).'),
      from_id: z
        .string()
        .min(4)
        .max(64)
        .describe('Source memory id (soft-superseded after merge).'),
      merged_content: z
        .string()
        .min(1)
        .max(200000)
        .optional()
        .describe('Optional replacement content for into_id; omit to keep existing.'),
      weight: z
        .number()
        .min(0)
        .max(10)
        .optional()
        .describe('Optional weight on the new supersedes edge. Default 1.0.'),
    },
  },
  {
    name: 'memory_reinforce',
    desc: "Bump a memory's access count + last_accessed_at and nudge confidence upward by ~0.05. Idempotent — call repeatedly when a memory proves useful.",
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global'])
        .optional()
        .describe('project: per-project durable memory (default). global: _global DB only.'),
      id: z.string().min(4).max(64).describe('Memory id to reinforce.'),
    },
  },
  {
    name: 'memory_conclusions_for',
    desc: 'Given a memory id, return every active conclusion (type=conclusion) that synthesizes it via memory_synthesizes. Honors project|global|all scope.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global', 'all'])
        .optional()
        .describe(
          'project: this project only. global: _global DB only. all: project + global (default all).',
        ),
      id: z.string().min(4).max(64).describe('Underlying memory id to look up conclusions for.'),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  {
    name: 'memory_parents',
    desc: 'Inverse of memory_conclusions_for: given a conclusion id, return every underlying memory it synthesizes.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global'])
        .optional()
        .describe('project: per-project durable memory (default). global: _global DB only.'),
      id: z.string().min(4).max(64).describe('Conclusion memory id.'),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  {
    name: 'memory_prune',
    desc: 'Find (and optionally delete) project databases whose canonical project root no longer exists on disk. Use this to clean up after a project is deleted. scope="project" only inspects the active project; scope="all-projects" inspects every other project DB. apply=false (default) is a dry run; apply=true deletes the orphan DB files. The global DB and the active project DB are never removed.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'all-projects'])
        .optional()
        .describe(
          '"project" (default): only the active project. "all-projects": every project DB in the data root except the active one.',
        ),
      apply: z
        .boolean()
        .optional()
        .describe('When true, delete orphan DBs. Default false (dry run).'),
    },
  },
  {
    name: 'memory_diagnostics',
    desc: 'Retrieve recent error logs and diagnostic information for hook failures, auto-extract issues, embedding errors, and other system events. Useful for troubleshooting and observability.',
    input: {
      hours_back: z
        .number()
        .int()
        .min(1)
        .max(720)
        .optional()
        .describe('How many hours back to summarize errors. Default 24.'),
      type_filter: z
        .enum([
          'hook_error',
          'auto_extract_error',
          'embedding_error',
          'persist_error',
          'conversation_ingest_error',
          'config_validation_error',
        ])
        .optional()
        .describe('Filter diagnostics to a specific error type.'),
      limit: z.number().int().min(1).max(500).optional().describe('Max records to return. Default 100.'),
    },
  },
];

// Best-effort, bounded merge. Sorts each scope independently by the
// caller-supplied timestamp (most-recent-first), then concatenates
// project rows first followed by global rows. This keeps the
// "project hits first" promise in the docs while still surfacing
// the freshest hits within each scope. The combined result is
// truncated to `limit` rows.
function mergeWithScope(projectRows, globalRows, { limit, deriveTimestamp }) {
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

export function makeServer({ kimiHomeDir, pluginRootDir, logger } = {}) {
  const home = kimiHomeDir || kimiHome();
  const root = pluginRootDir || process.cwd();
  const log =
    logger ||
    ((...a) => {
      try {
        process.stderr.write('[kimi-memory] ' + a.join(' ') + '\n');
      } catch {
        /* ignore */
      }
    });

  const server = new McpServer({ name: 'kimi-memory', version: '0.4.0' });

  // Resolve the database handle and key for a given scope. `cwd` is
  // required for `project` and `all`; for `global` it is audit context
  // (caller must still pass it for provenance purposes) but does not
  // choose the database.
  //
  // `record` controls whether the canonical project root is stamped
  // into `project_paths` for this open. Write tools pass `true`; read
  // tools pass `false` (or omit it) so a recall on a slow network
  // share does not pay a write per call. The first write into a
  // previously-unseen project is what creates the project_paths row,
  // which is all `memory_prune` needs to detect orphans.
  function openScopeDb({ cwd, scope, record = false }) {
    if (scope === 'global') {
      const dbPath = globalDbPath(home);
      mkdirSync(path.dirname(dbPath), { recursive: true });
      return { db: openDb(dbPath), projectKey: GLOBAL_PROJECT_KEY, cwd: cwd || null };
    }
    if (!cwd) throw new Error('project cwd is required');
    const c = canonicalizeRoot(cwd);
    if (!c) throw new Error('invalid project cwd');
    const key = deriveProjectKey(c);
    mkdirSync(path.dirname(projectDbPath(home, key)), { recursive: true });
    const db = openDb(projectDbPath(home, key));
    if (record) recordProjectPath(db, key, c);
    return { db, projectKey: key, cwd: c };
  }

  // Convenience: open a scope and stamp the project path. Use this
  // from every tool that mutates the DB so memory_prune can later
  // detect orphans. Read tools continue to use `openScopeDb` directly.
  function openScopeDbForWrite(args) {
    return openScopeDb({ ...args, record: true });
  }

  // ---- memory_save ----
  server.tool(TOOL_DEFS[0].name, TOOL_DEFS[0].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const sc = validateScope(args.scope, { read: false });
      if (!sc.ok) return textError(sc.error);
      const t = validateType(args.type);
      if (!t.ok) return textError(t.error);
      const tags = validateTags(args.tags);
      if (!tags.ok) return textError(tags.error);
      const md = validateMetadata(args.metadata);
      if (!md.ok) return textError(md.error);
      const pv = validateProvenance(args.provenance);
      if (!pv.ok) return textError(pv.error);
      const conf = validateConfidence(args.confidence);
      if (!conf.ok) return textError(conf.error);
      const exp = validateExpiresAt(args.expires_at);
      if (!exp.ok) return textError(exp.error);
      const prio = validatePriority(args.priority);
      if (!prio.ok) return textError(prio.error);
      const content = args.content;
      if (!content) return textError('content is required');
      const target = openScopeDbForWrite({ cwd: pr.value, scope: sc.value });
      const provenance = {
        ...(pv.value || {}),
        source: (pv.value && pv.value.source) || 'memory_save',
        cwd: pr.value,
        scope: sc.value,
        recorded_at: nowIso(),
      };
      const mem = saveMemory(target.db, target.projectKey, {
        type: t.value,
        title: args.title || '',
        content,
        tags: tags.value,
        metadata: md.value,
        provenance,
        confidence: conf.value,
        status: 'active',
        priority: prio.value,
        expires_at: exp.value,
        supersede: !!args.supersede,
        synthesizes: Array.isArray(args.synthesizes) ? args.synthesizes : undefined,
      });
      return ok({
        operation: 'saved',
        scope: sc.value,
        memory: mem,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_recall ----
  server.tool(TOOL_DEFS[1].name, TOOL_DEFS[1].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      if (!args.query) return textError('query is required');
      const lim = validateLimit(args.limit, 1, 200, 20);
      if (!lim.ok) return textError(lim.error);
      const sc = validateScope(args.scope, { read: true });
      if (!sc.ok) return textError(sc.error);
      const t = args.type ? validateType(args.type) : { ok: true, value: null };
      if (!t.ok) return textError(t.error);
      const scope = sc.value;
      const projectHandle =
        scope === 'project' || scope === 'all'
          ? openScopeDb({ cwd: pr.value, scope: 'project' })
          : null;
      const globalHandle =
        scope === 'global' || scope === 'all'
          ? openScopeDb({ cwd: pr.value, scope: 'global' })
          : null;
      const opts = { type: t.value, limit: lim.value };
      const projectItems = projectHandle
        ? await searchMemories(projectHandle.db, projectHandle.projectKey, args.query, opts)
        : [];
      const globalItems = globalHandle
        ? await searchMemories(globalHandle.db, GLOBAL_PROJECT_KEY, args.query, opts)
        : [];
      if (scope === 'project') {
        return ok({
          operation: 'recalled',
          scope,
          items: projectItems,
          count: projectItems.length,
          project_key: projectHandle.projectKey,
        });
      }
      if (scope === 'global') {
        return ok({
          operation: 'recalled',
          scope,
          items: globalItems.map((m) => ({ ...m, scope: 'global' })),
          count: globalItems.length,
          project_key: GLOBAL_PROJECT_KEY,
        });
      }
      // scope === 'all'
      const merged = mergeWithScope(projectItems, globalItems, {
        limit: lim.value,
        deriveTimestamp: (r) => r.updated_at,
      });
      return ok({
        operation: 'recalled',
        scope,
        items: merged.items,
        count: merged.items.length,
        project_count: merged.project_count,
        global_count: merged.global_count,
        project_key: projectHandle.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_list ----
  server.tool(TOOL_DEFS[2].name, TOOL_DEFS[2].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const lim = validateLimit(args.limit, 1, 500, 50);
      if (!lim.ok) return textError(lim.error);
      const off = validateOffset(args.offset);
      if (!off.ok) return textError(off.error);
      const st = validateStatus(args.status);
      if (!st.ok) return textError(st.error);
      const t = args.type ? validateType(args.type) : { ok: true, value: null };
      if (!t.ok) return textError(t.error);
      const sc = validateScope(args.scope, { read: true });
      if (!sc.ok) return textError(sc.error);
      const scope = sc.value;
      const projectHandle =
        scope === 'project' || scope === 'all'
          ? openScopeDb({ cwd: pr.value, scope: 'project' })
          : null;
      const globalHandle =
        scope === 'global' || scope === 'all'
          ? openScopeDb({ cwd: pr.value, scope: 'global' })
          : null;
      const opts = {
        type: t.value,
        status: st.value,
        limit: lim.value,
        offset: off.value,
        includeExpired: !!args.includeExpired,
      };
      const projectItems = projectHandle
        ? listMemories(projectHandle.db, projectHandle.projectKey, opts)
        : [];
      const globalItems = globalHandle
        ? listMemories(globalHandle.db, GLOBAL_PROJECT_KEY, opts)
        : [];
      if (scope === 'project') {
        return ok({
          operation: 'listed',
          scope,
          items: projectItems,
          count: projectItems.length,
          project_key: projectHandle.projectKey,
        });
      }
      if (scope === 'global') {
        return ok({
          operation: 'listed',
          scope,
          items: globalItems.map((m) => ({ ...m, scope: 'global' })),
          count: globalItems.length,
          project_key: GLOBAL_PROJECT_KEY,
        });
      }
      // scope === 'all'
      const merged = mergeWithScope(projectItems, globalItems, {
        limit: lim.value,
        deriveTimestamp: (r) => r.updated_at,
      });
      return ok({
        operation: 'listed',
        scope,
        items: merged.items,
        count: merged.items.length,
        project_count: merged.project_count,
        global_count: merged.global_count,
        project_key: projectHandle.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_get ----
  server.tool(TOOL_DEFS[3].name, TOOL_DEFS[3].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const id = validateId(args.id);
      if (!id.ok) return textError(id.error);
      const sc = validateScope(args.scope, { read: true });
      if (!sc.ok) return textError(sc.error);
      const scope = sc.value;
      if (scope === 'project' || scope === 'all') {
        const target = openScopeDb({ cwd: pr.value, scope: 'project' });
        const mem = getMemory(target.db, target.projectKey, id.value);
        if (mem) {
          const tagged = scope === 'all' ? { ...mem, scope: 'project' } : mem;
          return ok({ operation: 'got', scope, memory: tagged, project_key: target.projectKey });
        }
        if (scope === 'project') return textError(`memory not found: ${id.value}`);
      }
      if (scope === 'global' || scope === 'all') {
        const target = openScopeDb({ cwd: pr.value, scope: 'global' });
        const mem = getMemory(target.db, GLOBAL_PROJECT_KEY, id.value);
        if (mem)
          return ok({
            operation: 'got',
            scope,
            memory: { ...mem, scope: 'global' },
            project_key: GLOBAL_PROJECT_KEY,
          });
      }
      return textError(`memory not found: ${id.value}`);
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_update ----
  server.tool(TOOL_DEFS[4].name, TOOL_DEFS[4].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const id = validateId(args.id);
      if (!id.ok) return textError(id.error);
      const sc = validateScope(args.scope, { read: false });
      if (!sc.ok) return textError(sc.error);
      const target = openScopeDbForWrite({ cwd: pr.value, scope: sc.value });
      const existing = getMemory(target.db, target.projectKey, id.value, {
        includeSuperseded: true,
      });
      if (!existing) return textError(`memory not found in ${sc.value} scope: ${id.value}`);
      const merged = { ...existing };
      if (args.title !== undefined) merged.title = asString(args.title);
      if (args.content !== undefined) merged.content = args.content;
      if (args.tags !== undefined) {
        const t = validateTags(args.tags);
        if (!t.ok) return textError(t.error);
        merged.tags = t.value;
      }
      if (args.metadata !== undefined) {
        const m = validateMetadata(args.metadata);
        if (!m.ok) return textError(m.error);
        merged.metadata = m.value;
      }
      if (args.provenance !== undefined) {
        const p = validateProvenance(args.provenance);
        if (!p.ok) return textError(p.error);
        merged.provenance = p.value;
      }
      if (args.confidence !== undefined) {
        const c = validateConfidence(args.confidence);
        if (!c.ok) return textError(c.error);
        merged.confidence = c.value;
      }
      if (args.status !== undefined) {
        const s = validateStatus(args.status);
        if (!s.ok) return textError(s.error);
        merged.status = s.value;
      }
      if (args.priority !== undefined) {
        const p = validatePriority(args.priority);
        if (!p.ok) return textError(p.error);
        merged.priority = p.value;
      }
      if (args.expires_at !== undefined) {
        const e2 = validateExpiresAt(args.expires_at);
        if (!e2.ok) return textError(e2.error);
        merged.expires_at = e2.value;
      }
      const mem = saveMemory(target.db, target.projectKey, merged);
      return ok({
        operation: 'updated',
        scope: sc.value,
        memory: mem,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_delete ----
  server.tool(TOOL_DEFS[5].name, TOOL_DEFS[5].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const id = validateId(args.id);
      if (!id.ok) return textError(id.error);
      const sc = validateScope(args.scope, { read: false });
      if (!sc.ok) return textError(sc.error);
      const target = openScopeDbForWrite({ cwd: pr.value, scope: sc.value });
      const okDel = deleteMemory(target.db, target.projectKey, id.value, { hard: !!args.hard });
      return ok({
        operation: 'deleted',
        scope: sc.value,
        deleted: okDel,
        id: id.value,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- working_memory_set/get/clear (project-scoped only) ----
  server.tool(TOOL_DEFS[6].name, TOOL_DEFS[6].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const slot = validateSlot(args.slot);
      if (!slot.ok) return textError(slot.error);
      if (!args.value) return textError('value is required');
      const { db, projectKey } = openScopeDbForWrite({ cwd: pr.value, scope: 'project' });
      const r = setWorkingMemory(db, projectKey, slot.value, args.value);
      return ok({
        operation: 'wm_set',
        slot: r.slot,
        value: r.value,
        updated_at: r.updated_at,
        project_key: projectKey,
        warning: slot.warning || null,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  server.tool(TOOL_DEFS[7].name, TOOL_DEFS[7].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const slot = validateSlot(args.slot);
      if (!slot.ok) return textError(slot.error);
      const { db, projectKey } = openScopeDb({ cwd: pr.value, scope: 'project' });
      const r = getWorkingMemory(db, projectKey, slot.value);
      return ok({
        operation: 'wm_get',
        slot: slot.value,
        value: r ? r.value : null,
        updated_at: r ? r.updated_at : null,
        project_key: projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  server.tool(TOOL_DEFS[8].name, TOOL_DEFS[8].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const slot = validateSlot(args.slot);
      if (!slot.ok) return textError(slot.error);
      const { db, projectKey } = openScopeDbForWrite({ cwd: pr.value, scope: 'project' });
      const cleared = clearWorkingMemory(db, projectKey, slot.value);
      return ok({ operation: 'wm_clear', slot: slot.value, cleared, project_key: projectKey });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- conversation_list / get / search / ingest (project-scoped only) ----
  server.tool(TOOL_DEFS[9].name, TOOL_DEFS[9].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const lim = validateLimit(args.limit, 1, 500, 50);
      if (!lim.ok) return textError(lim.error);
      const { db, projectKey } = openScopeDb({ cwd: pr.value, scope: 'project' });
      const items = listConversations(db, projectKey, { limit: lim.value });
      return ok({ operation: 'conv_list', items, count: items.length, project_key: projectKey });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- conversation_list / get / search / ingest (project-scoped only) ----
  server.tool(TOOL_DEFS[10].name, TOOL_DEFS[10].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      if (!args.session_id) return textError('session_id is required');
      const lim = validateLimit(args.limit, 1, 1000, 200);
      if (!lim.ok) return textError(lim.error);
      const off = validateOffset(args.since);
      if (!off.ok) return textError(off.error);
      const { db, projectKey } = openScopeDb({ cwd: pr.value, scope: 'project' });
      const meta = getConversation(db, projectKey, args.session_id);
      const events = getConversationEvents(db, projectKey, args.session_id, {
        limit: lim.value,
        since: off.value,
      });
      return ok({
        operation: 'conv_get',
        conversation: meta,
        events,
        count: events.length,
        project_key: projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  server.tool(TOOL_DEFS[11].name, TOOL_DEFS[11].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      if (!args.query) return textError('query is required');
      const lim = validateLimit(args.limit, 1, 200, 20);
      if (!lim.ok) return textError(lim.error);
      const role = args.role ? validateRole(args.role) : { ok: true, value: null };
      if (!role.ok) return textError(role.error);
      const { db, projectKey } = openScopeDb({ cwd: pr.value, scope: 'project' });
      const items = searchConversationEvents(db, projectKey, args.query, {
        sessionId: args.session_id,
        role: role.value,
        limit: lim.value,
      });
      return ok({ operation: 'conv_search', items, count: items.length, project_key: projectKey });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  server.tool(TOOL_DEFS[12].name, TOOL_DEFS[12].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const { db, projectKey, cwd } = openScopeDbForWrite({ cwd: pr.value, scope: 'project' });
      const r = await ingestOne({
        home,
        db,
        projectKey,
        cwd,
        sessionId: args.session_id,
        workDirKey: args.work_dir_key,
        force: !!args.force,
      });
      return ok({ operation: 'conv_ingest', ...r });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_status (project + global, both DBs in one call) ----
  server.tool(TOOL_DEFS[13].name, TOOL_DEFS[13].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const project = openScopeDb({ cwd: pr.value, scope: 'project' });
      const global = openScopeDb({ cwd: pr.value, scope: 'global' });
      const projectMem = memoryCounts(project.db, project.projectKey);
      const globalMem = memoryCounts(global.db, GLOBAL_PROJECT_KEY);
      const wm = project.db
        .prepare('SELECT COUNT(*) AS n FROM working_memory WHERE project_key=?')
        .get(project.projectKey).n;
      const conv = project.db
        .prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_key=?')
        .get(project.projectKey).n;
      const events = project.db
        .prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?')
        .get(project.projectKey).n;
      return ok({
        project_key: project.projectKey,
        cwd: pr.value,
        // Backward-compat top-level fields describe the project's own
        // durable + working + conversation layer.
        memories: projectMem,
        working_memory_slots: wm,
        conversations: conv,
        conversation_events: events,
        // New: separate global summary so callers can observe the
        // cross-project memory layer without opening another DB.
        global: {
          memories: globalMem,
        },
        scopes: { project: project.projectKey, global: GLOBAL_PROJECT_KEY },
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_save_bulk (transactional batch save) ----
  server.tool(TOOL_DEFS[14].name, TOOL_DEFS[14].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const sc = validateScope(args.scope, { read: false });
      if (!sc.ok) return textError(sc.error);
      if (!Array.isArray(args.items) || args.items.length === 0)
        return textError('items must be a non-empty array');
      if (args.items.length > 500) return textError('items must contain at most 500 entries');
      // Per-item validation. Every item is checked and every error
      // collected before bailing — callers see the full list of bad
      // items in a single response instead of fixing them one round
      // trip at a time. The cleaned list is only built from items
      // that pass; the rest are reported.
      const errors = [];
      const cleaned = [];
      for (let i = 0; i < args.items.length; i++) {
        const item = args.items[i];
        const ctx = `items[${i}]`;
        if (!item || typeof item !== 'object') {
          errors.push(`${ctx}: must be an object`);
          continue;
        }
        const t = validateType(item.type);
        if (!t.ok) {
          errors.push(`${ctx}: ${t.error}`);
          continue;
        }
        const content =
          typeof item.content === 'string' && item.content.length > 0 ? item.content : null;
        if (!content) {
          errors.push(`${ctx}: content is required`);
          continue;
        }
        const tags = validateTags(item.tags);
        if (!tags.ok) {
          errors.push(`${ctx}: ${tags.error}`);
          continue;
        }
        const md = validateMetadata(item.metadata);
        if (!md.ok) {
          errors.push(`${ctx}: ${md.error}`);
          continue;
        }
        const pv = validateProvenance(item.provenance);
        if (!pv.ok) {
          errors.push(`${ctx}: ${pv.error}`);
          continue;
        }
        const conf = validateConfidence(item.confidence);
        if (!conf.ok) {
          errors.push(`${ctx}: ${conf.error}`);
          continue;
        }
        const exp = validateExpiresAt(item.expires_at);
        if (!exp.ok) {
          errors.push(`${ctx}: ${exp.error}`);
          continue;
        }
        const prio = validatePriority(item.priority);
        if (!prio.ok) {
          errors.push(`${ctx}: ${prio.error}`);
          continue;
        }
        cleaned.push({
          type: t.value,
          title: typeof item.title === 'string' ? item.title : '',
          content,
          tags: tags.value,
          metadata: md.value,
          provenance: pv.value,
          confidence: conf.value,
          priority: prio.value,
          expires_at: exp.value,
          supersede: !!item.supersede,
          synthesizes: Array.isArray(item.synthesizes) ? item.synthesizes : undefined,
        });
      }
      if (errors.length > 0) {
        return textError(
          `validation failed for ${errors.length} of ${args.items.length} item(s): ${errors.join('; ')}`,
        );
      }
      const target = openScopeDbForWrite({ cwd: pr.value, scope: sc.value });
      // Stamp provenance so every saved row carries the caller's context.
      const baseProvenance = {
        source: 'memory_save_bulk',
        cwd: pr.value,
        scope: sc.value,
        recorded_at: nowIso(),
      };
      const stamped = cleaned.map((item) => ({
        ...item,
        provenance: { ...(item.provenance || {}), ...baseProvenance },
      }));
      const mems = saveMemoryBulk(target.db, target.projectKey, stamped);
      return ok({
        operation: 'saved_bulk',
        scope: sc.value,
        memories: mems,
        count: mems.length,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_similar (vector-only similarity search) ----
  server.tool(TOOL_DEFS[15].name, TOOL_DEFS[15].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const id = validateId(args.id);
      if (!id.ok) return textError(id.error);
      const lim = validateLimit(args.limit, 1, 50, 10);
      if (!lim.ok) return textError(lim.error);
      const sc = validateScope(args.scope, { read: true });
      if (!sc.ok) return textError(sc.error);
      const threshold =
        typeof args.threshold === 'number' ? Math.max(0, Math.min(1, args.threshold)) : 0.6;
      const scope = sc.value;
      const merged = [];
      if (scope === 'project' || scope === 'all') {
        const target = openScopeDb({ cwd: pr.value, scope: 'project' });
        const items = await similarMemories(target.db, target.projectKey, id.value, {
          limit: lim.value,
          threshold,
        });
        merged.push(...items.map((m) => ({ ...m, scope: 'project' })));
      }
      if (scope === 'global' || scope === 'all') {
        const target = openScopeDb({ cwd: pr.value, scope: 'global' });
        const items = await similarMemories(target.db, GLOBAL_PROJECT_KEY, id.value, {
          limit: lim.value,
          threshold,
        });
        merged.push(...items.map((m) => ({ ...m, scope: 'global' })));
      }
      // Sort across scopes by similarity desc, then trim to limit.
      merged.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
      const items = merged.slice(0, lim.value);
      return ok({
        operation: 'similar',
        scope,
        id: id.value,
        threshold,
        items,
        count: items.length,
        project_key:
          scope === 'global'
            ? GLOBAL_PROJECT_KEY
            : deriveProjectKey(canonicalizeRoot(pr.value) || pr.value),
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_link (typed edge insert; idempotent) ----
  server.tool(TOOL_DEFS[16].name, TOOL_DEFS[16].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const sc = validateScope(args.scope, { read: false });
      if (!sc.ok) return textError(sc.error);
      const fromId = validateId(args.from_id);
      if (!fromId.ok) return textError(fromId.error);
      const toId = validateId(args.to_id);
      if (!toId.ok) return textError(toId.error);
      if (fromId.value === toId.value) return textError('from_id and to_id must differ');
      const kind = validateEdgeKind(args.kind);
      if (!kind.ok) return textError(kind.error);
      const w = validateWeight(args.weight);
      if (!w.ok) return textError(w.error);
      const target = openScopeDbForWrite({ cwd: pr.value, scope: sc.value });
      const edge = linkMemory(target.db, target.projectKey, fromId.value, toId.value, kind.value, {
        weight: w.value,
      });
      return ok({ operation: 'linked', scope: sc.value, edge, project_key: target.projectKey });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_unlink (edge delete by id) ----
  server.tool(TOOL_DEFS[17].name, TOOL_DEFS[17].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const sc = validateScope(args.scope, { read: false });
      if (!sc.ok) return textError(sc.error);
      const edgeId = validateId(args.edge_id);
      if (!edgeId.ok) return textError(edgeId.error);
      const target = openScopeDbForWrite({ cwd: pr.value, scope: sc.value });
      const removed = unlinkMemory(target.db, target.projectKey, edgeId.value);
      return ok({
        operation: 'unlinked',
        scope: sc.value,
        edge_id: edgeId.value,
        removed,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_edges (list edges touching a memory; scope='all' merges) ----
  server.tool(TOOL_DEFS[18].name, TOOL_DEFS[18].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const sc = validateScope(args.scope, { read: true });
      if (!sc.ok) return textError(sc.error);
      const id = validateId(args.id);
      if (!id.ok) return textError(id.error);
      const dir = validateEdgeDirection(args.direction);
      if (!dir.ok) return textError(dir.error);
      const kind = args.kind ? validateEdgeKind(args.kind) : { ok: true, value: null };
      if (!kind.ok) return textError(kind.error);
      const scope = sc.value;
      const merged = [];
      if (scope === 'project' || scope === 'all') {
        const target = openScopeDb({ cwd: pr.value, scope: 'project' });
        const items = listEdges(target.db, target.projectKey, id.value, {
          direction: dir.value,
          kind: kind.value,
        });
        merged.push(...items.map((e) => ({ ...e, scope: 'project' })));
      }
      if (scope === 'global' || scope === 'all') {
        const target = openScopeDb({ cwd: pr.value, scope: 'global' });
        const items = listEdges(target.db, GLOBAL_PROJECT_KEY, id.value, {
          direction: dir.value,
          kind: kind.value,
        });
        merged.push(...items.map((e) => ({ ...e, scope: 'global' })));
      }
      // Sort by created_at desc; ties broken by kind alphabetical.
      merged.sort((a, b) => {
        const tc = (b.created_at || '').localeCompare(a.created_at || '');
        return tc !== 0 ? tc : (a.kind || '').localeCompare(b.kind || '');
      });
      return ok({
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
            : deriveProjectKey(canonicalizeRoot(pr.value) || pr.value),
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_merge (soft-supersede fromId into intoId; union tags; record supersedes edge) ----
  server.tool(TOOL_DEFS[19].name, TOOL_DEFS[19].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const sc = validateScope(args.scope, { read: false });
      if (!sc.ok) return textError(sc.error);
      const into = validateId(args.into_id);
      if (!into.ok) return textError(into.error);
      const from = validateId(args.from_id);
      if (!from.ok) return textError(from.error);
      if (into.value === from.value) return textError('into_id and from_id must differ');
      const w = validateWeight(args.weight);
      if (!w.ok) return textError(w.error);
      const target = openScopeDbForWrite({ cwd: pr.value, scope: sc.value });
      const r = mergeMemory(target.db, target.projectKey, into.value, from.value, {
        mergedContent: typeof args.merged_content === 'string' ? args.merged_content : null,
        weight: w.value,
      });
      return ok({
        operation: 'merged',
        scope: sc.value,
        into: r.into,
        from: r.from,
        edge: r.edge,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_reinforce (signal-driven importance bump) ----
  server.tool(TOOL_DEFS[20].name, TOOL_DEFS[20].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const sc = validateScope(args.scope, { read: false });
      if (!sc.ok) return textError(sc.error);
      const id = validateId(args.id);
      if (!id.ok) return textError(id.error);
      const target = openScopeDbForWrite({ cwd: pr.value, scope: sc.value });
      const memory = reinforceMemory(target.db, target.projectKey, id.value);
      if (!memory) return textError(`memory not found in ${sc.value} scope: ${id.value}`);
      return ok({
        operation: 'reinforced',
        scope: sc.value,
        memory,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_conclusions_for (find conclusions that synthesize a memory) ----
  server.tool(TOOL_DEFS[21].name, TOOL_DEFS[21].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const sc = validateScope(args.scope, { read: true });
      if (!sc.ok) return textError(sc.error);
      const id = validateId(args.id);
      if (!id.ok) return textError(id.error);
      const lim = validateLimit(args.limit, 1, 200, 50);
      if (!lim.ok) return textError(lim.error);
      const scope = sc.value;
      const merged = [];
      if (scope === 'project' || scope === 'all') {
        const target = openScopeDb({ cwd: pr.value, scope: 'project' });
        const items = listConclusionsFor(target.db, target.projectKey, id.value, {
          limit: lim.value,
        });
        merged.push(...items.map((m) => ({ ...m, scope: 'project' })));
      }
      if (scope === 'global' || scope === 'all') {
        const target = openScopeDb({ cwd: pr.value, scope: 'global' });
        const items = listConclusionsFor(target.db, GLOBAL_PROJECT_KEY, id.value, {
          limit: lim.value,
        });
        merged.push(...items.map((m) => ({ ...m, scope: 'global' })));
      }
      merged.sort((a, b) => {
        const tc = (b.updated_at || '').localeCompare(a.updated_at || '');
        return tc !== 0 ? tc : (b.priority || 0) - (a.priority || 0);
      });
      const items = merged.slice(0, lim.value);
      return ok({
        operation: 'conclusions_for',
        scope,
        id: id.value,
        items,
        count: items.length,
        project_key:
          scope === 'global'
            ? GLOBAL_PROJECT_KEY
            : deriveProjectKey(canonicalizeRoot(pr.value) || pr.value),
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_parents (inverse: parents of a conclusion) ----
  server.tool(TOOL_DEFS[22].name, TOOL_DEFS[22].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const sc = validateScope(args.scope, { read: false });
      if (!sc.ok) return textError(sc.error);
      const id = validateId(args.id);
      if (!id.ok) return textError(id.error);
      const lim = validateLimit(args.limit, 1, 500, 200);
      if (!lim.ok) return textError(lim.error);
      const target = openScopeDb({ cwd: pr.value, scope: sc.value });
      const items = getParents(target.db, target.projectKey, id.value, { limit: lim.value });
      return ok({
        operation: 'parents',
        scope: sc.value,
        id: id.value,
        items,
        count: items.length,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_prune (orphan-project cleanup) ----
  server.tool(TOOL_DEFS[23].name, TOOL_DEFS[23].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const scope = args.scope === 'all-projects' ? 'all-projects' : 'project';
      const apply = !!args.apply;
      const activeCanonical = pr.value; // canonicalized in resolveProjectRoot
      // Collect the project directories to inspect.
      //   scope='project'     → only the active project
      //   scope='all-projects' → every project directory except the active one
      const memDir = path.join(home, 'kimi-memory');
      let entries = [];
      try {
        entries = readdirSync(memDir, { withFileTypes: true });
      } catch (e) {
        if (e && e.code === 'ENOENT') {
          return ok({
            operation: 'pruned',
            scope,
            apply,
            candidates: [],
            removed: 0,
            note: 'no kimi-memory data directory yet',
          });
        }
        throw e;
      }
      // Always include the active project (so the user sees the check, even
      // when its path exists and it's not a prune candidate). For
      // all-projects we skip the active project's directory entirely.
      const activeKey = deriveProjectKey(activeCanonical);
      const projectDirs = entries
        .filter((d) => d.isDirectory() && d.name !== GLOBAL_PROJECT_KEY)
        .filter((d) => {
          // The active project is always included in the report so the
          // user can see it was inspected (it is never removed). For
          // scope='all-projects' we also include every other project.
          if (d.name === activeKey) return true;
          return scope === 'all-projects';
        })
        .map((d) => ({
          key: d.name,
          dir: path.join(memDir, d.name),
          db: path.join(memDir, d.name, 'memory.sqlite'),
        }));

      const candidates = [];
      for (const p of projectDirs) {
        // Resolve a canonical root if the DB has one; otherwise report
        // "unknown" so the user can decide manually.
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
        // Active project's DB is always reported as kept regardless of apply.
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
          // Orphan candidate.
          let action = 'would-remove';
          if (apply) {
            try {
              // Drop the cached handle before deleting the file.
              closeDb(p.db);
              rmSync(p.dir, { recursive: true, force: true });
              action = 'removed';
            } catch (e) {
              action = 'error';
              candidates.push({
                project_key: p.key,
                db_path: p.db,
                canonical_root: recordedRoot,
                exists_on_disk: existsOnDisk,
                first_seen_at: firstSeenAt,
                last_seen_at: lastSeenAt,
                action,
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
      const removed = candidates.filter((c) => c.action === 'removed').length;
      return ok({
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
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- memory_diagnostics (error logs and system observability) ----
  server.tool(TOOL_DEFS[24].name, TOOL_DEFS[24].input, async (args) => {
    try {
      const hoursBack = args.hours_back || 24;
      const limit = args.limit || 100;
      const typeFilter = args.type_filter || null;

      const recent = await getRecentLogs(limit, typeFilter);
      const summary = await getErrorSummary(hoursBack);

      return ok({
        operation: 'diagnostics',
        recent_logs: recent,
        error_summary: summary,
        hours_back: hoursBack,
        log_location: path.join(home, 'kimi-memory', '_diagnostics', 'hooks.log'),
        note: 'Recent logs are ordered most-recent-first. Use type_filter to focus on specific error types.',
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- ingest implementation (also used by hooks via JSON IPC) ----
  async function ingestOne({ home, db, projectKey, cwd, sessionId, workDirKey, force }) {
    await ensureProjectDir(home, projectKey);
    const state = await loadIngestState(home, projectKey);
    if (!state.sessions) state.sessions = {};
    const sessionKey = sessionId;
    const prev = state.sessions[sessionKey] || {};
    let wdk = workDirKey || prev.work_dir_key || null;
    if (!wdk) {
      const idx = await readSessionIndex(home);
      const hit = idx.find(
        (e) => e && (e.sessionId === sessionId || e.session_id === sessionId || e.id === sessionId),
      );
      if (hit && (hit.work_dir_key || hit.workDirKey)) wdk = hit.work_dir_key || hit.workDirKey;
    }
    const filePath = await locateSessionArchive(home, wdk, sessionId);
    if (!filePath) {
      return {
        ingested: 0,
        status: 'archive_not_found',
        session_id: sessionId,
        work_dir_key: wdk,
        project_key: projectKey,
      };
    }
    upsertConversation(db, projectKey, sessionId, cwd);
    const startByte = force ? 0 : prev.byte_offset || 0;
    let lastEventAt = force ? null : prev.last_event_at || null;
    let finalOffset = startByte;
    let newEvents = 0;
    let lineNo = force ? 0 : prev.line_count || 0;
    const lineBase = lineNo;
    for await (const ev of walkWire(filePath, startByte, lineBase)) {
      finalOffset = ev.nextByteOffset;
      lineNo = ev.lineNo;
      recordConversationEvent(db, projectKey, sessionId, ev.lineNo, ev.byteOffset, ev);
      newEvents += 1;
      if (ev.created_at) lastEventAt = ev.created_at;
    }
    updateConversationProgress(db, projectKey, sessionId, finalOffset, lineNo, lastEventAt);
    state.sessions[sessionKey] = {
      work_dir_key: wdk,
      byte_offset: finalOffset,
      line_count: lineNo,
      last_event_at: lastEventAt,
      last_import_at: nowIso(),
    };
    await saveIngestState(home, projectKey, state);
    return {
      ingested: newEvents,
      archive: filePath,
      session_id: sessionId,
      work_dir_key: wdk,
      project_key: projectKey,
      status: 'ok',
      byte_offset: finalOffset,
    };
  }

  function ok(payload) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
  function textError(message) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: String(message) }) }],
    };
  }

  return { server, ingestOne, _deps: { kimiHome: home, pluginRoot: root, logger: log } };
}

// Suppress unused-import warning when createRequire is referenced only
// in older test harnesses; no-op import is acceptable in ESM.
void createRequire;
