# Active memory (v9+)

`kimi-memory` v9 turns the plugin from a recallable filing cabinet into something closer to a working brain. Four behavioural upgrades are wired into the hook layer; you should treat them as part of how you already use memory, not as a separate feature.

## Continuous retrieval — every prompt pulls from four cues

The `UserPromptSubmit` recall query is no longer just prompt tokens. It now unions:

1. The user's prompt tokens (legacy behaviour).
2. Working-memory slot values — what you currently treat as "live."
3. The session-focus row's title — what we were just doing.
4. Recent file paths from `conversation_events` of kind `tool_call` — what files we touched.

Recall is also **diversified**: the top 3 hits are round-robined across memory types so the user doesn't see three rows of `semantic` and miss a stored `procedural`. Use the `[recall: i/N]` lines as before; if the diversified list surfaces a type you didn't ask about, that's the system telling you "you have a note about this from a different angle."

## Mid-turn recall — PostToolUse

When you invoke a tool (read, edit, shell), the `PostToolUse` hook surfaces up to two `[tool-recall]` lines for any stored memory that matches the tool's arguments. The match is cheap — file-path stems and shell verbs, no LLM — so it runs on every tool call without measurable cost. Treat these as in-context hints: they don't change what you decided to do, but they let you cite a stored convention ("per my note on run.js, no stdout echoing…") instead of inventing the rule.

If a Kimi version doesn't declare the `PostToolUse` event, the hook is silently skipped. The plugin degrades to v8 behaviour — recall only fires at `UserPromptSubmit`.

## Real forgetting — Ebbinghaus decay

Each memory now carries a `stability_days` and a `last_rehearsed_at` timestamp. The decay pass rewrites `confidence` from the curve `0.1 + 0.9 * exp(-days_since_rehearsal / stability)`. Each `memory_reinforce` call (which the hook fires automatically on the top hit of every recall) grows stability by 1.5x and stamps a fresh rehearsal. A memory that's consistently recalled stays hot for months; one that's untouched decays toward the floor in ~1 stability cycle.

You do not need to call `memory_reinforce` manually after a recall hit — the hook does it. Just keep using `memory_recall` normally; the feedback loop is built in.

See `references/decay-contract.md` for the full formula, the cap, and the migration that introduced the columns.

## Cross-session narrative — `[thread]` on SessionStart

`SessionStart` now lists the last 3 sessions for the project, oldest → newest, with each session's focus title and body snippet. This is the agent's "where in the project timeline are we?" signal. Use it when the user opens a session cold: a one-line "Picking up the thread: <oldest session>" is enough.

## Background consolidation — `[conclusion]` synthesised automatically

A no-LLM "dream pass" runs on every `SessionStart`: it clusters active memories by embedding cosine (≥0.75) AND tag overlap (≥2 shared tags), and for each cluster of ≥3 siblings with no existing `conclusion` child, writes one new `conclusion`-typed memory that links them via `memory_synthesizes` and `memory_edges` (kind=synthesizes). Idempotent: re-running on a project with existing conclusions is a no-op.

This fills the gap that `conclusion` typing existed for but was never created automatically. When you see `consolidate=saved:N/skipped:M` on the status line, that's the system creating higher-order syntheses for you. Use them like any other conclusion: `memory_conclusions_for(child_id)` returns the synthesis, `memory_parents(conclusion_id)` returns the underlying memories.

Tight clusters (cosine ≥ 0.85, tag overlap ≥ 2, ≥ 3 members) are also **auto-merged**: each sibling is folded into the highest-confidence member via `memory_merge`, so a recall hit surfaces the synthesis body rather than a stack of redundant siblings. Siblings are soft-superseded (never hard-deleted); un-merge by walking the `merged_from` provenance chain. The status line surfaces the count as `consolidate=saved:N/skipped:M/merged:K`.

Disable consolidation via `KIMI_MEMORY_CONSOLIDATE=off` (matches the auto-extract opt-out pattern); disable just the merge step via `KIMI_MEMORY_AUTO_MERGE=off` if you want syntheses without collapsing siblings.

The Dream subsystem ships a durable job pipeline (`dream_status`, `dream_enqueue`, `dream_generate_proposals`, `dream_apply_job`, `dream_discard_job`, `dream_list_jobs`, `dream_get_job`, `dream_list_proposals`, `dream_get_proposal`) on top of the inline pass. Disable the whole pipeline with `KIMI_MEMORY_DREAM=off`; existing `dream_jobs` rows stay queryable.

## Background housekeeping — auto-GC

Three independent, fail-open passes run on every `SessionStart` to keep each project DB bounded: `runAutoPrune` (hard-deletes explicit `deleted` rows after 30 days, soft-superseded after 90 days, embedding-failed after 30 days, cold rows after 365 days, orphans after 7 days), `runAutoArchive` (drops raw `conversation_events` after 180 days, `skill_invocations` after 90 days, `persona_promotions` after 365 days), and `runAutoTier` (L0→L1 at ≥ 3 accesses; L1→L2 at ≥ 10; L2→L3 at ≥ 5 accesses AND 30 days at L2; demotes back to L0 when confidence falls below 0.2 for ≥ 14 days). Tier promotion runs every open; prune + archive are throttled to once per 6 hours per project via `schema_meta(auto_gc_last_run)`. The status line carries the segment as `auto_gc=tier:prom:N/dem:M` (tier only) or `auto_gc=prune:N/archive:M/tier:prom:N/dem:M` (heavy passes ran), or `auto_gc=tier:prom:N/dem:M/heavy:throttled` (heavy passes skipped this open). Errors surface as `auto_gc=err:<message>`.

The agent does not need to act on this — it's housekeeping the user opted into by installing the plugin. Mention only if the user explicitly asks "is my database growing?" or "what is the auto-GC doing?"; otherwise leave the line alone. Disable with `KIMI_MEMORY_AUTO_GC=off` (master) or any of `KIMI_MEMORY_AUTO_PRUNE=off` / `KIMI_MEMORY_AUTO_ARCHIVE=off` / `KIMI_MEMORY_AUTO_TIER=off` for granular control.
