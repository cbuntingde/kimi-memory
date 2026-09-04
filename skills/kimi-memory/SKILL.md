---
name: kimi-memory
description: Persistent memory for Kimi Code across three layers (global user preferences, project decisions, session archives). Use when the user asks to remember, recall, or persist a fact, preference, decision, or convention. Also use at session start to recall context.
---

# kimi-memory

The kimi-memory plugin gives the Kimi agent a three-layer memory store backed by local SQLite, exposed through MCP tools, and seeded at session start.

The skill follows progressive disclosure: this file covers routing, hygiene, types, and the typical flow. Deeper material lives in `references/`:

- `references/tools.md` — the full MCP tool catalog.
- `references/recall-acknowledgement.md` — how to acknowledge `[recall]`, `[focus]`, `[thread]`, `[tool-recall]` segments on the hook status line.
- `references/active-memory.md` — v9+ behaviour: continuous retrieval, mid-turn recall, decay, cross-session thread, background consolidation, auto-GC.
- `references/decay-contract.md` — the Ebbinghaus decay + reinforcement contract, with the formula and the migration that introduced it.

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

- **Never store secrets** (API keys, tokens, passwords, credentials, `.env` contents, PII). If asked to remember a secret, refuse and explain. The server enforces this too: `memory_save` and `memory_save_bulk` (and `memory_update` / `memory_merge`) run a shape check on `title`, `content`, every `tags` entry, and every string value in `metadata` (recursively), and return a `secret_detected: refusing to persist…` error if any match a known credential shape (OpenAI, Anthropic, GitHub, AWS, JWT, PEM, `key=…` assignments, `Authorization: Bearer` headers). On a bulk save the whole batch is rolled back. The check is bypassed by setting `KIMI_MEMORY_SECRET_SCAN=off` in the server environment — do not do this unless the caller explicitly asks for a secret-shaped fixture.
- **Always pass the project root** (the cwd of the current session) as `cwd` — even for `scope: "global"` writes (it stays as provenance/audit context).
- **Always `memory_recall` (default `scope: "all"`) before `memory_save`** so you don't duplicate. If a recall hit exists, prefer update or `supersede: true`.
- **After a successful `memory_save` / `memory_update` / `memory_delete`**, echo the returned `id` and `scope` so the user can see what was persisted.
- **Use `tags` as a real JSON array** of strings, e.g. `["build", "ci"]`. Never a single string, never a comma-separated value inside a string. The server validates with JSON Schema and returns `/tags must be array` if it is not an actual array.

## Types

| Type         | When                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `working`    | Short, in-flight context. Often the current task or focus. Prefer `working_memory_set` for genuinely transient state.                                                                                                                            |
| `episodic`   | An event that happened ("on 2026-07-27 we migrated X to Y").                                                                                                                                                                                     |
| `semantic`   | A durable fact, definition, or convention.                                                                                                                                                                                                       |
| `procedural` | A procedure ("to release: ...").                                                                                                                                                                                                                 |
| `conclusion` | A higher-order synthesis built from one or more underlying memories. Pass `synthesizes: [childId, ...]` to `memory_save`; the plugin records the lineage in `memory_synthesizes` and exposes it via `memory_conclusions_for` / `memory_parents`. |
| `skill`      | A v10 trigger-matching memory whose `metadata.trigger` shape (`{ commands?, paths?, keywords? }`) is matched against tool invocations by `matchSkillTriggers` (and surfaced by `match_skill_triggers`).                                          |

## Tools

The full catalog (durable memory, similarity + edges, working memory, sessions, ACL/visibility, tier/persona, codegraph, maintenance, dream) lives in `references/tools.md`. Quick reference:

- **Durable memory**: `memory_save`, `memory_recall`, `memory_list`, `memory_get`, `memory_update`, `memory_delete`, `memory_save_bulk`, `memory_status`, `memory_reinforce`, `memory_promote_to_global`.
- **Similarity + edges**: `memory_similar`, `memory_link`, `memory_unlink`, `memory_edges`, `memory_merge`.
- **Working memory**: `working_memory_set`, `working_memory_get`, `working_memory_clear`.
- **Sessions**: `conversation_list`, `conversation_get`, `conversation_search`, `conversation_ingest`.
- **Maintenance**: `memory_prune`, `memory_reset_project`, `memory_diagnostics`.

Defaults: `memory_save` / `memory_update` / `memory_delete` write to `scope: "project"`; `memory_recall` / `memory_list` / `memory_get` read across `scope: "all"` (project first, then global). Pass an explicit `scope` to override.

## Typical flow

1. At `SessionStart` the plugin surfaces a compact status line + a brief summary like `Loaded 2 recent memories. (1 project, 1 global.)` (or `No recent memories.`) plus any working-memory slots. Use the **counts** on the status line to decide what to look at; pull full content via `memory_recall` if needed. If a prior session captured a focus (see `references/recall-acknowledgement.md`), a `[focus] "<title>" (working) — <body snippet>` line is emitted right after the summary — that is the answer to "what were we working on" without any further query.
2. `UserPromptSubmit` emits a single line in its human-readable message: `[kimi-memory] Recalled 3 memories of 24. (2 project, 1 global.) [semantic: 2, procedural: 1]` (or `[kimi-memory] No recall hits.`). The `of M` tail is the candidate-pool denominator (project + global active memories), so the user can see how representative the hits are; it is omitted on fresh installs with no memories on file. Counts and ingest results flow through the dispatcher's diagnostic log, not the chat. The per-memory titles reach the model through `hookSpecificOutput.additionalContext` (a numbered list, `1. (semantic, project, score=0.04) "title" — <body snippet>`). The trailing `— <body snippet>` is the first non-empty line of the memory's body, capped at 120 characters, so you can verify the recall matched what the user expected without depending on the title alone. Pull full bodies via `memory_recall` only when the snippet is not enough. When a session-focus row exists, a …
3. If the user states something durable: call `memory_save` with the right scope. Echo the returned `operation`, `scope`, and `memory.id`.
4. Before answering a recall-style question: `memory_recall` (default `scope: "all"`).
5. When the topic moves on: update or clear the working-memory slot.

### Auto-extract can emit global candidates

The Stop-hook auto-extract (`src/extract.js:118-…`) reads the conversation and asks the configured model for durable facts. Each candidate carries a `type` (`semantic` / `episodic` / `procedural` / `context_snapshot`) plus an optional `scope` field. When the model writes `scope: "global"`, the dispatcher routes that row to `$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite` instead of the project DB. Set `KIMI_MEMORY_AUTO_EXTRACT_GLOBAL=off` to demote every global candidate back to project scope without changing the model's classification. When a global candidate lands, it is visible from any project the next session opens.

### Recall accuracy (v17+)

The hook applies two adaptive filters so recall surfaces the **relevant**
hits, not just the first 8 from each DB:

1. **Pool-aware cap.** Per-DB limit is `min(RECALL_BASE_LIMIT, ceil(active / 2))` with a `RECALL_MIN_HITS` floor. A 12-memory project surfaces at most 6 hits per DB; a 50-memory project still caps at 8. The cap is the SQL `limit`, so padding rows are not even read off disk.
2. **Score-gap elbow.** After per-type selection, any hit whose RRF score is below `topScore * RECALL_GAP_FACTOR` is trimmed. Default 0.4 — a hit at 40% of the top hit's relevance survives, one at 20% is dropped. The gap filter's main value is when embeddings are on (multi-channel RRF produces a real score gap between dominant and noise hits); with keyword-only recall the FTS scores are nearly flat at the top.

Tune via env vars: `KIMI_MEMORY_RECALL_BASE_LIMIT` (default 8), `KIMI_MEMORY_RECALL_MIN_HITS` (default 3), `KIMI_MEMORY_RECALL_GAP_FACTOR` (default 0.4; set to 0 to disable). Constants live in `src/hooks/handlers/lib/constants.js`.

The four signal segments the agent must learn to acknowledge — `[recall]`, `[focus]`, `[thread]`, `[tool-recall]` — are documented in `references/recall-acknowledgement.md`. The v9+ behaviour upgrades (continuous retrieval, mid-turn recall, decay, consolidation, auto-GC) are documented in `references/active-memory.md`.
