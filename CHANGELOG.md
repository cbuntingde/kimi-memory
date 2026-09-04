# Changelog

All notable changes to `kimi-memory` are recorded here. Versions follow
[Semantic Versioning](https://semver.org/). "Project-only" notes mean
the global DB is not touched; "Breaking" notes mean a stored row from a
prior version is rejected / migrated by the schema upgrade on first open.

## [Unreleased]

### Changed — `detectProjectMetadata` now regex-scans scripts for stack tools

The auto-extracted "Project build/stack details" memory used to label any
Node-only repo (no `packageManager` field, no `typescript` dep) as
`Stack: unknown` — useless for the agent. `src/extract.js` now runs a
regex scan over every script body in `package.json` against a fixed
table of well-known tools:

- Test runners: `node --test` → `node (test runner)`, `jest`, `vitest`,
  `mocha`, `ava`, `tap`
- TypeScript variants: `tsc` → `typescript (compiler)`, `tsx`, `ts-node`
- Bundlers: `vite`, `webpack`, `rollup`, `esbuild`, `parcel`, `turbo`,
  `nx`
- Linters / formatters: `eslint`, `prettier`

A single tag is emitted per tool even when multiple scripts reference it
(`lint`, `lint:fix`, `pretest` can all reference `eslint` without
duplicating the tag in the surfaced memory). Script-invoked tooling
(`npx jest`, `pnpm dlx eslint`) is matched by the same regex — the tool
name appears anywhere in the script body.

The devDependency-based `typescript` tag is preserved alongside the new
`typescript (compiler)` regex tag — they are distinct facts (dep declared
vs. compiler invoked) and may both apply.

### Fixed — `<system-reminder>` blocks no longer leak into durable memory

`extractSummary` (`src/wire.js`) now strips agent-injected
`<system-reminder>...</system-reminder>` blocks from extracted user-prompt
text before storing it in `conversation_events.summary`. The reminder text
is tooling guidance from the host runtime (todo list reminders, hook
results, session reminders); it is not the user's own words and was
silently contaminating focus rows, auto-extract input, and recall hits.

The regex matches both complete blocks (`<system-reminder>...</system-reminder>`)
and unclosed trailing fragments (rare but observed). When the entire
payload was a reminder block, `extractSummary` returns `null` so the
caller treats the row as text-empty. Fix 2's `readSessionUserPrompts`
then drops it via the empty-after-trim filter, and `captureSessionFocus`
reports `no_user_prompt_text` instead of writing a contaminated row.

### Added — `KIMI_MEMORY_AUTO_EXTRACT_GLOBAL` env var documented

The cross-project opt-out flag for the auto-extract dispatcher (Fix 1)
is now documented in the README's Configuration table alongside the
other env vars.

### Added — `memory_promote_to_global` MCP tool

New always-on MCP tool (`src/mcp/handlers/share.js`, registered in
`src/server.js`, defined in `src/mcp/tool-defs.js`). Inputs: `cwd` +
`memory_ids` (1-500 ids). Behaviour: each id is validated, duplicates are
collapsed, and the persist-layer `promoteMemoryToGlobal` runs the move
(see CHANGELOG entry above). The handler defensively re-queries the
global DB after the move and surfaces any row that did not land as a
`skipped` entry with reason `global_write_missing`.

The tool is intentionally separate from `acl_share_memory` (which
targets the deprecated `_shared` pool and is gated behind
`KIMI_MEMORY_LEGACY_SUBSYSTEMS`). `memory_promote_to_global` targets the
always-on `_global` store, never the ACL pool. The slash command
`commands/promote.md` walks through the dry-run + apply flow.

`tests/06-manifest.test.js` and `kimi.plugin.json` longDescription both
bump from 50 → 51 tools to keep the count honest.

### Added — `promoteMemoryToGlobal` persist function + `promote-to-global` CLI/slash command

The new persist-layer function `promoteMemoryToGlobal(db, projectKey, ids, { kimiHomeDir })` (`src/persist/share.js:299-…`) moves one or more rows from the project DB into the cross-project `_global/memory.sqlite` store. The source row is removed; the global row keeps the same id so callers holding the id don't break. The move is a two-phase commit with compensation (writes hit the global DB first, then the source DB deletes; if the source-DB step fails, the global writes are undone).

Defence-in-depth: secret-shape re-scan (`looksLikeSecret`) runs on every candidate before the move. Secret-shaped rows land in the `skipped` list with `reason: 'secret_detected'` rather than being moved; the source row stays in the project DB. Idempotent: re-running with the same ids returns `skipped: [{id, reason: 'not_found'}]` for the rows that already moved.

CLI surface (`src/cli-cmd/promote-to-global.js`, wired into `src/cli.js`): dry run by default, `--apply` to perform the move, `--memory-id` repeatable, `--memory-ids <csv>` shorthand, `--json` output. Slash command at `commands/promote.md`.

### Changed — Auto-extract routes global candidates to the cross-project store

The Stop-hook auto-extract (`src/extract.js:118-…`) previously saved every
candidate to the active project's DB. The dispatcher now branches on a new
optional `scope` field the model emits per candidate:

- `scope: "global"` — user preferences, environment facts, reusable
  procedures. Routes to `$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite`
  and becomes visible from any project.
- `scope: "project"` (default if omitted) — project conventions, current
  state, build/stack facts. Continues to land in the per-project DB.

The classification rule is added to `EXTRACT_SYSTEM_PROMPT`. Parsing
(`parseExtractionResponse`, `src/extract.js:396-…`) accepts the new
optional `scope` field; unknown values fall back to `project` rather than
rejecting the whole batch. Dedup (`dedupeCandidates`,
`src/extract.js:547-…`) walks the per-scope corpus so a "user prefers
dark mode" candidate dedups against the global DB, not the project DB.

Operators who want to freeze the cross-project store without disabling
the per-project pass can set `KIMI_MEMORY_AUTO_EXTRACT_GLOBAL=off`; the
dispatcher reroutes every global candidate to project scope. The result
object gains a `global_saved` count so the hook log records what landed
where.

### Changed — Permissive session-focus: payload fallback + dedicated empty-text skip

`readSessionUserPrompts` (`src/session-focus.js:73-118`) used to drop every
user-role event whose `summary` was null or empty, which silently skipped
sessions where the wire-ingest LLM call had failed or where the user prompt
was a tool-only command with no text body. The new shape:

- SQL no longer filters by `summary != ''`; all user-role rows are read.
- Each row's `prompt` is `summary` first; if summary is empty, the row
  falls back to `extractSummary(JSON.parse(payload))` against the stored
  raw payload — the same extractor `wire.js` uses at ingest time.
- Rows whose final prompt is empty after trim are dropped post-fetch so
  the caller still sees a clean oldest→newest list.

`captureSessionFocus` (`src/session-focus.js`) now splits the old
`below_threshold` skip into two unambiguous reasons:

- `below_threshold` — zero user-role events in the session.
- `no_user_prompt_text` — user events exist but none carry any text body.

Both are visible in the hook diagnostic log (`focus=skip:<reason>`).

### Fixed — Missing imports in `src/hooks/handlers/` broke every hook spawn

Two files in the hook split were missing imports that were always
consumed at runtime, so every hook invocation that reached the
affected call site threw `ReferenceError`. The dispatcher caught
the error and wrote `[kimi-memory] hook <EVENT> failed: <name> is
not defined` to stdout instead of the real handler output, which
failed 10 tests across `tests/04-hooks.test.js`,
`tests/15-hook-stress.test.js`, and `tests/23-session-focus.test.js`.

- `src/hooks/handlers/lib/pipeline.js` — `logHookDiag` (the
  underlying sink the helper `logDiag` writes through) was used on
  line 102 but never imported. Every Stop / SessionEnd / PreCompact
  / Interrupt / StopFailure hook crashed the first time the
  shared `logDiag` was invoked from a deeper handler.
- `src/hooks/handlers/session-start.js` — the import block from
  `./_helpers.js` was missing `readLatestSessionFocus`,
  `buildSessionFocusLine`, `buildSessionThread`, `firstContentLine`,
  `buildWorkingMemoryPreview`, and `buildStaleMemoryLine`, and the
  cross-module imports `runConsolidate` (from `../../consolidate.js`)
  and `buildDreamStatus` (from `../../dream.js`) were absent. Every
  SessionStart hook crashed at the first `runConsolidate` call and
  emitted no stdout, so all of `tests/04-hooks.test.js`'s
  SessionStart assertions and the bounded-preview cases in
  `tests/15-hook-stress.test.js` failed.

After the fix, `npm test` reports 416/416 pass (was 405/416 with
10 failures), and `npx prettier --check .` is clean.

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

### Changed — Recall summary surfaces the candidate-pool denominator

The `UserPromptSubmit` summary line used to read `Recalled N memories.
(N project, N global.) [semantic: …]` with no context for how
representative `N` was. An 8-memory project always returned 8 hits
even when only 1 was relevant, and the user had no way to tell from
the line alone. The line now includes the pool denominator and reads
`Recalled N memories of M.` where `M` is the active-memory count
across project + global.

- `Recalled 1 memory of 1.` (1 global.) — tiny pool, single hit.
- `Recalled 5 memories of 24.` (4 project, 1 global.) [semantic: 2, procedural: 1] — partial-coverage recall.
- `Recalled N memories.` (no `of M`) — fresh install, neither DB exists, so `poolSize === 0` and the denominator is suppressed.
- `No recall hits.` — unchanged.

`src/hooks/handlers/lib/pipeline.js` — `buildRecallSummary` reads the
active count from both DBs via `memoryCounts(...).active` and adds
`of ${poolSize}` to the summary template when `poolSize > 0`.
`tests/04-hooks.test.js` regex updated to accept the optional `of M`
segment; `tests/23-session-focus.test.js` regex was already tolerant.
Skill doc strings updated (`skills/kimi-memory/SKILL.md:72`,
`skills/kimi-memory/references/recall-acknowledgement.md:3,30`).

### Fixed — Recall accuracy: pool-aware cap + score-gap elbow

The recall surface had a hard-coded `RECALL_CANDIDATE_LIMIT = 8` per
DB, so a project with 8 saved memories surfaced 8 hits on every prompt
even when only 1 was actually relevant. Two new tunables in
`src/hooks/handlers/lib/constants.js` make the surface adaptive:

- `RECALL_BASE_LIMIT = 8` — hard ceiling per DB (the previous default).
- `RECALL_MIN_HITS = 3` — floor on the per-DB limit, so a 1-memory project still gets surfaced.
- `RECALL_GAP_FACTOR = 0.4` — score-gap elbow: after per-type selection, drop any hit whose RRF score is below `topScore * 0.4`.

The per-DB limit is now `max(RECALL_MIN_HITS, min(RECALL_BASE_LIMIT, ceil(active / 2)))`, so a 12-memory project caps at 6 hits per DB and a 50-memory project still caps at 8. The cap is the SQL `limit`, so the padding rows are not even read off disk. The gap filter runs after per-type selection so the user keeps a balanced 1-per-type preview; only the padding rows get trimmed.

- `src/hooks/handlers/lib/pipeline.js` — `buildRecallSummary` rewritten with pool-aware cap + score-gap filter.
- `src/hooks/handlers/lib/constants.js` — three new tunables documented with their thresholds.
- `tests/45-recall-gap-filter.test.js` — new file, 6 tests covering constants, pool-aware cap (3, 8, 12, 50 memories), no-DB edge case, and the gap-filter scenario.

Set `KIMI_MEMORY_RECALL_GAP_FACTOR=0` to disable the gap filter
(escape hatch for tests + advanced users who want the pre-filter surface).

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
  unchanged. The split itself was incomplete at the time of writing
  (see the `[Unreleased]` "Missing imports in `src/hooks/handlers/`"
  entry — 10 hook tests were silently failing until the missing
  `logHookDiag` and `_helpers.js` imports were added).
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
