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

- Never store secrets (API keys, tokens, passwords, credentials, `.env` contents, PII). If asked to remember a secret, refuse and explain. The server enforces this too: `memory_save` and `memory_save_bulk` (and `memory_update` / `memory_merge`) run a shape check on title and content and return a `secret_detected: refusing to persist…` error if either matches a known credential shape (OpenAI, Anthropic, GitHub, AWS, JWT, PEM, `key=…` assignments, `Authorization: Bearer` headers). On a bulk save the whole batch is rolled back. The check is bypassed by setting `KIMI_MEMORY_SECRET_SCAN=off` in the server environment — do not do this unless the caller explicitly asks for a secret-shaped fixture.
- Always pass the project root (the cwd of the current session) as `cwd` — even for `scope: "global"` writes (it stays as provenance/audit context).
- Always `memory_recall` (default `scope: "all"`) **before** `memory_save` so you don't duplicate. If a recall hit exists, prefer update or `supersede: true`.
- After a successful `memory_save` / `memory_update` / `memory_delete`, echo the returned `id` and `scope` so the user can see what was persisted.
- Use `tags` to make recall precise. `tags` MUST be a real JSON array of strings, e.g. `["build", "ci"]`. Never a single string, never a comma-separated value inside a string. The server validates with JSON Schema (`type: "array"`, `items: { type: "string" }`) and returns `/tags must be array` if it is not an actual array. If a call fails with that error, re-read the call and fix the parameter — do not blindly retry.

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

Maintenance (re-clone reset):

- `memory_reset_project(cwd, confirm?)` — wipe every per-project row (memories, working memory, conversations, conversation events, edges, synthesizes) so the project starts from a clean slate. Use this after a repo is re-cloned to the same canonical path: the project_key is a hash of the path, so kimi-memory cannot otherwise tell the new project apart from the old one. `confirm: false` (default) is a dry run that returns the row counts and a `reclone` diagnostic; pass `confirm: true` to actually delete. The global database and every other project DB are never touched. The hook layer surfaces a `[stale-memory]` line on SessionStart and UserPromptSubmit when a re-clone is detected (directory birthtime newer than `first_seen_at`) — that is the signal to suggest this tool. Run `/kimi-memory:reset_project` for a guided UI flow.

## Typical flow

1. At `SessionStart` the plugin surfaces a compact status line + a brief summary like `Loaded 2 recent memories. (1 project, 1 global.)` (or `No recent memories.`) plus any working-memory slots. Use the **counts** on the status line to decide what to look at; pull full content via `memory_recall` if needed. If a prior session captured a focus (see "Memory recall and acknowledgement" below), a `[focus] "<title>" (working) — <body snippet>` line is emitted right after the summary — that is the answer to "what were we working on" without any further query.
2. `UserPromptSubmit` emits the same status line plus a recall summary that names the types of memories that matched (e.g. `Recalled 3 memories. (2 project, 1 global.) [semantic: 2, procedural: 1]`) and up to three `[recall: i/N] "title" (type, scope, score=…) — <body snippet>` lines so the user can see exactly which memories surfaced. The trailing `— <body snippet>` is the first non-empty line of the memory's body, capped at 120 characters, so the user can verify the recall matched what they expected without depending on the title alone. Pull full bodies via `memory_recall` only when the snippet is not enough. When a session-focus row exists, a `[focus] "<title>" (working) — <body snippet>` line follows the recall lines (always — not gated on keyword match).
3. If the user states something durable: call `memory_save` with the right scope. Echo the returned `operation`, `scope`, and `memory.id`.
4. Before answering a recall-style question: `memory_recall` (default `scope: "all"`).
5. When the topic moves on: update or clear the working-memory slot.

The hooks deliberately do **not** echo full memory bodies, raw prompts, or session transcripts on stdout. They surface counts, type breakdowns, and bounded per-memory lines (title + a one-line body snippet) so the user can verify the recall matched, without flooding the chat.

## Memory recall and acknowledgement

When the `UserPromptSubmit` hook emits `[recall: i/N]` lines, the user can see them in the hook status (the same lines you see in your context). The user wants the agent to acknowledge what it remembered in plain language, not just use the content silently. The hook is the single source of truth for what was recalled — trust the `[recall: i/N]` lines: if the hook says a memory was recalled, treat it as recalled, and the user expects you to say so. This is a hard contract, not a guideline.

- **Open with a recall acknowledgement when the hook reported hits.** If the hook printed `[recall: …]` lines, the first sentence of your reply must reference them. Use a fixed phrasing pattern so the acknowledgement is consistent and grep-able:
  - With hits: open with `From your saved notes: <memory title>.` (or `From your saved notes: <title 1>, <title 2>.` for multiple), then continue with the answer.
  - With no hits (hook printed `No recall hits.`): open with `No prior notes on this topic.` so the user knows you checked.
  - Do not invent prior context when the hook reported no hits.
- **Acknowledge a `[focus]` line when one is present.** The `Stop` hook writes a `working`-typed memory per session (titled `Last focus: <truncated latest user prompt>`); both `SessionStart` and `UserPromptSubmit` emit a `[focus] "<title>" (working) — <body snippet>` line whenever a focus row exists. This is the agent's signal that the user can say "continue" or "pick that up" and the prior context is already in scope. Open with `Picking up from: <focus title>.` (or paraphrase the body snippet) on the first turn after a session restart, or any time the user explicitly asks "what were we working on" / "where did we leave off". Do not paste the full `content` field back at the user unless they explicitly asked for raw text. The `— <body snippet>` on the focus line is a bounded preview for verification, not raw text to copy.
- **Acknowledge a `[thread]` line when one is present (v9+).** `SessionStart` now emits a small narrative block — the last few sessions in this project, oldest → newest, each with its focus title. Open with `Picking up the thread: <oldest session title>` or, when the thread is empty, just continue. Do not paste the full thread; the per-line titles are enough.
- **Acknowledge a `[tool-recall]` line when one is present (v9+).** When the agent invokes a tool, the `PostToolUse` hook may surface `[tool-recall: i/N] "<title>" — <snippet>` lines if a stored convention matches the tool's arguments. Treat those as in-context hints — they reflect the same memory pool as `[recall: i/N]` but were surfaced mid-turn rather than at prompt submit. Quote them in plain language only when they change your behaviour ("There's a saved note that this file should…"); don't paste them verbatim.
- **Acknowledge a `consolidate=saved:N` segment on the status line (v9+).** When the SessionStart dream pass synthesises new conclusion rows, the status line carries `consolidate=saved:N/skipped:M`. Mention only if the user asked about project structure; otherwise leave the line alone.
- **Name each recalled memory by title, not by id or body.** Titles are user-facing labels; the user can read them on the hook line. Bodies are your private evidence. Quote a one-sentence paraphrase of the body when it is useful — never paste the full `content` field back at the user unless they explicitly asked for raw text. The `— <body snippet>` on each recall line is a bounded preview for verification, not raw text to copy.
- **Stay in the recalled types.** The hook's per-type breakdown (e.g. `[semantic: 2, procedural: 1]`) tells you which memory classes matched. A recall that surfaces only `working`-typed notes is a different signal from one that surfaces `semantic` conventions — call it out: "I have a working note but no convention on this yet." A recall that surfaces only `conclusion` memories means the user already has a higher-order synthesis on file.
- **Refresh recall only when the prompt needs it.** If the hook's titles (with their body snippets) already cover the question, do not call `memory_recall` again. Pull bodies only when the snippet is not enough. Calls are cheap, but a noisy answer is worse than a focused one.
- **Save the durable artefact when the conversation produces one.** If the user states a preference, decision, or convention during the exchange, call `memory_save` (or `memory_save_bulk` for many) before the reply ends so the next session can recall it. Echo the returned `id` and `scope` so the user can see what was persisted.

A model reply that uses recalled content without acknowledging it is broken: the user will see a hook line in their transcript and no matching reference in the agent's reply, and the trust in the recall mechanism erodes.

## Memory is active, not filed (v9+)

`kimi-memory` v9 turns the plugin from a recallable filing cabinet into something closer to a working brain. Four behavioural upgrades are wired into the hook layer; you should treat them as part of how you already use memory, not as a separate feature.

### Continuous retrieval — every prompt pulls from four cues

The `UserPromptSubmit` recall query is no longer just prompt tokens. It now unions:

1. The user's prompt tokens (legacy behaviour).
2. Working-memory slot values — what you currently treat as "live."
3. The session-focus row's title — what we were just doing.
4. Recent file paths from `conversation_events` of kind `tool_call` — what files we touched.

Recall is also **diversified**: the top 3 hits are round-robined across memory types so the user doesn't see three rows of `semantic` and miss a stored `procedural`. Use the `[recall: i/N]` lines as before; if the diversified list surfaces a type you didn't ask about, that's the system telling you "you have a note about this from a different angle."

### Mid-turn recall — PostToolUse

When you invoke a tool (read, edit, shell), the `PostToolUse` hook surfaces up to two `[tool-recall]` lines for any stored memory that matches the tool's arguments. The match is cheap — file-path stems and shell verbs, no LLM — so it runs on every tool call without measurable cost. Treat these as in-context hints: they don't change what you decided to do, but they let you cite a stored convention ("per my note on run.js, no stdout echoing…") instead of inventing the rule.

If a Kimi version doesn't declare the `PostToolUse` event, the hook is silently skipped. The plugin degrades to v8 behaviour — recall only fires at `UserPromptSubmit`.

### Real forgetting — Ebbinghaus decay

Each memory now carries a `stability_days` and a `last_rehearsed_at` timestamp. The decay pass rewrites `confidence` from the curve `0.1 + 0.9 * exp(-days_since_rehearsal / stability)`. Each `memory_reinforce` call (which the hook fires automatically on the top hit of every recall) grows stability by 1.5x and stamps a fresh rehearsal. A memory that's consistently recalled stays hot for months; one that's untouched decays toward the floor in ~1 stability cycle.

You do not need to call `memory_reinforce` manually after a recall hit — the hook does it. Just keep using `memory_recall` normally; the feedback loop is built in.

### Cross-session narrative — `[thread]` on SessionStart

`SessionStart` now lists the last 3 sessions for the project, oldest → newest, with each session's focus title and body snippet. This is the agent's "where in the project timeline are we?" signal. Use it when the user opens a session cold: a one-line "Picking up the thread: <oldest session>" is enough.

### Background consolidation — `[conclusion]` synthesised automatically

A no-LLM "dream pass" runs on every `SessionStart`: it clusters active memories by embedding cosine (≥0.75) AND tag overlap (≥2 shared tags), and for each cluster of ≥3 siblings with no existing `conclusion` child, writes one new `conclusion`-typed memory that links them via `memory_synthesizes` and `memory_edges` (kind=synthesizes). Idempotent: re-running on a project with existing conclusions is a no-op.

This fills the gap that `conclusion` typing existed for but was never created automatically. When you see `consolidate=saved:N/skipped:M` on the status line, that's the system creating higher-order syntheses for you. Use them like any other conclusion: `memory_conclusions_for(child_id)` returns the synthesis, `memory_parents(conclusion_id)` returns the underlying memories.

Disable via `KIMI_MEMORY_CONSOLIDATE=off` (matches the auto-extract opt-out pattern).

## Decay and reinforcement contract

| Operation                   | Effect                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `memory_save` (new row)     | `stability_days = 30`, `last_rehearsed_at = now`.                                    |
| `memory_save` (update)      | `last_rehearsed_at = now` (fresh rehearsal on touch).                                |
| `memory_reinforce`          | `+0.05 confidence`, `stability_days *= 1.5` (capped 365), `last_rehearsed_at = now`. |
| `memory_recall` (hook auto) | Top project hit auto-reinforced, debounced within 60s.                               |
| `SessionStart` decay pass   | Each row's `confidence` rewritten from `0.1 + 0.9 * exp(-t/s)`.                      |
| `PostToolUse` recall        | Tool-call hits are surfaced but **not** reinforced (tool calls are too frequent).    |

Schema is `SCHEMA_VERSION = 10`; migrations add `stability_days` and `last_rehearsed_at` to existing rows on first open, then the v10 phase layers on visibility/ACL, tier/persona, wiki, codegraph, and the `skill` type extension.
