# Changelog

All notable changes to `kimi-memory` are recorded here. Versions follow
[Semantic Versioning](https://semver.org/). "Project-only" notes mean
the global DB is not touched; "Breaking" notes mean a stored row from a
prior version is rejected / migrated by the schema upgrade on first open.

## [Unreleased]

### Fixed — UserPromptSubmit hook output is now a single line

The hook's human-readable `<hook_result>` message used to lead every
prompt with three lines of metadata the user did not ask for:

```
[kimi-memory] event=UserPromptSubmit project_key=ffef2a61… pmem.active=5 gmem.active=0 wm=0 conv=3 events=682 ingest=ok:7 extract=saved:2/dup:0 work_log=updated focus=saved dream=applied:1 recall project:5 global:0 cwd=…
Recalled 5 memories. (5 project.)  [working: 2, episodic: 1, procedural: 1, semantic: 1]
[focus] "Last focus: <system-reminder> The previous turn was interrupted…" (working) — Most recent user requests in this session (oldest → newest):
```

It is now exactly one line:

```
[kimi-memory] Recalled 5 memories. (5 project.)  [working: 2, episodic: 1, procedural: 1, semantic: 1]
```

Counts, ingest results, and the verbose status line are still produced
internally — they now flow through the dispatcher's diagnostic log
(`$KIMI_CODE_HOME/kimi-memory/_diagnostics/hooks.log`) instead of stdout,
so they remain greppable for debugging without cluttering the chat. The
per-memory recall hits and the `[focus]` line both still reach the model
through `hookSpecificOutput.additionalContext`, so the agent can still
open with "Picking up from: …" or "From your saved notes: …" — the user
just no longer sees any of that metadata inline.

- `src/hooks/handlers/user-prompt-submit.js` — message is now exactly
  `[kimi-memory] <recall.summary>`. The status line, focus line, WM
  preview, stale-memory line, and advisor line all moved to the
  diagnostic log; the focus line is also appended to `additionalContext`
  so the agent still sees it.
- `tests/04-hooks.test.js` — asserts the message is the single
  `[kimi-memory] <recall summary>` line, no newline, no verbose fields.
- `tests/23-session-focus.test.js` — focus line is now asserted inside
  `additionalContext`, not the chat-facing message.
- `skills/kimi-memory/SKILL.md`,
  `skills/kimi-memory/references/recall-acknowledgement.md` — updated
  to describe the new minimal output format.

### Fixed — UserPromptSubmit hook stdout

The hook was emitting both a plain-text block (`emitLines(...)`) AND a
trailing JSON envelope on stdout. Kimi's hook runner
(`packages/agent-core/src/session/hooks/runner.ts`) only recognises the
top-level JSON field `message` — the previous `systemMessage` field is
a Codex/Claude Code convention Kimi does not parse. Because no `message`
was present, Kimi fell back to dumping the raw stdout verbatim, which
included the entire JSON envelope, producing a doubled, noisy
`<hook_result>` block in the user's chat.

- `src/hooks/handlers/user-prompt-submit.js` — stdout is now a single
  JSON envelope with `message` (Kimi's protocol field name) carrying the
  human-readable lines and `hookSpecificOutput.additionalContext`
  carrying the per-memory recall list. The plain-text `emitLines`
  duplicate is gone.
- `tests/04-hooks.test.js`, `tests/13-recall-per-type.test.js`,
  `tests/23-session-focus.test.js` — updated to parse the new `message`
  field.
- `skills/kimi-memory/references/recall-acknowledgement.md` — corrected
  the field-name reference (`message`, not `systemMessage`).

### Added — Subsystem deprecation gate

Four subsystems shipped in v0.5.0 (ACL/visibility, tier/persona, wiki,
codegraph) are deprecated: they are ported from `TencentDB-Agent-Memory`
but have no authenticated MCP caller and no agent-workflow integration.
A new `KIMI_MEMORY_LEGACY_SUBSYSTEMS` env var hides the 20 corresponding
MCP tools (ACL: 5, tier: 4, wiki: 5, codegraph: 6) and skips the
auto-tier promotion + `persona_promotions` archive sweeps when set to
`off`. The schema columns + tables remain in place so flipping the env
var back on requires no migration. Removal is planned for the next
major version.

- `src/server.js` — the 20 legacy tool registrations are now wrapped in
  `if (process.env.KIMI_MEMORY_LEGACY_SUBSYSTEMS !== 'off') { ... }`.
- `src/auto-gc.js` — `runAutoTier` and the `persona_promotions`
  archive in `runAutoArchive` honour the same gate.
- `README.md`, `AGENTS.md`, `skills/kimi-memory/references/tools.md`
  document the new env var.
- `kimi.plugin.json` `interface.longDescription` now lists the 20
  deprecated tools with a `[deprecated]` marker.

### Added — Hook split

`src/hooks/run.js` (1,772 lines, 8 events) is split into a slim
dispatcher plus per-event modules under `src/hooks/handlers/`:

```
src/hooks/run.js                          # dispatcher (~95 lines)
src/hooks/handlers/_helpers.js            # shared utils + lifecycle helpers
src/hooks/handlers/session-start.js
src/hooks/handlers/user-prompt-submit.js
src/hooks/handlers/stop.js                # Stop + SessionEnd + PreCompact + Interrupt + StopFailure + autoExtract
src/hooks/handlers/post-tool-use.js
```

The public helper exports (`buildRecallQuery`, `diversifyHitsByType`,
`readRecentFilePaths`, `buildSessionThread`, `formatConsolidateSegment`)
are re-exported from `run.js` for backward compatibility with any
consumer that previously imported them from the dispatcher.

### Added — Progressive disclosure for the `kimi-memory` skill

`skills/kimi-memory/SKILL.md` was 25 KB (one monolithic file). It is
now a ~10 KB routing/hygiene/types/flow file with deeper material in
four reference files:

- `skills/kimi-memory/references/tools.md` — full MCP tool catalog.
- `skills/kimi-memory/references/recall-acknowledgement.md` — how to
  acknowledge `[recall]`, `[focus]`, `[thread]`, `[tool-recall]`
  segments on the hook status line.
- `skills/kimi-memory/references/active-memory.md` — v9+ behaviour:
  continuous retrieval, mid-turn recall, decay, cross-session thread,
  background consolidation, auto-GC.
- `skills/kimi-memory/references/decay-contract.md` — the Ebbinghaus
  decay formula and the migration that introduced the columns.

`kimi.plugin.json`'s `skillInstructions` is trimmed to match.

### Added — Project docs

`AGENTS.md`, `SECURITY.md`, and `CONTRIBUTING.md` now live at the
repository root. They were missing in v0.6.0.

### Compatibility notes

- `KIMI_MEMORY_LEGACY_SUBSYSTEMS` defaults to `on` — the 20 legacy
  tools remain registered by default, so existing automation that
  calls them keeps working. Opt-out is explicit (`=off`).
- The hook split is internal: handler function names + behaviour are
  unchanged. No new tests required; all 41 existing test files pass
  on the split.
- The skill split is byte-equivalent for content; only the layout
  changed. References are loaded on demand by the agent.

## [0.6.0] — 2026-08-19

### Added — Staged Dream consolidation (Phase 1)

Phase 1 of the Dream subsystem replaces the inline, fire-and-forget
"dream pass" with a durable, operator-controlled job pipeline.

- New module `src/dream.js` (826 lines) owns the Dream job state
  machine: `queued → running → ready → applied` with
  `stale / failed / cancelled` terminal branches.
- A partial unique index (`idx_dream_jobs_active`) enforces
  "one running job per project" at the SQL layer, so concurrent
  enqueues are a no-op rather than a crash.
- Schema migration adds two tables:
  `dream_jobs(project_key, status, enqueued_at, ...)` and
  `dream_proposals(job_id, source_memory_ids, conclusion_kind, ...)`.
- Apply path runs every proposed write inside a single `SAVEPOINT`
  so a mid-flight crash leaves the project DB untouched. Each
  proposal is re-validated against the live rows
  (`status='active'`, source `checksum` unchanged, ids intact);
  drifted sources are marked `stale` and skipped.
- Hook layer (`src/hooks/run.js`) enqueues a Dream job from
  `Stop` and `SessionEnd` once the activity threshold + debounce
  window both allow. `SessionStart` opportunistically drives one
  ready → applied cycle inside its 8s budget.
- Project scope only — no global-memory Dream surface in Phase 1.
  The global store stays curated by the user via MCP / `memory_save`.

### Added — 9 new MCP tools

| Tool                       | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `dream_status`             | Compact `{label, counts}` for the active project.                   |
| `dream_enqueue`            | Idempotently enqueue a Dream job (no-op if one is queued/ready).    |
| `dream_generate_proposals` | Run clustering inside a single `SAVEPOINT` and write proposal rows. |
| `dream_apply_job`          | Validate + apply every non-stale proposal in one `SAVEPOINT`.       |
| `dream_discard_job`        | Mark a `queued / ready` job `cancelled`; reject pending proposals.  |
| `dream_list_jobs`          | Paginated list of jobs by status.                                   |
| `dream_get_job`            | Single job by id.                                                   |
| `dream_list_proposals`     | Paginated list of proposals by job + status.                        |
| `dream_get_proposal`       | Single proposal by id.                                              |

Total tool count: **46 → 55**, then **55 → 50** when the wiki subgroup
was retired in the next major (the deprecated ACL / tier / codegraph
tools remain for backward compat, gated behind
`KIMI_MEMORY_LEGACY_SUBSYSTEMS=off`).

### Added — env-var / hook opt-outs

| Variable            | Default | Effect                                                                     |
| ------------------- | ------- | -------------------------------------------------------------------------- |
| `KIMI_MEMORY_DREAM` | `on`    | `off` skips both `Stop/SessionEnd` enqueue and `dream_generate_proposals`. |

### Tests

- `tests/39-dream.test.js` (583 lines, 12 cases) covers schema
  migration idempotency, per-project isolation, idempotent enqueue,
  proposal-mode non-mutation, apply path with concurrent drift
  detection, stale-source skip, discard, status shape, debounce
  tracking, source-checksum stability, legacy `runConsolidate`
  compatibility, env opt-out, and crash recovery.
- `tests/40-audit-fixes-batch2.test.js` (8 cases) pins the
  `safeErrorMessage` path-redaction audit fixes so the
  prettier reformat of `src/util.js` cannot silently regress.

### Docs / house-keeping

- README rewritten: now lists 55 tools and the new Dream row;
  env-vars table covers `KIMI_MEMORY_DREAM`.
- `kimi.plugin.json` tool count + Dream tool names added to the
  `longDescription`.
- Doc-only files removed: `ARCHITECTURE.md`, `CHANGELOG.md`
  (this file replaces it), `CONTRIBUTING.md`, `CONVENTIONS.md`,
  `IMPROVEMENTS.md`, `PROJECT.md`, `shipgate-report.md`, and the
  per-module `MODULE_BRIEF.md` files.
- New research note: `research/claude-dreams-idle-consolidation-2026-08-18.md`.

### Compatibility notes

- Users on `0.5.1` upgrading in place: the schema migration is
  additive (only adds `dream_*` tables), so existing project +
  global DBs open cleanly. No data migration required.
- Users who had set `KIMI_MEMORY_CONSOLIDATE=off` to disable the
  inline dream pass now have a second knob
  (`KIMI_MEMORY_DREAM=off`) for the staged pipeline. The two are
  independent — leaving `KIMI_MEMORY_DREAM=on` will still create
  Dream jobs even when `KIMI_MEMORY_CONSOLIDATE=off`.

## [0.5.1] — 2026-08-16

### Fixed — audit-cycle cleanup

- `src/lifecycle.js` removed; responsibilities moved into
  `src/hooks/run.js`.
- `src/performance.js` removed; responsibilities moved into
  per-pass callers.
- 21-comprehensive-improvements.test.js trimmed: redundant cases
  moved to the focused `tests/37-share-move-metadata.test.js` and
  `tests/38-audit-fixes-coverage.test.js` files.

## [0.5.0] — 2026-08-10

### Added — Phase-v10 stack

- ACL + visibility layer (`acl_grant`, `acl_revoke`, `acl_list`,
  `acl_share_memory`, `acl_resolve_principal`).
- Tier + persona layer (`memory_set_tier`, `memory_promote`,
  `memory_demote`, `memory_tier_history`).
- LLM-Wiki (`wiki_upsert_page`, `wiki_get_page`, `wiki_traverse`,
  `wiki_backlinks`, `wiki_resolve`).
- Codegraph (`codegraph_extract`, `codegraph_build_edges`,
  `codegraph_query_symbol`, `codegraph_impact_path`,
  `codegraph_callers`, `codegraph_callees`).
- Ebbinghaus decay + reinforcement on recall hits.
- Background consolidation + auto-merge on tight clusters.

See `git log` for the full pre-0.5.0 history.
