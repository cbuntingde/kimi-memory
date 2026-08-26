# Recall acknowledgement contract

When the `UserPromptSubmit` hook reports recall hits, they reach you through `hookSpecificOutput.additionalContext` (the trailing JSON object on stdout). The human-readable `systemMessage` carries the per-type breakdown and counts (`Recalled N memories. (N project, N global.) [semantic: 2, procedural: 1]` or `No recall hits.`) but **not** the per-memory titles — those live in `additionalContext` so the terminal stays clean. The `additionalContext` block looks like:

```text
[kimi-memory recall] 3 memories surfaced — briefly acknowledge what you remember when relevant. If a memory is wrong or stale, say so and we can update it.
1. (semantic, project, score=0.04) "use tabs everywhere" — Use tabs everywhere; never spaces.
2. (procedural, project, score=0.02) "release checklist" — Run `npm test`, then `npm run check`, then…
3. (semantic, global, score=0.02) "user prefers dark mode" — User has dark mode set system-wide.
```

The hook is the single source of truth for what was recalled — trust the `additionalContext` block: if it lists a memory, treat it as recalled, and the user expects you to say so. This is a hard contract, not a guideline.

## Required behaviors

- **Open with a recall acknowledgement when the hook reported hits.** If the `additionalContext` block lists hits, the first sentence of your reply must reference them. Use a fixed phrasing pattern so the acknowledgement is consistent and grep-able:
  - With hits: open with `From your saved notes: <memory title>.` (or `From your saved notes: <title 1>, <title 2>.` for multiple), then continue with the answer.
  - With no hits (the `systemMessage` said `No recall hits.`): open with `No prior notes on this topic.` so the user knows you checked.
  - Do not invent prior context when the hook reported no hits.
- **Acknowledge a `[focus]` line when one is present.** The `Stop` hook writes a `working`-typed memory per session (titled `Last focus: <truncated latest user prompt>`); both `SessionStart` and `UserPromptSubmit` emit a `[focus] "<title>" (working) — <body snippet>` line whenever a focus row exists. This is the agent's signal that the user can say "continue" or "pick that up" and the prior context is already in scope. Open with `Picking up from: <focus title>.` (or paraphrase the body snippet) on the first turn after a session restart, or any time the user explicitly asks "what were we working on" / "where did we leave off". Do not paste the full `content` field back at the user unless they explicitly asked for raw text. The `— <body snippet>` on the focus line is a bounded preview for verification, not raw text to copy.
- **Acknowledge a `[thread]` line when one is present (v9+).** `SessionStart` now emits a small narrative block — the last few sessions in this project, oldest → newest, each with its focus title. Open with `Picking up the thread: <oldest session title>` or, when the thread is empty, just continue. Do not paste the full thread; the per-line titles are enough.
- **Acknowledge a `[tool-recall]` line when one is present (v9+).** When the agent invokes a tool, the `PostToolUse` hook may surface `[tool-recall: i/N] "<title>" — <snippet>` lines if a stored convention matches the tool's arguments. Treat those as in-context hints — they reflect the same memory pool as `additionalContext` but were surfaced mid-turn rather than at prompt submit. Quote them in plain language only when they change your behaviour ("There's a saved note that this file should…"); don't paste them verbatim.
- **Acknowledge a `consolidate=saved:N/skipped:M[/merged:K]` segment on the status line (v9+).** When the SessionStart dream pass synthesises new conclusion rows, the status line carries `consolidate=saved:N/skipped:M`. With auto-merge enabled (default), tight clusters also surface as `consolidate=saved:N/skipped:M/merged:K`. Mention only if the user asked about project structure; otherwise leave the line alone.
- **Name each recalled memory by title, not by id or body.** Titles are user-facing labels; the user can read them in the `additionalContext` block. Bodies are your private evidence. Quote a one-sentence paraphrase of the body when it is useful — never paste the full `content` field back at the user unless they explicitly asked for raw text. The `— <body snippet>` on each recall line is a bounded preview for verification, not raw text to copy.
- **Stay in the recalled types.** The `systemMessage` per-type breakdown (e.g. `[semantic: 2, procedural: 1]`) tells you which memory classes matched. A recall that surfaces only `working`-typed notes is a different signal from one that surfaces `semantic` conventions — call it out: "I have a working note but no convention on this yet." A recall that surfaces only `conclusion` memories means the user already has a higher-order synthesis on file.
- **Refresh recall only when the prompt needs it.** If the `additionalContext` titles (with their body snippets) already cover the question, do not call `memory_recall` again. Pull bodies only when the snippet is not enough. Calls are cheap, but a noisy answer is worse than a focused one.
- **Save the durable artefact when the conversation produces one.** If the user states a preference, decision, or convention during the exchange, call `memory_save` (or `memory_save_bulk` for many) before the reply ends so the next session can recall it. Echo the returned `id` and `scope` so the user can see what was persisted.

A model reply that uses recalled content without acknowledging it is broken: the user will see a hook line in their transcript and no matching reference in the agent's reply, and the trust in the recall mechanism erodes.
