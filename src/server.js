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
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { kimiHome, nowIso, asString, safeErrorMessage } from './util.js';
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
  resetProject,
  detectReclone,
  resetProjectDryRunCounts,
  shareMemory,
  openSharedDb,
  sharedDbPath,
  setMemoryTier,
  promoteMemory,
  demoteMemory,
  listTierHistory,
} from './persist.js';
import { locateSessionArchive, walkWire, readSessionIndex } from './wire.js';
import { enumeratePruneCandidates } from './prune.js';
import {
  enqueueDreamJob,
  generateProposalsForJob,
  applyDreamJob,
  discardDreamJob,
  listJobs as listDreamJobs,
  listProposals as listDreamProposals,
  readJob as readDreamJob,
  readProposal as readDreamProposal,
  buildDreamStatus,
} from './dream.js';
import {
  grantMemoryAcl,
  revokeMemoryAcl,
  listMemoryAcls,
  parsePrincipalDescriptor,
  validatePrincipalKind,
  validateSharedWith,
} from './acl.js';
import {
  upsertWikiPage,
  getWikiPage,
  traverseWiki,
  backlinksWiki,
  resolveWiki as resolveWikiPage,
  extractWikiLinks,
} from './wiki.js';
import { extractCodeGraph, buildCodeGraphEdges, queryMemoryGraph } from './codegraph.js';
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
    desc: 'Persist a memory entry. type \u2208 working|episodic|semantic|procedural|conclusion|skill.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      scope: z
        .enum(['project', 'global'])
        .optional()
        .describe(
          'project: per-project durable memory (default). global: cross-project user memory under $KIMI_CODE_HOME/kimi-memory/_global/.',
        ),
      type: z
        .enum(['working', 'episodic', 'semantic', 'procedural', 'conclusion', 'skill'])
        .describe(
          'Memory type. conclusion is the higher-order type that synthesizes N underlying memories via the synthesizes[] input. skill is a v10 trigger-matching memory matched against tool invocations via matchSkillTriggers.',
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
      type: z.enum(['working', 'episodic', 'semantic', 'procedural']).optional(),
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
        .enum(['working', 'episodic', 'semantic', 'procedural', 'conclusion', 'skill'])
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
  // ----- v10 Wiki / LLM-Wiki -----
  {
    name: 'wiki_upsert_page',
    desc: 'Create or update a wiki page by name (idempotent). The wiki_id is derived deterministically from (project_key, name) so re-saving the same name rewrites the body in place. `links` is optional; when omitted, links are extracted from `[[wiki-name]]` and `[text](wiki:name)` markers in the body and recorded as kind=mentions. Resolves the page id after the write.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      service_id: z.string().max(128).optional(),
      team_id: z.string().max(128).optional(),
      name: z.string().min(1).max(128).describe('Unique page name within the project.'),
      body: z.string().max(200000).optional().describe('Markdown body.'),
      summary: z.string().max(2000).optional().describe('Short summary.'),
      links: z
        .array(
          z.object({
            name: z.string().min(1).max(128),
            kind: z.enum(['mentions', 'derived_from', 'contradicts', 'supersedes']).optional(),
          }),
        )
        .max(500)
        .optional()
        .describe('Explicit outgoing edges. When omitted, links are parsed from the body.'),
    },
  },
  {
    name: 'wiki_get_page',
    desc: 'Fetch a single wiki page by id or name. Returns null when neither matches.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      wiki_id: z.string().min(1).max(64).optional().describe('Wiki page id (preferred).'),
      name: z.string().min(1).max(128).optional().describe('Wiki page name (fallback).'),
    },
  },
  {
    name: 'wiki_traverse',
    desc: 'BFS walk of the wiki link graph starting from a seed page. Returns visited nodes (in BFS order) and the edges traversed. max_hops caps the depth (default 2). kinds filters which edge kinds are walked (default all).',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      wiki_id: z.string().min(1).max(64).describe('Seed wiki page id.'),
      max_hops: z.number().int().min(0).max(20).optional(),
      kinds: z.array(z.enum(['mentions', 'derived_from', 'contradicts', 'supersedes'])).optional(),
    },
  },
  {
    name: 'wiki_backlinks',
    desc: 'List every page that links to the given wiki_id (incoming edges). Optional kinds filter.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      wiki_id: z.string().min(1).max(64).describe('Target wiki page id.'),
      kinds: z.array(z.enum(['mentions', 'derived_from', 'contradicts', 'supersedes'])).optional(),
    },
  },
  {
    name: 'wiki_resolve',
    desc: 'Resolve a wiki name to its page record (wiki_id, name, summary, updated_at). Returns null when no page with that name exists. Used by extract-from-body to validate [[wiki-name]] references.',
    input: {
      cwd: z.string().describe('Project root (absolute path). Required.'),
      name: z.string().min(1).max(128).describe('Page name to resolve.'),
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

  // Server version must mirror kimi.plugin.json / package.json / package-lock.json.
  // Bump together with the manifest; tests/06-manifest.test.js asserts the manifest
  // and package-lock equality, but the MCP `initialize` response is what Kimi logs
  // at plugin load — drift there confuses users about the running version.
  const server = new McpServer({ name: 'kimi-memory', version: '0.5.1' });

  // Resolve the database handle and key for a given scope. `cwd` is
  // required for `project` and `all`; for `global` it is audit context
  // (caller must still pass it for provenance purposes) but does not
  // choose the database.
  //
  // `record` controls whether the canonical project root is stamped
  // into `project_paths` for this open, AND whether the parent
  // directory is lazy-created. Write tools pass `true`; read tools
  // pass `false` so a recall on a slow network share does not pay a
  // write per call and does not produce a side effect on disk.
  // (Audit finding B1-1 / B2-5.)
  function openScopeDb({ cwd, scope, record = false }) {
    if (scope === 'global') {
      const dbPath = globalDbPath(home);
      // Read paths must not create the global DB on a fresh install —
      // PROJECT.md §3 contract. openDb's `create: true` flag would
      // otherwise touch the file on every `memory_recall` / `memory_list`
      // / `memory_status` over scope='global'. (Audit flag B1-1/B2-5.)
      if (!existsSync(dbPath)) {
        if (record) mkdirSync(path.dirname(dbPath), { recursive: true });
        else return { db: null, projectKey: GLOBAL_PROJECT_KEY, cwd: cwd || null };
      }
      if (record) mkdirSync(path.dirname(dbPath), { recursive: true });
      return { db: openDb(dbPath), projectKey: GLOBAL_PROJECT_KEY, cwd: cwd || null };
    }
    if (!cwd) throw new Error('project cwd is required');
    const c = canonicalizeRoot(cwd);
    if (!c) throw new Error('invalid project cwd');
    const key = deriveProjectKey(c);
    if (record) mkdirSync(path.dirname(projectDbPath(home, key)), { recursive: true });
    const db = openDb(projectDbPath(home, key));
    if (record) recordProjectPath(db, key, c);
    return { db, projectKey: key, cwd: c };
  }

  // (Audit fix L4 — openScopeDbForWrite was a one-line wrapper around
  // openScopeDb({ ...args, record: true }). All 19 call sites now
  // pass `record: true` directly; the wrapper was removed.)

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
      // Funnel shared_with through the same dedup + trim + cap that
      // acl_share_memory uses so duplicates and whitespace entries
      // never persist. Saves also surface any dropped entries in
      // the response so the caller can tell input was lost. (Audit fix.)
      let sharedWithValue;
      let droppedSharedWith = [];
      if (args.shared_with !== undefined) {
        try {
          const sw = validateSharedWith(args.shared_with);
          sharedWithValue = sw.value;
          droppedSharedWith = sw.dropped;
        } catch (e) {
          return textError(e.message);
        }
      }
      const content = args.content;
      if (!content) return textError('content is required');
      const target = openScopeDb({ cwd: pr.value, scope: sc.value, record: true });
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
      return ok({
        operation: 'saved',
        scope: sc.value,
        memory: mem,
        project_key: target.projectKey,
        // Surface dropped entries so the caller knows input was lost.
        dropped_shared_with: droppedSharedWith.length ? droppedSharedWith : undefined,
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
      const projectItems =
        projectHandle && projectHandle.db
          ? listMemories(projectHandle.db, projectHandle.projectKey, opts)
          : [];
      const globalItems =
        globalHandle && globalHandle.db
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
        if (target.db) {
          const mem = getMemory(target.db, GLOBAL_PROJECT_KEY, id.value);
          if (mem)
            return ok({
              operation: 'got',
              scope,
              memory: { ...mem, scope: 'global' },
              project_key: GLOBAL_PROJECT_KEY,
            });
        }
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
      const target = openScopeDb({ cwd: pr.value, scope: sc.value, record: true });
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
        try {
          const sw = validateSharedWith(args.shared_with);
          merged.shared_with = sw.value;
          droppedSharedWith = sw.dropped;
        } catch (e) {
          return textError(e.message);
        }
      }
      // Identity columns (team_id / agent_id / user_id / session_id /
      // task_id) are not accepted on update; see memory_save TOOL_DEFS
      // comment.
      const mem = saveMemory(target.db, target.projectKey, merged);
      return ok({
        operation: 'updated',
        scope: sc.value,
        memory: mem,
        project_key: target.projectKey,
        dropped_shared_with: droppedSharedWith.length ? droppedSharedWith : undefined,
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
      const target = openScopeDb({ cwd: pr.value, scope: sc.value, record: true });
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
      const { db, projectKey } = openScopeDb({ cwd: pr.value, scope: 'project', record: true });
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
      const { db, projectKey } = openScopeDb({ cwd: pr.value, scope: 'project', record: true });
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
      const { db, projectKey, cwd } = openScopeDb({
        cwd: pr.value,
        scope: 'project',
        record: true,
      });
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
      // Global DB may be absent on a fresh install — return zeros rather
      // than throw. PROJECT.md §3 forbids lazy-creating the global DB
      // on a read. (Audit flag B1-1/B2-5.)
      const globalMem = global.db
        ? memoryCounts(global.db, GLOBAL_PROJECT_KEY)
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
      const wm = project.db
        .prepare('SELECT COUNT(*) AS n FROM working_memory WHERE project_key=?')
        .get(project.projectKey).n;
      const conv = project.db
        .prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_key=?')
        .get(project.projectKey).n;
      const events = project.db
        .prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?')
        .get(project.projectKey).n;
      // Re-clone detection: surface a flag in the status payload so
      // dashboards and the hook layer can warn the user without making
      // a second tool call. Best-effort; never throws.
      let reclone = null;
      try {
        reclone = detectReclone(project.db, project.projectKey, pr.value);
      } catch (e) {
        reclone = { isReclone: false, reason: 'detect failed (see diagnostics)' };
      }
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
        // Stale-memory warning: a freshly re-cloned repo can have a
        // large, irrelevant memory cache. The hook layer surfaces this
        // as a [stale-memory] line; memory_reset_project (with
        // confirm=true) clears it.
        reclone,
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
        return textError(
          `validation failed for ${errors.length} of ${args.items.length} item(s): ${errors.join('; ')}`,
        );
      }
      const target = openScopeDb({ cwd: pr.value, scope: sc.value, record: true });
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
      const target = openScopeDb({ cwd: pr.value, scope: sc.value, record: true });
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
      const target = openScopeDb({ cwd: pr.value, scope: sc.value, record: true });
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
      const target = openScopeDb({ cwd: pr.value, scope: sc.value, record: true });
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
      const target = openScopeDb({ cwd: pr.value, scope: sc.value, record: true });
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
      if (!target.db) return textError(`memory not found: ${id.value}`);
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
      const activeKey = deriveProjectKey(pr.value);
      const { candidates, note } = enumeratePruneCandidates({
        home,
        activeKey,
        scope,
        apply,
      });
      if (note) {
        return ok({
          operation: 'pruned',
          scope,
          apply,
          candidates: [],
          removed: 0,
          note,
        });
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

  // ---- memory_reset_project (wipe a single project's data) ----
  // Re-cloned repos share the project_key with the previous incarnation
  // (project_key = SHA-256 prefix of canonical path), so the only way to
  // discard the stale memories + working memory + session archive is to
  // delete the rows. The global DB and every other project DB are never
  // touched. The call is a dry run unless `confirm: true` is set; the
  // dry-run path returns the same shape so the caller (or a slash
  // command UI) can render a confirmation prompt before deleting.
  server.tool(TOOL_DEFS[25].name, TOOL_DEFS[25].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const key = deriveProjectKey(pr.value);
      const dbPath = projectDbPath(home, key);
      if (!existsSync(dbPath)) {
        return textError(`no project DB at ${dbPath} (project has not been written to yet)`);
      }
      // Re-clone check: when stale memory is the reason for the reset,
      // surface the diagnostic so the user can confirm. The check is
      // read-only and never blocks the call.
      const handle = openDb(dbPath);
      let reclone = null;
      try {
        reclone = detectReclone(handle, key, pr.value);
      } catch (e) {
        reclone = { isReclone: false, reason: 'detect failed (see diagnostics)' };
      }
      // Always run the dry-run counter first so we can echo what would
      // be deleted. The destructive path uses a transaction, so a
      // confirm=true call that errors partway through still leaves the
      // DB in a known state (rolled back).
      const counts = resetProjectDryRunCounts(handle, key);
      const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
      const confirm = args.confirm === true;
      if (!confirm) {
        return ok({
          operation: 'reset_project_dry_run',
          project_key: key,
          cwd: pr.value,
          reclone,
          row_counts: counts,
          total_rows: totalRows,
          note:
            'dry run: nothing was deleted. Pass confirm=true to wipe the per-project rows. ' +
            'The global database and every other project DB are never touched.',
        });
      }
      const summary = resetProject(handle, key, { canonicalRoot: pr.value });
      // Drop the cached handle so the next open re-reads the file.
      closeDb(dbPath);
      return ok({
        operation: 'reset_project',
        project_key: key,
        cwd: pr.value,
        reclone,
        ...summary,
        note:
          'per-project rows deleted. The global database and every other project DB were not touched. ' +
          'first_seen_at was reset to now, so the re-clone warning will not fire again until a new incarnation is recorded.',
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  // ---- v10 ACL / visibility ----
  //
  // The four v10 deprecated groups (ACL/visibility, tier/persona, wiki,
  // codegraph) are gated behind KIMI_MEMORY_LEGACY_SUBSYSTEMS=off.
  // The 20 tools in TOOL_DEFS[26..45] stay registered when the gate is
  // on (the default — backward compat) and are skipped entirely when
  // off. Schema tables remain so a user can flip the env var back on
  // without a migration. See AGENTS.md §Subsystem deprecation.

  // ---- v10 ACL / visibility ----

  if (process.env.KIMI_MEMORY_LEGACY_SUBSYSTEMS !== 'off') {
    // acl_grant: insert a grant into memories_acl. Idempotent.
    server.tool(TOOL_DEFS[26].name, TOOL_DEFS[26].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const sc = validateScope(args.scope, { read: false });
        if (!sc.ok) return textError(sc.error);
        const memId = validateId(args.memory_id);
        if (!memId.ok) return textError(memId.error);
        let kind;
        try {
          kind = validatePrincipalKind(args.principal_kind);
        } catch (e) {
          return textError(e.message);
        }
        const target = openScopeDb({ cwd: pr.value, scope: sc.value, record: true });
        const row = grantMemoryAcl(
          target.db,
          target.projectKey,
          memId.value,
          kind,
          args.principal_id,
        );
        return ok({
          operation: 'acl_granted',
          scope: sc.value,
          grant: row,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // acl_revoke: delete a grant from memories_acl.
    server.tool(TOOL_DEFS[27].name, TOOL_DEFS[27].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const sc = validateScope(args.scope, { read: false });
        if (!sc.ok) return textError(sc.error);
        const memId = validateId(args.memory_id);
        if (!memId.ok) return textError(memId.error);
        let kind;
        try {
          kind = validatePrincipalKind(args.principal_kind);
        } catch (e) {
          return textError(e.message);
        }
        const target = openScopeDb({ cwd: pr.value, scope: sc.value, record: true });
        const removed = revokeMemoryAcl(
          target.db,
          target.projectKey,
          memId.value,
          kind,
          args.principal_id,
        );
        return ok({
          operation: 'acl_revoked',
          scope: sc.value,
          memory_id: memId.value,
          principal_kind: kind,
          principal_id: args.principal_id,
          removed,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // acl_list: enumerate grants for a memory.
    server.tool(TOOL_DEFS[28].name, TOOL_DEFS[28].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const sc = validateScope(args.scope, { read: true });
        if (!sc.ok) return textError(sc.error);
        const memId = validateId(args.memory_id);
        if (!memId.ok) return textError(memId.error);
        const target = openScopeDb({ cwd: pr.value, scope: sc.value });
        const items = listMemoryAcls(target.db, target.projectKey, memId.value);
        return ok({
          operation: 'acl_list',
          scope: sc.value,
          memory_id: memId.value,
          items,
          count: items.length,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // acl_share_memory: promote memories to a new visibility level. May
    // also move rows into the cross-project _shared DB when to_shared_pool
    // is set. The shared DB lives at <kimiHome>/kimi-memory/_shared/.
    server.tool(TOOL_DEFS[29].name, TOOL_DEFS[29].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const sc = validateScope(args.scope, { read: false });
        if (!sc.ok) return textError(sc.error);
        if (!Array.isArray(args.memory_ids) || args.memory_ids.length === 0) {
          return textError('memory_ids must be a non-empty array');
        }
        if (args.memory_ids.length > 500) {
          return textError('memory_ids must contain at most 500 entries');
        }
        let sharedWith = [];
        let droppedSharedWith = [];
        try {
          const swResult = validateSharedWith(args.shared_with);
          sharedWith = swResult.value;
          droppedSharedWith = swResult.dropped;
        } catch (e) {
          return textError(e.message);
        }
        const target = openScopeDb({ cwd: pr.value, scope: sc.value, record: true });
        const result = shareMemory(target.db, target.projectKey, args.memory_ids, {
          visibility: args.visibility,
          sharedWith,
          toSharedPool: !!args.to_shared_pool,
          kimiHomeDir: home,
        });
        // Surface dropped entries so the caller knows input was lost.
        // (Audit finding B4-10.)
        return ok({
          operation: 'acl_shared',
          scope: sc.value,
          visibility: args.visibility,
          shared_with: sharedWith,
          dropped_shared_with: droppedSharedWith.length ? droppedSharedWith : undefined,
          to_shared_pool: !!args.to_shared_pool,
          moved: result.moved,
          updated: result.updated,
          target_shared_db_path: args.to_shared_pool ? sharedDbPath(home) : null,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // acl_resolve_principal: parse a "kind:id" descriptor into parts.
    // Pure / read-only — does not touch the DB. Useful for validating a
    // shared_with entry before saving.
    server.tool(TOOL_DEFS[30].name, TOOL_DEFS[30].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        if (!args.descriptor) return textError('descriptor is required');
        const parsed = parsePrincipalDescriptor(args.descriptor);
        return ok({
          operation: 'acl_resolve_principal',
          descriptor: args.descriptor,
          kind: parsed ? parsed.kind : null,
          id: parsed ? parsed.id : null,
          valid: !!parsed,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // ---- v10 tier / persona ----

    // memory_set_tier: explicit move to a target tier; writes audit row.
    server.tool(TOOL_DEFS[31].name, TOOL_DEFS[31].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const sc = validateScope(args.scope, { read: false });
        if (!sc.ok) return textError(sc.error);
        const memId = validateId(args.memory_id);
        if (!memId.ok) return textError(memId.error);
        const target = openScopeDb({ cwd: pr.value, scope: sc.value, record: true });
        const result = setMemoryTier(target.db, target.projectKey, memId.value, args.tier, {
          reason: args.reason || null,
        });
        if (!result.memory) return textError(`memory not found in ${sc.value}: ${memId.value}`);
        return ok({
          operation: 'set_tier',
          scope: sc.value,
          memory: result.memory,
          transition: result.transition,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // memory_promote: tier up by one.
    server.tool(TOOL_DEFS[32].name, TOOL_DEFS[32].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const sc = validateScope(args.scope, { read: false });
        if (!sc.ok) return textError(sc.error);
        const memId = validateId(args.memory_id);
        if (!memId.ok) return textError(memId.error);
        const target = openScopeDb({ cwd: pr.value, scope: sc.value, record: true });
        const result = promoteMemory(target.db, target.projectKey, memId.value, {
          reason: args.reason || null,
        });
        if (!result.memory) return textError(`memory not found in ${sc.value}: ${memId.value}`);
        return ok({
          operation: 'promote',
          scope: sc.value,
          memory: result.memory,
          transition: result.transition,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // memory_demote: tier down by one.
    server.tool(TOOL_DEFS[33].name, TOOL_DEFS[33].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const sc = validateScope(args.scope, { read: false });
        if (!sc.ok) return textError(sc.error);
        const memId = validateId(args.memory_id);
        if (!memId.ok) return textError(memId.error);
        const target = openScopeDb({ cwd: pr.value, scope: sc.value, record: true });
        const result = demoteMemory(target.db, target.projectKey, memId.value, {
          reason: args.reason || null,
        });
        if (!result.memory) return textError(`memory not found in ${sc.value}: ${memId.value}`);
        return ok({
          operation: 'demote',
          scope: sc.value,
          memory: result.memory,
          transition: result.transition,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // memory_tier_history: audit log of tier transitions for a memory.
    server.tool(TOOL_DEFS[34].name, TOOL_DEFS[34].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const sc = validateScope(args.scope, { read: true });
        if (!sc.ok) return textError(sc.error);
        const memId = validateId(args.memory_id);
        if (!memId.ok) return textError(memId.error);
        const lim = validateLimit(args.limit, 1, 500, 200);
        if (!lim.ok) return textError(lim.error);
        const target = openScopeDb({ cwd: pr.value, scope: sc.value });
        const items = listTierHistory(target.db, target.projectKey, memId.value, {
          limit: lim.value,
        });
        return ok({
          operation: 'tier_history',
          scope: sc.value,
          memory_id: memId.value,
          items,
          count: items.length,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // ---- v10 Wiki / LLM-Wiki ----

    // wiki_upsert_page: create or update a page by name.
    server.tool(TOOL_DEFS[35].name, TOOL_DEFS[35].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const target = openScopeDb({ cwd: pr.value, scope: 'project', record: true });
        const result = upsertWikiPage(target.db, target.projectKey, {
          service_id: args.service_id || '',
          team_id: args.team_id || '',
          name: args.name,
          body: args.body || '',
          summary: args.summary || '',
          links: Array.isArray(args.links) ? args.links : null,
        });
        return ok({
          operation: 'wiki_upsert_page',
          wiki_id: result.wiki_id,
          name: result.name,
          summary: result.summary,
          updated_at: result.updated_at,
          links: result.links,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // wiki_get_page: by id (preferred) or name.
    server.tool(TOOL_DEFS[36].name, TOOL_DEFS[36].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const target = openScopeDb({ cwd: pr.value, scope: 'project' });
        const page = getWikiPage(target.db, target.projectKey, {
          wikiId: args.wiki_id || null,
          name: args.name || null,
        });
        if (!page) return textError('wiki page not found');
        return ok({
          operation: 'wiki_get_page',
          page,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // wiki_traverse: BFS walk from a seed.
    server.tool(TOOL_DEFS[37].name, TOOL_DEFS[37].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const lim = validateLimit(args.max_hops, 0, 20, 2);
        if (!lim.ok) return textError(lim.error);
        const target = openScopeDb({ cwd: pr.value, scope: 'project' });
        const out = traverseWiki(target.db, target.projectKey, args.wiki_id, {
          max_hops: lim.value,
          kinds: Array.isArray(args.kinds) ? args.kinds : null,
        });
        return ok({
          operation: 'wiki_traverse',
          wiki_id: args.wiki_id,
          max_hops: lim.value,
          nodes: out.nodes,
          edges: out.edges,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // wiki_backlinks: incoming edges to a page.
    server.tool(TOOL_DEFS[38].name, TOOL_DEFS[38].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const target = openScopeDb({ cwd: pr.value, scope: 'project' });
        const items = backlinksWiki(target.db, target.projectKey, args.wiki_id, {
          kinds: Array.isArray(args.kinds) ? args.kinds : null,
        });
        return ok({
          operation: 'wiki_backlinks',
          wiki_id: args.wiki_id,
          items,
          count: items.length,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // wiki_resolve: name → page record.
    server.tool(TOOL_DEFS[39].name, TOOL_DEFS[39].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const target = openScopeDb({ cwd: pr.value, scope: 'project' });
        const page = resolveWikiPage(target.db, target.projectKey, args.name);
        return ok({
          operation: 'wiki_resolve',
          name: args.name,
          page,
          found: !!page,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // ---- v10 CodeGraph ----

    // codegraph_extract: walk a directory and emit per-file symbol lists.
    server.tool(TOOL_DEFS[40].name, TOOL_DEFS[40].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const rawRoot = args.root && args.root.length > 0 ? args.root : pr.value;
        // Refuse roots that escape the project boundary — otherwise a
        // prompt-injection attack via a recalled memory could walk
        // arbitrary directories. (Audit finding H1 / B1-2.)
        const root = path.resolve(rawRoot);
        const projectRoot = path.resolve(pr.value);
        if (root !== projectRoot && !root.startsWith(projectRoot + path.sep)) {
          return textError(
            `codegraph_extract root must be within the project directory (${projectRoot}); got ${root}`,
          );
        }
        const lim = validateLimit(args.limit, 1, 5000, 200);
        if (!lim.ok) return textError(lim.error);
        const files = await extractCodeGraph(root, { limit: lim.value });
        return ok({
          operation: 'codegraph_extract',
          root,
          files,
          count: files.length,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // codegraph_build_edges: form call-graph edges between memories.
    server.tool(TOOL_DEFS[41].name, TOOL_DEFS[41].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const target = openScopeDb({ cwd: pr.value, scope: 'project', record: true });
        const result = buildCodeGraphEdges(
          target.db,
          target.projectKey,
          Array.isArray(args.files) ? args.files : [],
          { apply: !!args.apply, kind: args.kind || 'calls' },
        );
        return ok({
          operation: 'codegraph_build_edges',
          kind: args.kind || 'calls',
          apply: !!args.apply,
          inserted: result.inserted,
          candidates: result.candidates,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // codegraph_query_symbol: BFS from a seed.
    server.tool(TOOL_DEFS[42].name, TOOL_DEFS[42].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const lim = validateLimit(args.max_depth, 0, 20, 5);
        if (!lim.ok) return textError(lim.error);
        const memId = validateId(args.memory_id);
        if (!memId.ok) return textError(memId.error);
        const target = openScopeDb({ cwd: pr.value, scope: 'project' });
        const out = queryMemoryGraph(target.db, target.projectKey, memId.value, {
          kind: args.kind || null,
          max_depth: lim.value,
        });
        return ok({
          operation: 'codegraph_query_symbol',
          memory_id: memId.value,
          kind: args.kind || null,
          max_depth: lim.value,
          nodes: out.nodes,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    // codegraph_impact_path: BFS shortest path.
    function bfsPath(db, projectKey, fromId, toId, maxHops, kind) {
      if (fromId === toId) return { path: [fromId], hops: 0 };
      const kindList = kind ? [kind] : ['imports', 'calls', 'defines'];
      const placeholders = kindList.map(() => '?').join(',');
      const queue = [[fromId]];
      const visited = new Set([fromId]);
      while (queue.length > 0) {
        const path = queue.shift();
        // Guard: the path has `path.length - 1` edges. A `maxHops`
        // cap should forbid any path whose edge count exceeds
        // maxHops, so we drop paths with `length > maxHops + 1` (the
        // +1 covers the seed node). The previous `length > maxHops + 1`
        // check was correct in spirit but let one extra edge slip
        // through when `next === toId` was found on the final
        // extension; the bound check now also fires *before* queueing
        // the candidate, so a run that returns `hops: maxHops + 1`
        // is impossible.
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
          // Bound check before enqueuing so we never store a path
          // whose hop count exceeds the cap. Without this, returning
          // a path that grew past maxHops was possible when `toId`
          // was discovered on the boundary extension.
          if (newPath.length > maxHops + 1) continue;
          visited.add(next);
          queue.push(newPath);
        }
      }
      return { path: [], hops: -1 };
    }

    server.tool(TOOL_DEFS[43].name, TOOL_DEFS[43].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const fromId = validateId(args.from_id);
        if (!fromId.ok) return textError(fromId.error);
        const toId = validateId(args.to_id);
        if (!toId.ok) return textError(toId.error);
        const lim = validateLimit(args.max_hops, 1, 20, 6);
        if (!lim.ok) return textError(lim.error);
        const target = openScopeDb({ cwd: pr.value, scope: 'project' });
        const out = bfsPath(
          target.db,
          target.projectKey,
          fromId.value,
          toId.value,
          lim.value,
          args.kind || null,
        );
        return ok({
          operation: 'codegraph_impact_path',
          from_id: fromId.value,
          to_id: toId.value,
          path: out.path,
          hops: out.hops,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    server.tool(TOOL_DEFS[44].name, TOOL_DEFS[44].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const memId = validateId(args.memory_id);
        if (!memId.ok) return textError(memId.error);
        const target = openScopeDb({ cwd: pr.value, scope: 'project' });
        const out = queryMemoryGraph(target.db, target.projectKey, memId.value, {
          kind: args.kind || null,
          max_depth: Math.max(1, Math.min(20, args.depth || 1)),
        });
        return ok({
          operation: 'codegraph_callers',
          memory_id: memId.value,
          nodes: out.nodes,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });

    server.tool(TOOL_DEFS[45].name, TOOL_DEFS[45].input, async (args) => {
      try {
        const pr = resolveProjectRoot(args.cwd);
        if (!pr.ok) return textError(pr.error);
        const memId = validateId(args.memory_id);
        if (!memId.ok) return textError(memId.error);
        const target = openScopeDb({ cwd: pr.value, scope: 'project' });
        const out = queryMemoryGraph(target.db, target.projectKey, memId.value, {
          kind: args.kind || null,
          max_depth: Math.max(1, Math.min(20, args.depth || 1)),
        });
        return ok({
          operation: 'codegraph_callees',
          memory_id: memId.value,
          nodes: out.nodes,
          project_key: target.projectKey,
        });
      } catch (e) {
        return textError(toError(e).error);
      }
    });
  } // end KIMI_MEMORY_LEGACY_SUBSYSTEMS gate (ACL + tier + wiki + codegraph)

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
    let walkerFailed = null;
    // Persist the cursor even on partial failure so a subsequent
    // ingest resumes from the last successfully-recorded byte instead
    // of restarting from byte 0 and re-trying the same failing tail.
    // (Audit finding B1-6.)
    try {
      for await (const ev of walkWire(filePath, startByte, lineBase)) {
        finalOffset = ev.nextByteOffset;
        lineNo = ev.lineNo;
        recordConversationEvent(db, projectKey, sessionId, ev.lineNo, ev.byteOffset, ev);
        newEvents += 1;
        if (ev.created_at) lastEventAt = ev.created_at;
      }
    } catch (e) {
      walkerFailed = e && (e.message || String(e));
    }
    updateConversationProgress(db, projectKey, sessionId, finalOffset, lineNo, lastEventAt);
    state.sessions[sessionKey] = {
      work_dir_key: wdk,
      byte_offset: finalOffset,
      line_count: lineNo,
      last_event_at: lastEventAt,
      last_import_at: nowIso(),
      last_error: walkerFailed,
    };
    await saveIngestState(home, projectKey, state);
    return {
      ingested: newEvents,
      archive: filePath,
      session_id: sessionId,
      work_dir_key: wdk,
      project_key: projectKey,
      status: walkerFailed ? 'partial' : 'ok',
      byte_offset: finalOffset,
      last_error: walkerFailed || undefined,
    };
  }

  // ---- Phase-1 Dream consolidation -----
  // All Dream MCP tools operate strictly on the project DB. Global
  // memories are never read or written. Each handler validates cwd
  // through the same resolveProjectRoot path as the rest of the
  // server so secret-scan / authorization conventions stay
  // consistent.

  server.tool(TOOL_DEFS[46].name, TOOL_DEFS[46].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const target = openScopeDb({ cwd: pr.value, scope: 'project' });
      const lim = validateLimit(args.limit, 1, 100, 20);
      if (!lim.ok) return textError(lim.error);
      const items = listDreamJobs(target.db, target.projectKey, {
        status: args.status || null,
        limit: lim.value,
      });
      return ok({
        operation: 'dream_list_jobs',
        status: args.status || null,
        items,
        count: items.length,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  server.tool(TOOL_DEFS[47].name, TOOL_DEFS[47].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const jobId = validateId(args.job_id);
      if (!jobId.ok) return textError(jobId.error);
      const target = openScopeDb({ cwd: pr.value, scope: 'project' });
      const job = readDreamJob(target.db, target.projectKey, jobId.value);
      if (!job) return textError(`dream job not found: ${jobId.value}`);
      const proposals = listDreamProposals(target.db, target.projectKey, jobId.value);
      return ok({
        operation: 'dream_get_job',
        job,
        proposals,
        proposals_count: proposals.length,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  server.tool(TOOL_DEFS[48].name, TOOL_DEFS[48].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const jobId = validateId(args.job_id);
      if (!jobId.ok) return textError(jobId.error);
      const target = openScopeDb({ cwd: pr.value, scope: 'project' });
      const items = listDreamProposals(target.db, target.projectKey, jobId.value, {
        status: args.status || null,
      });
      return ok({
        operation: 'dream_list_proposals',
        job_id: jobId.value,
        status: args.status || null,
        items,
        count: items.length,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  server.tool(TOOL_DEFS[49].name, TOOL_DEFS[49].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const propId = validateId(args.proposal_id);
      if (!propId.ok) return textError(propId.error);
      const target = openScopeDb({ cwd: pr.value, scope: 'project' });
      const proposal = readDreamProposal(target.db, target.projectKey, propId.value);
      if (!proposal) return textError(`dream proposal not found: ${propId.value}`);
      return ok({
        operation: 'dream_get_proposal',
        proposal,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  server.tool(TOOL_DEFS[50].name, TOOL_DEFS[50].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const target = openScopeDb({ cwd: pr.value, scope: 'project' });
      const status = buildDreamStatus(target.db, target.projectKey);
      return ok({
        operation: 'dream_status',
        status,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  server.tool(TOOL_DEFS[51].name, TOOL_DEFS[51].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const target = openScopeDb({ cwd: pr.value, scope: 'project', record: true });
      const result = enqueueDreamJob(target.db, target.projectKey, {
        triggered_by: 'mcp_tool',
      });
      return ok({
        operation: 'dream_enqueue',
        result,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  server.tool(TOOL_DEFS[52].name, TOOL_DEFS[52].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const jobId = validateId(args.job_id);
      if (!jobId.ok) return textError(jobId.error);
      const target = openScopeDb({ cwd: pr.value, scope: 'project', record: true });
      const result = await generateProposalsForJob(target.db, target.projectKey, jobId.value, {
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
      });
      return ok({
        operation: 'dream_generate_proposals',
        job_id: jobId.value,
        result,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  server.tool(TOOL_DEFS[53].name, TOOL_DEFS[53].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const jobId = validateId(args.job_id);
      if (!jobId.ok) return textError(jobId.error);
      const target = openScopeDb({ cwd: pr.value, scope: 'project', record: true });
      const result = applyDreamJob(target.db, target.projectKey, jobId.value, {
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
        autoApplyConfidence:
          typeof args.auto_apply_confidence === 'number' ? args.auto_apply_confidence : null,
      });
      return ok({
        operation: 'dream_apply_job',
        job_id: jobId.value,
        result,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

  server.tool(TOOL_DEFS[54].name, TOOL_DEFS[54].input, async (args) => {
    try {
      const pr = resolveProjectRoot(args.cwd);
      if (!pr.ok) return textError(pr.error);
      const jobId = validateId(args.job_id);
      if (!jobId.ok) return textError(jobId.error);
      const target = openScopeDb({ cwd: pr.value, scope: 'project', record: true });
      const result = discardDreamJob(target.db, target.projectKey, jobId.value, {
        reason: args.reason || 'cancelled',
      });
      return ok({
        operation: 'dream_discard_job',
        job_id: jobId.value,
        result,
        project_key: target.projectKey,
      });
    } catch (e) {
      return textError(toError(e).error);
    }
  });

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
