// Tool definitions for the kimi-memory MCP server.
//
// Extracted from src/server.js (was lines 122-965) so the per-domain
// handler modules under src/mcp/handlers/ can each register their own
// slice without server.js growing further. The array shape is
// preserved verbatim: { name, desc, input } per entry, where `input`
// is a Zod raw-shape object consumed by `@modelcontextprotocol/sdk`.
//
// Re-exported from src/server.js so the proxy can read it without
// importing the orchestrator directly.

import { z } from 'zod';
export const TOOL_DEFS = [
  {
    name: 'memory_save',
    desc: 'Persist a memory entry. type ∈ working|episodic|semantic|procedural|conclusion|skill|context_snapshot.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global'])
        .optional()
        .describe(
          'project: per-project durable memory (default). global: cross-project user memory under $KIMI_CODE_HOME/kimi-memory/_global/.',
        ),
      type: z
        .enum([
          'working',
          'episodic',
          'semantic',
          'procedural',
          'conclusion',
          'skill',
          'context_snapshot',
        ])
        .describe(
          'Memory type. conclusion synthesizes N underlying memories. skill is matched against tool invocations. context_snapshot is for auto-extracted project state / plans / current-investigation lines — ranked below durable facts.',
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
      // v10 ACL / visibility fields. visibility defaults to 'private'
      // when omitted, so a save never accidentally produces a row that
      // bypasses the principal gate. shared_with is a JSON-encoded
      // list of "kind:id" principal descriptors (e.g. ["user:alice",
      // "role:editor"]); the ACL grants table (memories_acl) is the
      // authoritative source \u2014 shared_with is a denormalised cache
      // kept in sync by acl_share_memory / memory_share.
      visibility: z
        .enum(['private', 'team', 'restricted', 'agent', 'task'])
        .optional()
        .describe('v10: row visibility. Default private.'),
      shared_with: z
        .array(z.string().min(1).max(128))
        .max(32)
        .optional()
        .describe('v10: principal descriptors allowed to read this row.'),
      // team_id / agent_id / user_id are principal identity claims and
      // are no longer accepted from the tool surface: the MCP server
      // has no authenticated caller, so a tool input here would be a
      // forge vector. The columns exist on the row for the hook layer
      // (which has access to the running session principal) and for
      // future signed-token auth. session_id / task_id are dropped for
      // the same reason — the hook layer stamps them when it runs.
    },
  },
  {
    name: 'memory_recall',
    desc: 'Keyword search across the active scope\u2019s durable memories using FTS5. Hybrid FTS5 + cosine ranking, RRF-fused with the default RRF_K=60. Optional `visibility` (single string or array) and `tier` filters narrow the result set; `tier_budgets` caps per-tier selection; `max_chars_per_memory` truncates individual rows; `max_total_recall_chars` drops tail rows once the cumulative content length exceeds the budget.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global', 'all'])
        .optional()
        .describe(
          'project: this project only. global: _global DB only. all: project + global, project hits first (default all).',
        ),
      query: z
        .string()
        .min(1)
        .max(500)
        .describe('Search query. Supports basic FTS5 operators: "exact phrase" or -exclude.'),
      type: z
        .enum(['working', 'episodic', 'semantic', 'procedural', 'context_snapshot'])
        .optional(),
      limit: z.number().int().min(1).max(200).optional(),
      // Note: `recent_first` and `sort_by` were removed from the schema
      // (Audit SG-3). Results are always FTS-ranked; the per-type and
      // per-tier budgets below shape the selection but don't reorder.
      // v10: fusion strategy. 'rrf' (default) uses Reciprocal Rank
      // Fusion across FTS5 and the vector channel with RRF_K=60.
      // 'weighted' preserves the legacy 0.5/0.5 blend for callers that
      // need it. rrf_k overrides the default RRF_K constant when set.
      fusion: z
        .enum(['rrf', 'weighted'])
        .optional()
        .describe('v10: ranking strategy. Default rrf.'),
      rrf_k: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe('v10: RRF_K constant when fusion=rrf. Default 60.'),
      // v10: ACL filter. Accepts a single visibility level or an array.
      // Null / omitted = no filter (recall every active row regardless
      // of visibility). The filter is applied to both the FTS and the
      // vector channels.
      visibility: z
        .union([
          z.enum(['private', 'team', 'restricted', 'agent', 'task']),
          z.array(z.enum(['private', 'team', 'restricted', 'agent', 'task'])).max(5),
        ])
        .optional()
        .describe('v10: narrow recall to one or more visibility levels. Single string or array.'),
      // v10: tier filter (Chat Memory L0→L1→L2→L3). Single string or
      // array. The filter is independent of visibility; a row must pass
      // both gates to be recalled. Tier also drives per-tier budget
      // shaping when `tier_budgets` is supplied.
      tier: z
        .union([z.enum(['L0', 'L1', 'L2', 'L3']), z.array(z.enum(['L0', 'L1', 'L2', 'L3'])).max(4)])
        .optional()
        .describe('v10: narrow recall to one or more tier levels.'),
      // v10: per-tier recall budget. Map of tier → max count.
      tier_budgets: z
        .record(z.string(), z.number().int().min(0).max(50))
        .optional()
        .describe('v10: cap each tier independently. e.g. {L0:2, L1:2, L2:1, L3:1}.'),
      // v10: per-row content truncation. Cuts the content body to the
      // budget and appends a "…(truncated)" suffix. Surrogate-pair safe.
      max_chars_per_memory: z
        .number()
        .int()
        .min(20)
        .max(200000)
        .optional()
        .describe('v10: truncate individual row content to this many chars.'),
      // v10: cumulative character cap. Drops tail rows once the running
      // sum exceeds the budget. The first (highest-scoring) row is
      // always kept so callers always get at least one result; a row
      // whose own length exceeds the budget still fits (no per-row
      // truncation, that's `max_chars_per_memory`'s job).
      max_total_recall_chars: z
        .number()
        .int()
        .min(20)
        .max(2000000)
        .optional()
        .describe(
          'v10: drop tail rows once cumulative content length exceeds this. First row is always kept.',
        ),
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
      type: z
        .enum([
          'working',
          'episodic',
          'semantic',
          'procedural',
          'conclusion',
          'skill',
          'context_snapshot',
        ])
        .optional(),
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
      // v10 ACL fields. All optional; omitted fields are not changed.
      visibility: z
        .enum(['private', 'team', 'restricted', 'agent', 'task'])
        .optional()
        .describe('v10: row visibility.'),
      shared_with: z
        .array(z.string().min(1).max(128))
        .max(32)
        .optional()
        .describe('v10: principal descriptors allowed to read this row.'),
      // identity columns (team_id / agent_id / user_id / session_id /
      // task_id) are not accepted on update; the persisted columns
      // are hook-layer-managed to keep the tool surface unforgeable.
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
              .enum(['working', 'episodic', 'semantic', 'procedural', 'conclusion', 'skill'])
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
            // v10 ACL fields (same shape as memory_save).
            visibility: z.enum(['private', 'team', 'restricted', 'agent', 'task']).optional(),
            shared_with: z.array(z.string().min(1).max(128)).max(32).optional(),
            // identity columns are intentionally absent on bulk too;
            // see memory_save for rationale.
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
        .enum(['project', 'global', 'all'])
        .optional()
        .describe(
          'project: this project only (default). global: _global DB only. all: project + global.',
        ),
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
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Max records to return. Default 100.'),
    },
  },
  {
    name: 'memory_reset_project',
    desc: 'Wipe every per-project row (memories, working memory, conversations, conversation events, edges, synthesizes) for the active project so the project starts from a clean slate. Use this after a repo is re-cloned to the same canonical path — the project_key is a hash of the path, so kimi-memory cannot otherwise tell the new project apart from the old one. Requires confirm=true to actually delete; without it the call is a dry run that returns the row counts that would be deleted. The global database and every other project DB are never touched. Run memory_status first if you want to see what is on file.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      confirm: z
        .boolean()
        .optional()
        .describe('When true, perform the destructive reset. Default false (dry run).'),
    },
  },
  // ----- v10 ACL / visibility -----
  {
    name: 'acl_grant',
    desc: 'Grant an ACL entry for a memory: who can read it. principal_kind ∈ {user, team, role, agent}; principal_id is the identifier for that principal (e.g. "alice", "eng", "editor"). Idempotent via UNIQUE(memory_id, principal_kind, principal_id).',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z.enum(['project', 'global']).optional(),
      memory_id: z.string().min(4).max(64).describe('Memory id.'),
      principal_kind: z
        .enum(['user', 'team', 'role', 'agent'])
        .describe('Kind of principal being granted access.'),
      principal_id: z.string().min(1).max(128).describe('Identifier of the principal.'),
    },
  },
  {
    name: 'acl_revoke',
    desc: 'Revoke an ACL entry for a memory. Returns whether a row was deleted. Idempotent: revoking a non-existent grant returns removed=false.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z.enum(['project', 'global']).optional(),
      memory_id: z.string().min(4).max(64).describe('Memory id.'),
      principal_kind: z.enum(['user', 'team', 'role', 'agent']).describe('Kind of principal.'),
      principal_id: z.string().min(1).max(128).describe('Identifier of the principal.'),
    },
  },
  {
    name: 'acl_list',
    desc: 'List every ACL grant on a memory. Returns an array of {memory_id, principal_kind, principal_id, granted_at}.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z.enum(['project', 'global']).optional(),
      memory_id: z.string().min(4).max(64).describe('Memory id.'),
    },
  },
  {
    name: 'acl_share_memory',
    desc: 'Promote one or more memories to a new visibility level. Two modes: to_shared_pool=false (default) updates the row in place within the project DB; to_shared_pool=true moves the row into the cross-project shared DB at $KIMI_CODE_HOME/kimi-memory/_shared/memory.sqlite. Returns { moved, updated }. Idempotent: re-running is a no-op for already-shared rows.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z.enum(['project', 'global']).optional(),
      memory_ids: z
        .array(z.string().min(4).max(64))
        .min(1)
        .max(500)
        .describe('Memory ids to share.'),
      visibility: z
        .enum(['private', 'team', 'restricted', 'agent', 'task'])
        .describe('New visibility level.'),
      shared_with: z
        .array(z.string().min(1).max(128))
        .max(32)
        .optional()
        .describe('Principal descriptors allowed to read (e.g. ["user:alice","role:editor"]).'),
      to_shared_pool: z
        .boolean()
        .optional()
        .describe('When true, move the row into the cross-project _shared DB. Default false.'),
    },
  },
  {
    name: 'acl_resolve_principal',
    desc: 'Parse a principal descriptor like "user:alice" into its parts {kind, id}. Returns null when the descriptor is malformed or the kind is unknown.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      descriptor: z.string().min(1).max(256).describe('Principal descriptor (kind:id).'),
    },
  },
  // ----- v10 tier / persona -----
  {
    name: 'memory_set_tier',
    desc: 'Move a memory to a specific tier (L0|L1|L2|L3). Writes an audit row to persona_promotions; no-op when the row is already at the target tier. Throws on invalid tier input.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z.enum(['project', 'global']).optional(),
      memory_id: z.string().min(4).max(64).describe('Memory id.'),
      tier: z.enum(['L0', 'L1', 'L2', 'L3']).describe('Target tier.'),
      reason: z.string().max(500).optional().describe('Optional reason recorded in the audit log.'),
    },
  },
  {
    name: 'memory_promote',
    desc: 'Promote a memory one tier up (L0→L1, L1→L2, L2→L3). No-op when already at L3 or when the memory is missing / soft-deleted. Returns {memory, transition}; transition is the audit row or null when no transition happened.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z.enum(['project', 'global']).optional(),
      memory_id: z.string().min(4).max(64).describe('Memory id.'),
      reason: z.string().max(500).optional(),
    },
  },
  {
    name: 'memory_demote',
    desc: 'Demote a memory one tier down (L3→L2, L2→L1, L1→L0). No-op when already at L0.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z.enum(['project', 'global']).optional(),
      memory_id: z.string().min(4).max(64).describe('Memory id.'),
      reason: z.string().max(500).optional(),
    },
  },
  {
    name: 'memory_tier_history',
    desc: 'Return the audit log of tier transitions for a memory, oldest-first. Returns an empty list when no transitions have happened yet.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z.enum(['project', 'global']).optional(),
      memory_id: z.string().min(4).max(64).describe('Memory id.'),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  // ----- v10 CodeGraph (Phase 5) -----
  {
    name: 'codegraph_extract',
    desc: 'Walk a project directory and extract function/class/const symbols + import lines from every .js / .ts / .py file. Skips node_modules and dotdirs. Returns the file list; call codegraph_build_edges with apply=true to write call-graph edges into memory_edges.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      root: z.string().min(1).max(1024).optional().describe('Root to walk; defaults to cwd.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe('Max files to visit. Default 200.'),
    },
  },
  {
    name: 'codegraph_build_edges',
    desc: "Build memory_edges rows (kind='calls' default) between memories that mention the same symbol. apply=false is a dry run returning {inserted, candidates}; apply=true persists edges with metadata {file, lang, range}. Self-loops are dropped; pairs with only one matching memory are dropped too.",
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      files: z
        .array(
          z.object({
            file: z.string().min(1).max(1024),
            ext: z.string().min(1).max(16),
            symbols: z.array(z.object({ name: z.string(), kind: z.string() })).optional(),
            imports: z
              .array(z.object({ module: z.string(), symbols: z.array(z.string()) }))
              .optional(),
          }),
        )
        .min(1)
        .max(5000)
        .describe('Output of codegraph_extract.'),
      kind: z
        .enum(['imports', 'calls', 'defines'])
        .optional()
        .describe('Edge kind. Default calls.'),
      apply: z
        .boolean()
        .optional()
        .describe('When true, persist the edges. Default false (dry run).'),
    },
  },
  {
    name: 'codegraph_query_symbol',
    desc: 'BFS walk over the memory graph starting from a seed memory id. Returns {nodes:[{id, ...memory fields}]}. Honors `kind` (one of imports|calls|defines) and `max_depth` (default 5, capped at 20). max_depth=0 returns only the seed.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      memory_id: z.string().min(4).max(64).describe('Seed memory id.'),
      kind: z.enum(['imports', 'calls', 'defines']).optional(),
      max_depth: z.number().int().min(0).max(20).optional().describe('BFS depth cap. Default 5.'),
    },
  },
  {
    name: 'codegraph_impact_path',
    desc: 'Shortest path (BFS) from one memory id to another via codegraph edges. Returns {path:[id,id,...], hops} or {path:[], hops:-1} when no path exists.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      from_id: z.string().min(4).max(64).describe('Source memory id.'),
      to_id: z.string().min(4).max(64).describe('Target memory id.'),
      max_hops: z.number().int().min(1).max(20).optional().describe('BFS depth cap. Default 6.'),
      kind: z.enum(['imports', 'calls', 'defines']).optional(),
    },
  },
  {
    name: 'codegraph_callers',
    desc: 'Direct callers (predecessors) of a memory id along codegraph edges. kind filter optional; default all codegraph kinds.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      memory_id: z.string().min(4).max(64).describe('Target memory id.'),
      kind: z.enum(['imports', 'calls', 'defines']).optional(),
      depth: z.number().int().min(1).max(20).optional().describe('BFS depth. Default 1.'),
    },
  },
  {
    name: 'codegraph_callees',
    desc: 'Direct callees (successors) of a memory id along codegraph edges. kind filter optional; default all codegraph kinds.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      memory_id: z.string().min(4).max(64).describe('Source memory id.'),
      kind: z.enum(['imports', 'calls', 'defines']).optional(),
      depth: z.number().int().min(1).max(20).optional().describe('BFS depth. Default 1.'),
    },
  },
  // ----- Phase-1 Dream consolidation -----
  // Project-scoped review / apply surface for staged dream jobs.
  // Lists, status snapshots, and the three lifecycle operations
  // (enqueue, apply, discard). Global DB is intentionally absent —
  // Phase-1 dreams never touch the cross-project store.
  {
    name: 'dream_list_jobs',
    desc: 'List Phase-1 Dream jobs for a project, ordered newest-first. status filter optional.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      status: z
        .enum(['queued', 'running', 'ready', 'applied', 'stale', 'failed', 'cancelled'])
        .optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  {
    name: 'dream_get_job',
    desc: 'Fetch one Phase-1 Dream job by id with its proposal list.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      job_id: z.string().min(4).max(64).describe('Dream job id.'),
    },
  },
  {
    name: 'dream_list_proposals',
    desc: 'List the proposals for a Phase-1 Dream job. status filter optional (pending|stale|approved|applied|rejected).',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      job_id: z.string().min(4).max(64).describe('Dream job id.'),
      status: z.enum(['pending', 'stale', 'approved', 'applied', 'rejected']).optional(),
    },
  },
  {
    name: 'dream_get_proposal',
    desc: 'Fetch a single Phase-1 Dream proposal by id.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      proposal_id: z.string().min(4).max(64).describe('Dream proposal id.'),
    },
  },
  {
    name: 'dream_status',
    desc: 'Compact Dream status snapshot for the project: counts per status + a short label. Never echoes memory ids or bodies.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
    },
  },
  {
    name: 'dream_enqueue',
    desc: 'Enqueue a Phase-1 Dream job for the project. Idempotent: a concurrent or already-queued job is a no-op.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
    },
  },
  {
    name: 'dream_generate_proposals',
    desc: 'Run the deterministic consolidate pass against a queued dream job and persist the resulting proposals. Marks the job `ready`. Live memories are untouched.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      job_id: z.string().min(4).max(64).describe('Dream job id.'),
    },
  },
  {
    name: 'dream_apply_job',
    desc: 'Apply a ready Dream job in one transaction. Validates each proposal against the live rows (status, checksum), soft-supersedes unchanged sources, and marks stale proposals instead of applying them.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      job_id: z.string().min(4).max(64).describe('Dream job id.'),
      auto_apply_confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          'Skip proposals whose confidence is below this floor. Default applies all proposals.',
        ),
    },
  },
  {
    name: 'dream_discard_job',
    desc: 'Cancel a queued or ready Dream job. Pending proposals are marked rejected; live memories are untouched.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      job_id: z.string().min(4).max(64).describe('Dream job id.'),
      reason: z.string().max(500).optional().describe('Optional discard reason.'),
    },
  },
  {
    name: 'dreaming',
    desc: 'Configure and run the dreaming subsystem that consolidates, combines, and prunes memories on a wall-clock floor. The `args` field is a JSON object stringified before send. Allowed keys: sub (one of: status, on, off, auto, run, last), scope (project or global), interval_spec (e.g. 30m, 3h, 24h, 1d), interval_ms (integer ms; mutually exclusive with interval_spec), include (comma-separated subset of consolidate,dream,gc), exclude (comma-separated subset), force (true|false).',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      args: z
        .string()
        .min(2)
        .max(4000)
        .describe(
          'JSON-stringified object of options. See tool description for keys. Examples: "{\\"sub\\":\\"status\\"}" or "{\\"sub\\":\\"on\\",\\"interval_spec\\":\\"3h\\"}" or "{\\"sub\\":\\"run\\",\\"force\\":true}".',
        ),
    },
  },
];

// Name-keyed lookup built from the array above. Per-domain handler
// modules reference `TOOL_DEFS_BY_NAME.memory_save` instead of
// `TOOL_DEFS[0]`, decoupling handler order from registration order.
// The TOOL_DEFS array remains the single source of truth — this map
// is a derived view; any consumer that wants the array can still
// import it directly.
export const TOOL_DEFS_BY_NAME = Object.freeze(
  Object.fromEntries(TOOL_DEFS.map((d) => [d.name, d])),
);
