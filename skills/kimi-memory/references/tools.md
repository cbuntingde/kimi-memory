# Tools

The plugin exposes 55 MCP tools over the `kimi-memory` stdio server. This is the full catalog. Defaults: durable writes default to `scope: "project"`; durable reads default to `scope: "all"`.

## Durable memory (scope-aware)

- `memory_save(scope, type, ...)` — defaults `scope: "project"`. Accepts `synthesizes: [childId, ...]` for the `conclusion` type.
- `memory_recall(scope, query, ...)` — defaults `scope: "all"` (project hits first, then global). Hybrid FTS5 + cosine; falls back to FTS5 when `KIMI_MEMORY_EMBEDDINGS=off` or the model fails to load.
- `memory_list(scope, ...)` — defaults `scope: "all"`.
- `memory_get(scope, id)` — defaults `scope: "all"` (project first, then global).
- `memory_update(scope, id, ...)` — defaults `scope: "project"` (must be explicit for global).
- `memory_delete(scope, id, hard?)` — defaults `scope: "project"` (must be explicit for global).
- `memory_save_bulk(scope, items)` — defaults `scope: "project"`. Atomic batch save (1–500 items, single transaction, all-or-nothing).
- `memory_status` — returns project durable counts plus a parallel `global.memories` summary.

## Similarity, edges, and synthesis

- `memory_similar(scope, id, limit?, threshold?)` — return memories closest to `id` by embedding cosine. `threshold` is the minimum cosine in `[0, 1]` (default `0.6`).
- `memory_link(scope, from_id, to_id, kind, weight?)` — write a typed edge. `kind` is one of `related | supports | contradicts | supersedes | synthesizes`; `weight` is in `[0, 10]`, default `1.0`.
- `memory_unlink(scope, edge_id)` — remove a previously written edge.
- `memory_edges(scope, id, direction?, kind?)` — return edges where `id` is the source or target.
- `memory_merge(scope, into_id, from_id, merged_content?, weight?)` — soft-supersede one memory into another; the source row is marked `superseded` and a `supersedes` edge is written.
- `memory_reinforce(scope, id)` — bump a memory's `confidence` by `+0.05` and stamp `last_accessed_at = now`.
- `memory_conclusions_for(scope, child_id, limit?)` — list `conclusion`-typed memories that synthesise `child_id`.
- `memory_parents(scope, conclusion_id, limit?)` — list the underlying memories a `conclusion` was built from.

## Working memory (project-only)

- `working_memory_set`, `working_memory_get`, `working_memory_clear`.

## Sessions (project-only)

- `conversation_list`, `conversation_get`, `conversation_search`, `conversation_ingest`.

## Maintenance

- `memory_prune(cwd, scope?, apply?)` — find and optionally delete project DBs whose canonical root no longer exists on disk. `scope` is `"project"` (default — active only) or `"all-projects"`. `apply` defaults to `false` (dry run). The active project is always preserved; the global DB is never touched. Use this after deleting a project to clean up the per-project database, or run `/kimi-memory:prune` for a guided UI flow.
- `memory_reset_project(cwd, confirm?)` — wipe every per-project row (memories, working memory, conversations, conversation events, edges, synthesizes) so the project starts from a clean slate. Use this after a repo is re-cloned to the same canonical path: the project_key is a hash of the path, so kimi-memory cannot otherwise tell the new project apart from the old one. `confirm: false` (default) is a dry run that returns the row counts and a `reclone` diagnostic; pass `confirm: true` to actually delete. The global database and every other project DB are never touched. The hook layer surfaces a `[stale-memory]` line on SessionStart and UserPromptSubmit when a re-clone is detected (directory birthtime newer than `first_seen_at`) — that is the signal to suggest this tool. Run `/kimi-memory:reset_project` for a guided UI flow.
- `memory_diagnostics` — read recent records from the shared hook diagnostics log.

## ACL / visibility (deprecated)

The ACL/visibility layer is a port from `TencentDB-Agent-Memory` and ships without an authenticated caller on the MCP surface (the server itself has no auth; ACL rows are advisory). It is gated behind `KIMI_MEMORY_LEGACY_SUBSYSTEMS=off` (default `on`); set to `off` to hide the five tools and the matching schema migrations from being touched by future cleanup. Removal is planned for the next major version. Until then:

- `acl_grant`, `acl_revoke`, `acl_list`, `acl_share_memory`, `acl_resolve_principal`.

Do not add new code that depends on ACL enforcement from the MCP server.

## Tier / persona (deprecated)

Same deprecation rationale as ACL. The `L0 → L1 → L2 → L3` tier + `persona_id` schema is in place but no persona engine reads it. Gated behind `KIMI_MEMORY_LEGACY_SUBSYSTEMS=off`.

- `memory_set_tier`, `memory_promote`, `memory_demote`, `memory_tier_history`.

## Codegraph (deprecated)

The codegraph tools walk source files and build `imports/calls/defines` edges in `memory_edges`. The plugin does not use them for recall — they are user-callable only. Out of scope for a memory plugin. Gated behind `KIMI_MEMORY_LEGACY_SUBSYSTEMS=off`.

- `codegraph_extract`, `codegraph_build_edges`, `codegraph_query_symbol`, `codegraph_impact_path`, `codegraph_callers`, `codegraph_callees`.

## Dream (staged consolidation)

Phase 1 of the Dream subsystem replaces the inline fire-and-forget dream pass with a durable job pipeline. The job state machine is `queued → running → ready → applied` with terminal branches `stale / failed / cancelled`. A partial unique index enforces one running job per project at the SQL layer.

- `dream_status` — compact `{label, counts}` for the active project.
- `dream_enqueue` — idempotently enqueue a Dream job (no-op if one is queued/ready).
- `dream_generate_proposals` — run clustering inside a single `SAVEPOINT` and write proposal rows.
- `dream_apply_job` — validate + apply every non-stale proposal in one `SAVEPOINT`.
- `dream_discard_job` — mark a `queued / ready` job `cancelled`; reject pending proposals.
- `dream_list_jobs` — paginated list of jobs by status.
- `dream_get_job` — single job by id.
- `dream_list_proposals` — paginated list of proposals by job + status.
- `dream_get_proposal` — single proposal by id.

## Gating legacy subsystems

Set `KIMI_MEMORY_LEGACY_SUBSYSTEMS=off` in the environment to disable every tool in the ACL, tier/persona, codegraph, and (separately gated by `KIMI_MEMORY_DREAM=off`) Dream groups in one switch. The corresponding MCP tool registrations are skipped at boot; the schema tables remain (no data loss) so a user can flip the env var back on without a migration. The wiki group was removed entirely in v14; its tools are no longer registered. See `AGENTS.md §Subsystem deprecation`.
