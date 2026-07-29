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
import { mkdirSync } from 'node:fs';
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
  saveMemory,
  saveMemoryBulk,
  getMemory,
  listMemories,
  deleteMemory,
  searchMemories,
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
} from './persist.js';
import {
  locateSessionArchive,
  walkWire,
  readSessionIndex,
} from './wire.js';
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
  toError,
} from './validation.js';

const TOOL_DEFS = [
  {
    name: 'memory_save',
    desc: 'Persist a memory entry. type \u2208 working|episodic|semantic|procedural.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z.enum(['project', 'global']).optional().describe('project: per-project durable memory (default). global: cross-project user memory under $KIMI_CODE_HOME/kimi-memory/_global/.'),
      type: z.enum(['working', 'episodic', 'semantic', 'procedural']).describe('Memory type.'),
      title: z.string().max(500).optional(),
      content: z.string().min(1).max(200000).describe('Memory body.'),
      tags: z.array(z.string().min(1).max(64)).max(32).optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      provenance: z.record(z.string(), z.any()).optional(),
      confidence: z.number().min(0).max(1).optional(),
      priority: z.number().int().optional(),
      expires_at: z.string().optional(),
      supersede: z.boolean().optional(),
    },
  },
  {
    name: 'memory_recall',
    desc: 'Keyword search across the active scope\u2019s durable memories using FTS5.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z.enum(['project', 'global', 'all']).optional().describe('project: this project only. global: _global DB only. all: project + global, project hits first (default all).'),
      query: z.string().min(1).max(500).describe('Search query.'),
      type: z.enum(['working', 'episodic', 'semantic', 'procedural']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  {
    name: 'memory_list',
    desc: 'List durable memories in the active scope.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z.enum(['project', 'global', 'all']).optional().describe('project: this project only. global: _global DB only. all: project + global, project first (default all).'),
      type: z.enum(['working', 'episodic', 'semantic', 'procedural']).optional(),
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
      scope: z.enum(['project', 'global', 'all']).optional().describe('project: this project only. global: _global DB only. all: project first, then global (default all).'),
      id: z.string().min(4).max(64).describe('Memory id.'),
    },
  },
  {
    name: 'memory_update',
    desc: 'Patch a memory\u2019s fields. Provide only fields to change.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z.enum(['project', 'global']).optional().describe('project: this project only (default). global: _global DB only.'),
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
      scope: z.enum(['project', 'global']).optional().describe('project: this project only (default). global: _global DB only.'),
      id: z.string().min(4).max(64).describe('Memory id.'),
      hard: z.boolean().optional(),
    },
  },
  {
    name: 'working_memory_set',
    desc: 'Set a named working-memory slot for the current focus. Project-scoped only.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      slot: z.string().min(1).max(64).describe('Slot name, e.g. current_focus, active_task, recent_decision.'),
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
      session_id: z.string().min(1).max(128).describe('Session id (the directory name under sessions/).'),
      work_dir_key: z.string().optional().describe('Optional pre-hashed work-dir key; if absent we derive it from cwd.'),
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
      scope: z.enum(['project', 'global']).optional().describe('project: per-project durable memory (default). global: cross-project user memory under $KIMI_CODE_HOME/kimi-memory/_global/.'),
      items: z.array(z.object({
        type: z.enum(['working', 'episodic', 'semantic', 'procedural']).describe('Memory type.'),
        title: z.string().max(500).optional(),
        content: z.string().min(1).max(200000).describe('Memory body.'),
        tags: z.array(z.string().min(1).max(64)).max(32).optional(),
        metadata: z.record(z.string(), z.any()).optional(),
        provenance: z.record(z.string(), z.any()).optional(),
        confidence: z.number().min(0).max(1).optional(),
        priority: z.number().int().optional(),
        expires_at: z.string().optional(),
        supersede: z.boolean().optional(),
      })).min(1).max(500).describe('Memories to save in one transaction.'),
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
  const log = logger || ((...a) => { try { process.stderr.write('[kimi-memory] ' + a.join(' ') + '\n'); } catch { /* ignore */ } });

  const server = new McpServer({ name: 'kimi-memory', version: '0.1.0' });

  // Resolve the database handle and key for a given scope. `cwd` is
  // required for `project` and `all`; for `global` it is audit context
  // (caller must still pass it for provenance purposes) but does not
  // choose the database.
  function openScopeDb({ cwd, scope }) {
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
    return { db: openDb(projectDbPath(home, key)), projectKey: key, cwd: c };
  }

  // ---- memory_save ----
  server.tool(
    TOOL_DEFS[0].name,
    TOOL_DEFS[0].input,
    async (args) => {
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
        const target = openScopeDb({ cwd: pr.value, scope: sc.value });
        const provenance = { ...(pv.value || {}), source: (pv.value && pv.value.source) || 'memory_save', cwd: pr.value, scope: sc.value, recorded_at: nowIso() };
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
        });
        return ok({ operation: 'saved', scope: sc.value, memory: mem, project_key: target.projectKey });
      } catch (e) { return textError(toError(e).error); }
    }
  );

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
      const projectHandle = (scope === 'project' || scope === 'all') ? openScopeDb({ cwd: pr.value, scope: 'project' }) : null;
      const globalHandle = (scope === 'global' || scope === 'all') ? openScopeDb({ cwd: pr.value, scope: 'global' }) : null;
      const opts = { type: t.value, limit: lim.value };
      const projectItems = projectHandle ? searchMemories(projectHandle.db, projectHandle.projectKey, args.query, opts) : [];
      const globalItems = globalHandle ? searchMemories(globalHandle.db, GLOBAL_PROJECT_KEY, args.query, opts) : [];
      if (scope === 'project') {
        return ok({ operation: 'recalled', scope, items: projectItems, count: projectItems.length, project_key: projectHandle.projectKey });
      }
      if (scope === 'global') {
        return ok({ operation: 'recalled', scope, items: globalItems.map((m) => ({ ...m, scope: 'global' })), count: globalItems.length, project_key: GLOBAL_PROJECT_KEY });
      }
      // scope === 'all'
      const merged = mergeWithScope(projectItems, globalItems, { limit: lim.value, deriveTimestamp: (r) => r.updated_at });
      return ok({ operation: 'recalled', scope, items: merged.items, count: merged.items.length, project_count: merged.project_count, global_count: merged.global_count, project_key: projectHandle.projectKey });
    } catch (e) { return textError(toError(e).error); }
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
      const projectHandle = (scope === 'project' || scope === 'all') ? openScopeDb({ cwd: pr.value, scope: 'project' }) : null;
      const globalHandle = (scope === 'global' || scope === 'all') ? openScopeDb({ cwd: pr.value, scope: 'global' }) : null;
      const opts = { type: t.value, status: st.value, limit: lim.value, offset: off.value, includeExpired: !!args.includeExpired };
      const projectItems = projectHandle ? listMemories(projectHandle.db, projectHandle.projectKey, opts) : [];
      const globalItems = globalHandle ? listMemories(globalHandle.db, GLOBAL_PROJECT_KEY, opts) : [];
      if (scope === 'project') {
        return ok({ operation: 'listed', scope, items: projectItems, count: projectItems.length, project_key: projectHandle.projectKey });
      }
      if (scope === 'global') {
        return ok({ operation: 'listed', scope, items: globalItems.map((m) => ({ ...m, scope: 'global' })), count: globalItems.length, project_key: GLOBAL_PROJECT_KEY });
      }
      // scope === 'all'
      const merged = mergeWithScope(projectItems, globalItems, { limit: lim.value, deriveTimestamp: (r) => r.updated_at });
      return ok({ operation: 'listed', scope, items: merged.items, count: merged.items.length, project_count: merged.project_count, global_count: merged.global_count, project_key: projectHandle.projectKey });
    } catch (e) { return textError(toError(e).error); }
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
        if (mem) return ok({ operation: 'got', scope, memory: { ...mem, scope: 'global' }, project_key: GLOBAL_PROJECT_KEY });
      }
      return textError(`memory not found: ${id.value}`);
    } catch (e) { return textError(toError(e).error); }
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
      const target = openScopeDb({ cwd: pr.value, scope: sc.value });
      const existing = getMemory(target.db, target.projectKey, id.value, { includeSuperseded: true });
      if (!existing) return textError(`memory not found in ${sc.value} scope: ${id.value}`);
      const merged = { ...existing };
      if (args.title !== undefined) merged.title = asString(args.title);
      if (args.content !== undefined) merged.content = args.content;
      if (args.tags !== undefined) {
        const t = validateTags(args.tags);
        if (!t.ok) return textError(t.error);
        merged.tags = t.value;
      }
      if (args.metadata !== undefined) { const m = validateMetadata(args.metadata); if (!m.ok) return textError(m.error); merged.metadata = m.value; }
      if (args.provenance !== undefined) { const p = validateProvenance(args.provenance); if (!p.ok) return textError(p.error); merged.provenance = p.value; }
      if (args.confidence !== undefined) { const c = validateConfidence(args.confidence); if (!c.ok) return textError(c.error); merged.confidence = c.value; }
      if (args.status !== undefined) { const s = validateStatus(args.status); if (!s.ok) return textError(s.error); merged.status = s.value; }
      if (args.priority !== undefined) { const p = validatePriority(args.priority); if (!p.ok) return textError(p.error); merged.priority = p.value; }
      if (args.expires_at !== undefined) { const e2 = validateExpiresAt(args.expires_at); if (!e2.ok) return textError(e2.error); merged.expires_at = e2.value; }
      const mem = saveMemory(target.db, target.projectKey, merged);
      return ok({ operation: 'updated', scope: sc.value, memory: mem, project_key: target.projectKey });
    } catch (e) { return textError(toError(e).error); }
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
      const target = openScopeDb({ cwd: pr.value, scope: sc.value });
      const okDel = deleteMemory(target.db, target.projectKey, id.value, { hard: !!args.hard });
      return ok({ operation: 'deleted', scope: sc.value, deleted: okDel, id: id.value, project_key: target.projectKey });
    } catch (e) { return textError(toError(e).error); }
  });

  // ---- working_memory_set/get/clear (project-scoped only) ----
  server.tool(TOOL_DEFS[6].name, TOOL_DEFS[6].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const slot = validateSlot(args.slot);
      if (!slot.ok) return textError(slot.error);
      if (!args.value) return textError('value is required');
      const { db, projectKey } = openScopeDb({ cwd: pr.value, scope: 'project' });
      const r = setWorkingMemory(db, projectKey, slot.value, args.value);
      return ok({ operation: 'wm_set', slot: r.slot, value: r.value, updated_at: r.updated_at, project_key: projectKey, warning: slot.warning || null });
    } catch (e) { return textError(toError(e).error); }
  });

  server.tool(TOOL_DEFS[7].name, TOOL_DEFS[7].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const slot = validateSlot(args.slot);
      if (!slot.ok) return textError(slot.error);
      const { db, projectKey } = openScopeDb({ cwd: pr.value, scope: 'project' });
      const r = getWorkingMemory(db, projectKey, slot.value);
      return ok({ operation: 'wm_get', slot: slot.value, value: r ? r.value : null, updated_at: r ? r.updated_at : null, project_key: projectKey });
    } catch (e) { return textError(toError(e).error); }
  });

  server.tool(TOOL_DEFS[8].name, TOOL_DEFS[8].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const slot = validateSlot(args.slot);
      if (!slot.ok) return textError(slot.error);
      const { db, projectKey } = openScopeDb({ cwd: pr.value, scope: 'project' });
      const cleared = clearWorkingMemory(db, projectKey, slot.value);
      return ok({ operation: 'wm_clear', slot: slot.value, cleared, project_key: projectKey });
    } catch (e) { return textError(toError(e).error); }
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
    } catch (e) { return textError(toError(e).error); }
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
      const events = getConversationEvents(db, projectKey, args.session_id, { limit: lim.value, since: off.value });
      return ok({ operation: 'conv_get', conversation: meta, events, count: events.length, project_key: projectKey });
    } catch (e) { return textError(toError(e).error); }
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
      const items = searchConversationEvents(db, projectKey, args.query, { sessionId: args.session_id, role: role.value, limit: lim.value });
      return ok({ operation: 'conv_search', items, count: items.length, project_key: projectKey });
    } catch (e) { return textError(toError(e).error); }
  });

  server.tool(TOOL_DEFS[12].name, TOOL_DEFS[12].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const { db, projectKey, cwd } = openScopeDb({ cwd: pr.value, scope: 'project' });
      const r = await ingestOne({ home, db, projectKey, cwd, sessionId: args.session_id, workDirKey: args.work_dir_key, force: !!args.force });
      return ok({ operation: 'conv_ingest', ...r });
    } catch (e) { return textError(toError(e).error); }
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
      const wm = project.db.prepare("SELECT COUNT(*) AS n FROM working_memory WHERE project_key=?").get(project.projectKey).n;
      const conv = project.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE project_key=?").get(project.projectKey).n;
      const events = project.db.prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?").get(project.projectKey).n;
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
    } catch (e) { return textError(toError(e).error); }
  });

  // ---- memory_save_bulk (transactional batch save) ----
  server.tool(TOOL_DEFS[14].name, TOOL_DEFS[14].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const sc = validateScope(args.scope, { read: false });
      if (!sc.ok) return textError(sc.error);
      if (!Array.isArray(args.items) || args.items.length === 0) return textError('items must be a non-empty array');
      // Per-item validation: type, content, tags, metadata, provenance,
      // confidence, expires_at, priority. Collect every error before
      // bailing so the caller sees the full list.
      const cleaned = [];
      for (let i = 0; i < args.items.length; i++) {
        const item = args.items[i];
        const ctx = `items[${i}]`;
        const t = validateType(item.type);
        if (!t.ok) return textError(`${ctx}: ${t.error}`);
        const content = typeof item.content === 'string' && item.content.length > 0 ? item.content : null;
        if (!content) return textError(`${ctx}: content is required`);
        const tags = validateTags(item.tags);
        if (!tags.ok) return textError(`${ctx}: ${tags.error}`);
        const md = validateMetadata(item.metadata);
        if (!md.ok) return textError(`${ctx}: ${md.error}`);
        const pv = validateProvenance(item.provenance);
        if (!pv.ok) return textError(`${ctx}: ${pv.error}`);
        const conf = validateConfidence(item.confidence);
        if (!conf.ok) return textError(`${ctx}: ${conf.error}`);
        const exp = validateExpiresAt(item.expires_at);
        if (!exp.ok) return textError(`${ctx}: ${exp.error}`);
        const prio = validatePriority(item.priority);
        if (!prio.ok) return textError(`${ctx}: ${prio.error}`);
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
        });
      }
      const target = openScopeDb({ cwd: pr.value, scope: sc.value });
      // Stamp provenance so every saved row carries the caller's context.
      const baseProvenance = { source: 'memory_save_bulk', cwd: pr.value, scope: sc.value, recorded_at: nowIso() };
      const stamped = cleaned.map((item) => ({
        ...item,
        provenance: { ...(item.provenance || {}), ...baseProvenance },
      }));
      const mems = saveMemoryBulk(target.db, target.projectKey, stamped);
      return ok({ operation: 'saved_bulk', scope: sc.value, memories: mems, count: mems.length, project_key: target.projectKey });
    } catch (e) { return textError(toError(e).error); }
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
      const hit = idx.find((e) => e && (e.sessionId === sessionId || e.session_id === sessionId || e.id === sessionId));
      if (hit && (hit.work_dir_key || hit.workDirKey)) wdk = hit.work_dir_key || hit.workDirKey;
    }
    const filePath = await locateSessionArchive(home, wdk, sessionId);
    if (!filePath) {
      return { ingested: 0, status: 'archive_not_found', session_id: sessionId, work_dir_key: wdk, project_key: projectKey };
    }
    upsertConversation(db, projectKey, sessionId, cwd);
    const startByte = force ? 0 : (prev.byte_offset || 0);
    let lastEventAt = force ? null : (prev.last_event_at || null);
    let finalOffset = startByte;
    let newEvents = 0;
    let lineNo = force ? 0 : (prev.line_count || 0);
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
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: String(message) }) }] };
  }

  return { server, ingestOne, _deps: { kimiHome: home, pluginRoot: root, logger: log } };
}

// Suppress unused-import warning when createRequire is referenced only
// in older test harnesses; no-op import is acceptable in ESM.
void createRequire;
