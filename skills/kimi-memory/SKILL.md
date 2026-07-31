---
name: kimi-memory
description: Persistent memory for Kimi Code across three layers (global user preferences, project decisions, session archives). Use when the user asks to remember, recall, or persist a fact, preference, decision, or convention. Also use at session start to recall context.
---

# kimi-memory

The kimi-memory plugin gives the Kimi agent a three-layer memory store backed by local SQLite, exposed through MCP tools, and seeded at session start.

## Layer routing rules

Pick the right scope for every fact you save or recall:

| Layer                  | Scope                                         | When                                                                                                                                                               |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Global user memory     | `scope: "global"`                             | Cross-project preferences, profile facts, reusable procedures (e.g. "user prefers dark mode", "use `pnpm` globally", "how to onboard the agent on a new machine"). |
| Project durable memory | `scope: "project"` (default)                  | Repository-specific facts, decisions, conventions, workflows for the active project.                                                                               |
| Project working memory | `working_memory_set/get/clear` (project-only) | Transient current focus, in-flight tasks, recent decisions you want surfaced next turn.                                                                            |
| Session archive        | `conversation_*` tools (project-only)         | Automatic full per-session transcript; no manual reads unless the user asks.                                                                                       |

## When to act

- The user states a durable preference about themselves or their environment → **global** memory.
- The user states a durable fact, decision, or convention about the project → **project** memory (default).
- The user asks "do you remember ...", "what did we decide about ...", "earlier we said ..." → `memory_recall` (default `scope: "all"` so you also see global hits).
- The user wants to see what is on file → `memory_list` (default `scope: "all"` shows project+global; pass `scope: "project"` or `scope: "global"` to filter).
- A project convention changed and the old one must be marked → `memory_save(..., supersede: true)`. The plugin marks the prior row `superseded` (pointing `superseded_by` at the new row) and stamps the new row's `supersedes` field back at it. With no prior row, the flag is a no-op and the new memory stays `active`.
- A topic is current → write a working-memory slot with `working_memory_set` so next recall surfaces it.
- Importing many facts at once → `memory_save_bulk(scope, items[])`. Use the same scope rules as `memory_save`. Per-item validation runs up-front; any error rolls back the whole batch.

## Hygiene rules

- Never store secrets (API keys, tokens, passwords, credentials, `.env` contents, PII). If asked to remember a secret, refuse and explain.
- Always pass the project root (the cwd of the current session) as `cwd` — even for `scope: "global"` writes (it stays as provenance/audit context).
- Always `memory_recall` (default `scope: "all"`) **before** `memory_save` so you don't duplicate. If a recall hit exists, prefer update or `supersede: true`.
- After a successful `memory_save` / `memory_update` / `memory_delete`, echo the returned `id` and `scope` so the user can see what was persisted.
- Use `tags` to make recall precise (e.g. `["build", "ci"]`).

## Types

| Type         | When                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `working`    | Short, in-flight context. Often the current task or focus. Prefer `working_memory_set` for genuinely transient state.                                                                                                                            |
| `episodic`   | An event that happened ("on 2026-07-27 we migrated X to Y").                                                                                                                                                                                     |
| `semantic`   | A durable fact, definition, or convention.                                                                                                                                                                                                       |
| `procedural` | A procedure ("to release: ...").                                                                                                                                                                                                                 |
| `conclusion` | A higher-order synthesis built from one or more underlying memories. Pass `synthesizes: [childId, ...]` to `memory_save`; the plugin records the lineage in `memory_synthesizes` and exposes it via `memory_conclusions_for` / `memory_parents`. |

## Tools

Durable memory (scope-aware):

- `memory_save(scope, type, ...)` — defaults `scope: "project"`. Accepts `synthesizes: [childId, ...]` for the `conclusion` type.
- `memory_recall(scope, query, ...)` — defaults `scope: "all"` (project hits first, then global). Hybrid FTS5 + cosine; falls back to FTS5 when `KIMI_MEMORY_EMBEDDINGS=off` or the model fails to load.
- `memory_list(scope, ...)` — defaults `scope: "all"`.
- `memory_get(scope, id)` — defaults `scope: "all"` (project first, then global).
- `memory_update(scope, id, ...)` — defaults `scope: "project"` (must be explicit for global).
- `memory_delete(scope, id, hard?)` — defaults `scope: "project"` (must be explicit for global).
- `memory_save_bulk(scope, items)` — defaults `scope: "project"`. Atomic batch save (1–500 items, single transaction, all-or-nothing).

Similarity, edges, and synthesis:

- `memory_similar(scope, id, limit?, threshold?)` — return memories closest to `id` by embedding cosine. `threshold` is the minimum cosine in `[0, 1]` (default `0.6`).
- `memory_link(scope, from_id, to_id, kind, weight?)` — write a typed edge. `kind` is one of `related | supports | contradicts | supersedes | synthesizes`; `weight` is in `[0, 10]`, default `1.0`.
- `memory_unlink(scope, edge_id)` — remove a previously written edge.
- `memory_edges(scope, id, direction?, kind?)` — return edges where `id` is the source or target.
- `memory_merge(scope, into_id, from_id, merged_content?, weight?)` — soft-supersede one memory into another; the source row is marked `superseded` and a `supersedes` edge is written.
- `memory_reinforce(scope, id)` — bump a memory's `confidence` by `+0.05` and stamp `last_accessed_at = now`.
- `memory_conclusions_for(scope, child_id, limit?)` — list `conclusion`-typed memories that synthesise `child_id`.
- `memory_parents(scope, conclusion_id, limit?)` — list the underlying memories a `conclusion` was built from.

Working memory (project-only):

- `working_memory_set`, `working_memory_get`, `working_memory_clear`.

Sessions (project-only):

- `conversation_list`, `conversation_get`, `conversation_search`, `conversation_ingest`.

Aggregate:

- `memory_status` — returns project durable counts plus a parallel `global.memories` summary.

Maintenance (orphan-project cleanup):

- `memory_prune(cwd, scope?, apply?)` — find and optionally delete project DBs whose canonical root no longer exists on disk. `scope` is `"project"` (default — active only) or `"all-projects"`. `apply` defaults to `false` (dry run). The active project is always preserved; the global DB is never touched. Use this after deleting a project to clean up the per-project database, or run `/kimi-memory:prune` for a guided UI flow.

## Typical flow

1. At `SessionStart` the plugin surfaces a compact status line + a brief summary like `Loaded 2 recent memories. (1 project, 1 global.)` (or `No recent memories.`) plus working-memory slots. Use the **counts** on the status line to decide what to look at; pull full content via `memory_recall` if needed.
2. `UserPromptSubmit` emits the same status line plus a brief recall summary like `Recalled 1 memory. (1 global.)` (or `No recall hits.`). If the summary indicates hits, call `memory_recall` to read the bodies.
3. If the user states something durable: call `memory_save` with the right scope. Echo the returned `operation`, `scope`, and `memory.id`.
4. Before answering a recall-style question: `memory_recall` (default `scope: "all"`).
5. When the topic moves on: update or clear the working-memory slot.

The hooks deliberately do **not** echo memory bodies, raw prompts, or session transcripts on stdout. They surface counts and brief summaries only so the chat stays uncluttered.
