// Memory CRUD MCP handlers (9 tools).
//
//   memory_save            — write a single row, optional supersede
//   memory_recall          — FTS5 + cosine + RRF hybrid search
//   memory_list            — paginated list of active rows
//   memory_get             — fetch one row by id (project → global)
//   memory_update          — patch one or more fields on a row
//   memory_delete          — soft (status='deleted') or hard delete
//   memory_save_bulk       — transactional batch save (≤500 items)
//   memory_status          — counts + consolidation + re-clone flags
//   memory_reinforce       — bump stability / rehearsal timestamp
//
// Per-domain handler module consumed by the orchestrator in
// src/server.js. Each handler is a plain async (args, ctx) => result
// function whose return value is wrapped by registerTool into the
// MCP tool-result content array. Failures are signaled by throwing
// `toolError(message)`.

import { registerTool } from '../lib/register-tool.js';
import { toolError } from '../lib/tool-error.js';
import { openScopeDb as openScopeDbInner, mergeWithScope } from '../lib/scope-db.js';
import { TOOL_DEFS_BY_NAME } from '../tool-defs.js';
import {
  validateScope,
  validateType,
  validateTags,
  validateMetadata,
  validateProvenance,
  validateConfidence,
  validateExpiresAt,
  validatePriority,
  validateId,
  validateStatus,
  validateLimit,
  validateOffset,
} from '../../validation.js';
import { validateSharedWith } from '../../acl.js';
import { GLOBAL_PROJECT_KEY, canonicalizeRoot, deriveProjectKey } from '../../project-key.js';
import {
  saveMemory,
  saveMemoryBulk,
  listMemories,
  getMemory,
  deleteMemory,
  searchMemories,
  reinforceMemory,
  memoryCounts,
} from '../../persist.js';
import { nowIso, asString } from '../../util.js';
import { detectReclone } from '../../persist/project.js';

export function register(server, handlers, home) {
  const D = TOOL_DEFS_BY_NAME;

  // ---- memory_save ----
  registerTool(
    server,
    D.memory_save,
    async (args, ctx) => {
      const t = validateType(args.type);
      if (!t.ok) throw toolError(t.error);
      const tags = validateTags(args.tags);
      if (!tags.ok) throw toolError(tags.error);
      const md = validateMetadata(args.metadata);
      if (!md.ok) throw toolError(md.error);
      const pv = validateProvenance(args.provenance);
      if (!pv.ok) throw toolError(pv.error);
      const conf = validateConfidence(args.confidence);
      if (!conf.ok) throw toolError(conf.error);
      const exp = validateExpiresAt(args.expires_at);
      if (!exp.ok) throw toolError(exp.error);
      const prio = validatePriority(args.priority);
      if (!prio.ok) throw toolError(prio.error);
      // Funnel shared_with through the same dedup + trim + cap that
      // acl_share_memory uses so duplicates and whitespace entries
      // never persist. Saves also surface any dropped entries in
      // the response so the caller can tell input was lost. (Audit fix.)
      let sharedWithValue;
      let droppedSharedWith = [];
      if (args.shared_with !== undefined) {
        const sw = validateSharedWith(args.shared_with);
        sharedWithValue = sw.value;
        droppedSharedWith = sw.dropped;
      }
      const content = args.content;
      if (!content) throw toolError('content is required');
      const provenance = {
        ...(pv.value || {}),
        source: (pv.value && pv.value.source) || 'memory_save',
        cwd: ctx.cwd,
        scope: ctx.scope,
        recorded_at: nowIso(),
      };
      const mem = saveMemory(ctx.db, ctx.projectKey, {
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
        // v10 ACL fields. visibility is validated by saveMemory; the
        // other fields are pass-through. shared_with is already
        // deduped/trimmed via validateSharedWith above.
        visibility: args.visibility || 'private',
        shared_with: sharedWithValue,
        // team_id / agent_id / user_id / session_id / task_id are
        // intentionally NOT forwarded from the tool surface — see the
        // TOOL_DEFS comment for memory_save (lines 168-173) for the
        // rationale. The columns remain on the row, set by the hook
        // layer where the principal is observable.
      });
      return {
        operation: 'saved',
        scope: ctx.scope,
        memory: mem,
        project_key: ctx.projectKey,
        // Surface dropped entries so the caller knows input was lost.
        dropped_shared_with: droppedSharedWith.length ? droppedSharedWith : undefined,
      };
    },
    handlers,
    home,
  );

  // ---- memory_recall ----
  registerTool(
    server,
    D.memory_recall,
    async (args, ctx) => {
      const lim = validateLimit(args.limit, 1, 200, 20);
      if (!lim.ok) throw toolError(lim.error);
      const sc = validateScope(args.scope, { read: true });
      if (!sc.ok) throw toolError(sc.error);
      const t = args.type ? validateType(args.type) : { ok: true, value: null };
      if (!t.ok) throw toolError(t.error);
      const scope = sc.value;
      const projectHandle =
        scope === 'project' || scope === 'all'
          ? openScopeDbInner({ cwd: ctx.cwd, scope: 'project', home })
          : null;
      const globalHandle =
        scope === 'global' || scope === 'all'
          ? openScopeDbInner({ cwd: ctx.cwd, scope: 'global', home })
          : null;
      const opts = { type: t.value, limit: lim.value };
      // v10: pass visibility filter through to searchMemories so the
      // FTS and vector channels both honour it. Accept either a single
      // string ('team') or an array (['private','team']). null/undefined
      // means no filter (preserves the pre-v10 recall surface).
      if (typeof args.visibility === 'string') {
        opts.visibility = args.visibility;
      } else if (Array.isArray(args.visibility)) {
        opts.visibility = args.visibility;
      }
      // v10 fusion strategy. Default rrf; 'weighted' preserves the
      // pre-v10 0.5/0.5 blend. rrf_k is forwarded verbatim.
      if (args.fusion === 'weighted' || args.fusion === 'rrf') {
        opts.fusion = args.fusion;
      }
      if (Number.isFinite(args.rrf_k) && args.rrf_k > 0) {
        opts.rrfK = args.rrf_k;
      }
      // v10 tier filter (single string or array). tier_budgets caps
      // each tier independently after the standard selection.
      if (typeof args.tier === 'string') {
        opts.tier = args.tier;
      } else if (Array.isArray(args.tier)) {
        opts.tier = args.tier;
      }
      if (args.tier_budgets && typeof args.tier_budgets === 'object') {
        opts.tierBudgets = args.tier_budgets;
      }
      if (Number.isFinite(args.max_chars_per_memory) && args.max_chars_per_memory > 0) {
        opts.maxCharsPerMemory = args.max_chars_per_memory;
      }
      if (Number.isFinite(args.max_total_recall_chars) && args.max_total_recall_chars > 0) {
        opts.maxTotalRecallChars = args.max_total_recall_chars;
      }
      const projectItems =
        projectHandle && projectHandle.db
          ? await searchMemories(projectHandle.db, projectHandle.projectKey, args.query, opts)
          : [];
      const globalItems =
        globalHandle && globalHandle.db
          ? await searchMemories(globalHandle.db, GLOBAL_PROJECT_KEY, args.query, opts)
          : [];
      if (scope === 'project') {
        return {
          operation: 'recalled',
          scope,
          items: projectItems,
          count: projectItems.length,
          project_key: projectHandle.projectKey,
        };
      }
      if (scope === 'global') {
        return {
          operation: 'recalled',
          scope,
          items: globalItems.map((m) => ({ ...m, scope: 'global' })),
          count: globalItems.length,
          project_key: GLOBAL_PROJECT_KEY,
        };
      }
      // scope === 'all'
      const merged = mergeWithScope(projectItems, globalItems, {
        limit: lim.value,
        deriveTimestamp: (r) => r.updated_at,
      });
      return {
        operation: 'recalled',
        scope,
        items: merged.items,
        count: merged.items.length,
        project_count: merged.project_count,
        global_count: merged.global_count,
        project_key: projectHandle.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- memory_list ----
  registerTool(
    server,
    D.memory_list,
    async (args, ctx) => {
      const lim = validateLimit(args.limit, 1, 500, 50);
      if (!lim.ok) throw toolError(lim.error);
      const off = validateOffset(args.offset);
      if (!off.ok) throw toolError(off.error);
      const st = validateStatus(args.status);
      if (!st.ok) throw toolError(st.error);
      const t = args.type ? validateType(args.type) : { ok: true, value: null };
      if (!t.ok) throw toolError(t.error);
      const sc = validateScope(args.scope, { read: true });
      if (!sc.ok) throw toolError(sc.error);
      const scope = sc.value;
      const projectHandle =
        scope === 'project' || scope === 'all'
          ? openScopeDbInner({ cwd: ctx.cwd, scope: 'project', home })
          : null;
      const globalHandle =
        scope === 'global' || scope === 'all'
          ? openScopeDbInner({ cwd: ctx.cwd, scope: 'global', home })
          : null;
      const opts = {
        type: t.value,
        status: st.value,
        limit: lim.value,
        offset: off.value,
        includeExpired: !!args.includeExpired,
      };
      const projectItems =
        projectHandle && projectHandle.db
          ? listMemories(projectHandle.db, projectHandle.projectKey, opts)
          : [];
      const globalItems =
        globalHandle && globalHandle.db
          ? listMemories(globalHandle.db, GLOBAL_PROJECT_KEY, opts)
          : [];
      if (scope === 'project') {
        return {
          operation: 'listed',
          scope,
          items: projectItems,
          count: projectItems.length,
          project_key: projectHandle.projectKey,
        };
      }
      if (scope === 'global') {
        return {
          operation: 'listed',
          scope,
          items: globalItems.map((m) => ({ ...m, scope: 'global' })),
          count: globalItems.length,
          project_key: GLOBAL_PROJECT_KEY,
        };
      }
      // scope === 'all'
      const merged = mergeWithScope(projectItems, globalItems, {
        limit: lim.value,
        deriveTimestamp: (r) => r.updated_at,
      });
      return {
        operation: 'listed',
        scope,
        items: merged.items,
        count: merged.items.length,
        project_count: merged.project_count,
        global_count: merged.global_count,
        project_key: projectHandle.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- memory_get ----
  registerTool(
    server,
    D.memory_get,
    async (args, ctx) => {
      const id = validateId(args.id);
      if (!id.ok) throw toolError(id.error);
      const sc = validateScope(args.scope, { read: true });
      if (!sc.ok) throw toolError(sc.error);
      const scope = sc.value;
      if (scope === 'project' || scope === 'all') {
        const target = openScopeDbInner({ cwd: ctx.cwd, scope: 'project', home });
        const mem = getMemory(target.db, target.projectKey, id.value);
        if (mem) {
          const tagged = scope === 'all' ? { ...mem, scope: 'project' } : mem;
          return { operation: 'got', scope, memory: tagged, project_key: target.projectKey };
        }
        if (scope === 'project') throw toolError(`memory not found: ${id.value}`);
      }
      if (scope === 'global' || scope === 'all') {
        const target = openScopeDbInner({ cwd: ctx.cwd, scope: 'global', home });
        if (target.db) {
          const mem = getMemory(target.db, GLOBAL_PROJECT_KEY, id.value);
          if (mem)
            return {
              operation: 'got',
              scope,
              memory: { ...mem, scope: 'global' },
              project_key: GLOBAL_PROJECT_KEY,
            };
        }
      }
      throw toolError(`memory not found: ${id.value}`);
    },
    handlers,
    home,
  );

  // ---- memory_update ----
  registerTool(
    server,
    D.memory_update,
    async (args, ctx) => {
      const id = validateId(args.id);
      if (!id.ok) throw toolError(id.error);
      const existing = getMemory(ctx.db, ctx.projectKey, id.value, {
        includeSuperseded: true,
      });
      if (!existing) throw toolError(`memory not found in ${ctx.scope} scope: ${id.value}`);
      const merged = { ...existing };
      if (args.title !== undefined) merged.title = asString(args.title);
      if (args.content !== undefined) merged.content = args.content;
      if (args.tags !== undefined) {
        const t = validateTags(args.tags);
        if (!t.ok) throw toolError(t.error);
        merged.tags = t.value;
      }
      if (args.metadata !== undefined) {
        const m = validateMetadata(args.metadata);
        if (!m.ok) throw toolError(m.error);
        merged.metadata = m.value;
      }
      if (args.provenance !== undefined) {
        const p = validateProvenance(args.provenance);
        if (!p.ok) throw toolError(p.error);
        merged.provenance = p.value;
      }
      if (args.confidence !== undefined) {
        const c = validateConfidence(args.confidence);
        if (!c.ok) throw toolError(c.error);
        merged.confidence = c.value;
      }
      if (args.status !== undefined) {
        const s = validateStatus(args.status);
        if (!s.ok) throw toolError(s.error);
        merged.status = s.value;
      }
      if (args.priority !== undefined) {
        const p = validatePriority(args.priority);
        if (!p.ok) throw toolError(p.error);
        merged.priority = p.value;
      }
      if (args.expires_at !== undefined) {
        const e2 = validateExpiresAt(args.expires_at);
        if (!e2.ok) throw toolError(e2.error);
        merged.expires_at = e2.value;
      }
      // v10 ACL fields. Omitted fields are not changed; passing
      // undefined leaves the column at its existing value (saveMemory's
      // COALESCE behavior preserves the row).
      if (args.visibility !== undefined) merged.visibility = args.visibility;
      let droppedSharedWith = [];
      if (args.shared_with !== undefined) {
        // Funnel shared_with through the same dedup + trim + cap
        // path memory_save uses. Duplicate / whitespace entries are
        // silently dropped by validateSharedWith; mirror that on
        // update so the two surfaces cannot drift.
        const sw = validateSharedWith(args.shared_with);
        merged.shared_with = sw.value;
        droppedSharedWith = sw.dropped;
      }
      // Identity columns (team_id / agent_id / user_id / session_id /
      // task_id) are not accepted on update; see memory_save TOOL_DEFS
      // comment.
      const mem = saveMemory(ctx.db, ctx.projectKey, merged);
      return {
        operation: 'updated',
        scope: ctx.scope,
        memory: mem,
        project_key: ctx.projectKey,
        dropped_shared_with: droppedSharedWith.length ? droppedSharedWith : undefined,
      };
    },
    handlers,
    home,
  );

  // ---- memory_delete ----
  registerTool(
    server,
    D.memory_delete,
    async (args, ctx) => {
      const id = validateId(args.id);
      if (!id.ok) throw toolError(id.error);
      const okDel = deleteMemory(ctx.db, ctx.projectKey, id.value, { hard: !!args.hard });
      return {
        operation: 'deleted',
        scope: ctx.scope,
        deleted: okDel,
        id: id.value,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- memory_status ----
  registerTool(
    server,
    D.memory_status,
    async (args, ctx) => {
      // status is a read tool; openScopeDb with record=false (the
      // wrapper's default for non-write tools). The previous inline
      // handler used the local openScopeDb which defaults to
      // record=false too, so behavior is preserved.
      const projectMem = memoryCounts(ctx.db, ctx.projectKey);
      // Global DB may be absent on a fresh install — return zeros rather
      // than throw. PROJECT.md §3 forbids lazy-creating the global DB
      // on a read. (Audit flag B1-1/B2-5.)
      const globalTarget = openScopeDbInner({ cwd: ctx.cwd, scope: 'global', home });
      const globalMem = globalTarget.db
        ? memoryCounts(globalTarget.db, GLOBAL_PROJECT_KEY)
        : {
            total: 0,
            active: 0,
            retained: 0,
            expired: 0,
            superseded: 0,
            deleted: 0,
            by_type: {},
            by_status: {},
            latest_update_at: null,
          };
      const wm = ctx.db
        .prepare('SELECT COUNT(*) AS n FROM working_memory WHERE project_key=?')
        .get(ctx.projectKey).n;
      const conv = ctx.db
        .prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_key=?')
        .get(ctx.projectKey).n;
      const events = ctx.db
        .prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?')
        .get(ctx.projectKey).n;
      // Consolidation diagnostics (v15). Additive block — existing
      // fields stay so dashboards keyed on the old shape keep working.
      let consolidation = null;
      try {
        const withEmbed = ctx.db
          .prepare(
            `SELECT COUNT(*) AS n FROM memories
             WHERE project_key=? AND status='active'
               AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
               AND embedding IS NOT NULL AND embedding_dim IS NOT NULL`,
          )
          .get(ctx.projectKey).n;
        const withoutEmbed = ctx.db
          .prepare(
            `SELECT COUNT(*) AS n FROM memories
             WHERE project_key=? AND status='active'
               AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
               AND (embedding IS NULL OR embedding_dim IS NULL)`,
          )
          .get(ctx.projectKey).n;
        const unclustered = ctx.db
          .prepare(
            `SELECT COUNT(*) AS n FROM memories m
             WHERE m.project_key=? AND m.status='active'
               AND (m.expires_at IS NULL OR datetime(m.expires_at) > datetime('now'))
               AND NOT EXISTS (
                 SELECT 1 FROM memory_synthesizes s
                 WHERE s.project_key=m.project_key AND s.child_id=m.id
               )`,
          )
          .get(ctx.projectKey).n;
        const lastConsolidateRow = ctx.db
          .prepare(
            `SELECT at FROM consolidation_runs
             WHERE project_key=?
             ORDER BY datetime(at) DESC LIMIT 1`,
          )
          .get(ctx.projectKey);
        const lastDreamApplyRow = ctx.db
          .prepare(
            `SELECT applied_at AS at FROM dream_jobs
             WHERE project_key=? AND status='applied' AND applied_at IS NOT NULL
             ORDER BY datetime(applied_at) DESC LIMIT 1`,
          )
          .get(ctx.projectKey);
        consolidation = {
          embedding_coverage: { with_embedding: withEmbed, without_embedding: withoutEmbed },
          unclustered_active: unclustered,
          last_consolidate_at: lastConsolidateRow ? lastConsolidateRow.at : null,
          last_dream_apply_at: lastDreamApplyRow ? lastDreamApplyRow.at : null,
        };
      } catch (e) {
        // consolidation_runs may not exist yet on a pre-v15 DB; the
        // SELECT throws. Surface a partial result so the user still
        // sees the embedding coverage + unclustered counts.
        consolidation = {
          error: 'partial',
          reason: e && e.message ? e.message : String(e),
        };
      }
      // Re-clone detection: surface a flag in the status payload so
      // dashboards and the hook layer can warn the user without making
      // a second tool call. Best-effort; never throws.
      let reclone = null;
      try {
        reclone = detectReclone(ctx.db, ctx.projectKey, ctx.cwd);
      } catch (e) {
        reclone = { isReclone: false, reason: 'detect failed (see diagnostics)' };
      }
      return {
        project_key: ctx.projectKey,
        cwd: ctx.cwd,
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
        scopes: { project: ctx.projectKey, global: GLOBAL_PROJECT_KEY },
        // Stale-memory warning: a freshly re-cloned repo can have a
        // large, irrelevant memory cache. The hook layer surfaces this
        // as a [stale-memory] line; memory_reset_project (with
        // confirm=true) clears it.
        reclone,
        // v15: consolidation visibility block.
        consolidation,
      };
    },
    handlers,
    home,
  );

  // ---- memory_save_bulk (transactional batch save) ----
  registerTool(
    server,
    D.memory_save_bulk,
    async (args, ctx) => {
      if (!Array.isArray(args.items) || args.items.length === 0)
        throw toolError('items must be a non-empty array');
      if (args.items.length > 500) throw toolError('items must contain at most 500 entries');
      // Per-item validation. Every item is checked and every error
      // collected before bailing — callers see the full list of bad
      // items in a single response instead of fixing them one round
      // trip at a time. The cleaned list is only built from items
      // that pass; the rest are reported.
      const errors = [];
      const cleaned = [];
      for (let i = 0; i < args.items.length; i++) {
        const item = args.items[i];
        const ictx = `items[${i}]`;
        if (!item || typeof item !== 'object') {
          errors.push(`${ictx}: must be an object`);
          continue;
        }
        const t = validateType(item.type);
        if (!t.ok) {
          errors.push(`${ictx}: ${t.error}`);
          continue;
        }
        const content =
          typeof item.content === 'string' && item.content.length > 0 ? item.content : null;
        if (!content) {
          errors.push(`${ictx}: content is required`);
          continue;
        }
        const tags = validateTags(item.tags);
        if (!tags.ok) {
          errors.push(`${ictx}: ${tags.error}`);
          continue;
        }
        const md = validateMetadata(item.metadata);
        if (!md.ok) {
          errors.push(`${ictx}: ${md.error}`);
          continue;
        }
        const pv = validateProvenance(item.provenance);
        if (!pv.ok) {
          errors.push(`${ictx}: ${pv.error}`);
          continue;
        }
        const conf = validateConfidence(item.confidence);
        if (!conf.ok) {
          errors.push(`${ictx}: ${conf.error}`);
          continue;
        }
        const exp = validateExpiresAt(item.expires_at);
        if (!exp.ok) {
          errors.push(`${ictx}: ${exp.error}`);
          continue;
        }
        const prio = validatePriority(item.priority);
        if (!prio.ok) {
          errors.push(`${ictx}: ${prio.error}`);
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
          // v10 ACL fields. visibility defaults to 'private' inside
          // saveMemory; shared_with is pass-through.
          visibility: item.visibility || 'private',
          shared_with: Array.isArray(item.shared_with) ? item.shared_with : undefined,
          // team_id / agent_id / user_id / session_id / task_id are
          // intentionally not accepted on bulk — see memory_save
          // TOOL_DEFS comment.
        });
      }
      if (errors.length > 0) {
        throw toolError(
          `validation failed for ${errors.length} of ${args.items.length} item(s): ${errors.join('; ')}`,
        );
      }
      // Stamp provenance so every saved row carries the caller's context.
      const baseProvenance = {
        source: 'memory_save_bulk',
        cwd: ctx.cwd,
        scope: ctx.scope,
        recorded_at: nowIso(),
      };
      const stamped = cleaned.map((item) => ({
        ...item,
        provenance: { ...(item.provenance || {}), ...baseProvenance },
      }));
      const mems = saveMemoryBulk(ctx.db, ctx.projectKey, stamped);
      return {
        operation: 'saved_bulk',
        scope: ctx.scope,
        memories: mems,
        count: mems.length,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );

  // ---- memory_reinforce (signal-driven importance bump) ----
  registerTool(
    server,
    D.memory_reinforce,
    async (args, ctx) => {
      const id = validateId(args.id);
      if (!id.ok) throw toolError(id.error);
      const memory = reinforceMemory(ctx.db, ctx.projectKey, id.value);
      if (!memory) throw toolError(`memory not found in ${ctx.scope} scope: ${id.value}`);
      return {
        operation: 'reinforced',
        scope: ctx.scope,
        memory,
        project_key: ctx.projectKey,
      };
    },
    handlers,
    home,
  );
}
