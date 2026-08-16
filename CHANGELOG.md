# Changelog

All notable changes to `kimi-memory` are recorded here. Dates are the
release dates; versions follow [Semantic Versioning](https://semver.org/)
(`MAJOR.MINOR.PATCH`).

## Unreleased

Internal follow-ups from the v0.5.1 audit cycle. No surface changes.

- `npm` bootstrap on Windows — `src/mcp/launcher.js` now shells via `npm.cmd`
  so the GitHub install path needs no second manual step.
- Drop the legacy `@v1` embedding suffix from stored vectors.
- `src/lifecycle.js` and `src/performance.js` were removed; their
  responsibilities moved into `src/hooks/run.js` and the per-pass callers.
  Persistence split discussed in the v0.5.1 entry below.

## 0.5.1 — 2026-08-15

Auto-GC + auto-merge + persist split + AI-facing recall context.

### New features

- **`src/auto-gc.js`** — three independent, fail-open passes run on every
  `SessionStart`:
  - `runAutoPrune` — hard-deletes rows that have been in their state past
    the grace window: explicit `deleted` after 30 days; soft-superseded
    after 90 days; embedding-failed after 30 days; cold rows (confidence
    < 0.05, zero accesses) after 365 days; orphans (parent hard-deleted)
    after 7 days.
  - `runAutoArchive` — hard-deletes raw `conversation_events` after 180
    days, `skill_invocations` after 90 days, `persona_promotions` after
    365 days.
  - `runAutoTier` — promotes L0 → L1 at ≥ 3 accesses; L1 → L2 at ≥ 10;
    L2 → L3 at ≥ 5 accesses **and** 30 days at L2. Demotes back to L0
    when confidence falls below 0.2 for ≥ 14 days.
    Tier promotion runs every open; prune + archive are throttled to once
    per 6 hours per project via `schema_meta('auto_gc_last_run')`. Env
    opt-outs: `KIMI_MEMORY_AUTO_GC=off` (master), `KIMI_MEMORY_AUTO_PRUNE=off`,
    `KIMI_MEMORY_AUTO_ARCHIVE=off`, `KIMI_MEMORY_AUTO_TIER=off`. Status
    line gains an `auto_gc=` segment.
- **`runConsolidate` auto-merge** — tight clusters (cosine ≥ 0.85, tag
  overlap ≥ 2, ≥ 3 members) are now `memory_merge`d into the
  highest-confidence member so a recall hit surfaces the synthesis body
  rather than redundant copies. Siblings are soft-superseded, never
  hard-deleted. Opt out via `KIMI_MEMORY_AUTO_MERGE=off`.
- **AI-facing recall context** — `UserPromptSubmit` now writes a trailing
  JSON object on stdout with `systemMessage` (the human-readable lines)
  and `hookSpecificOutput.additionalContext` (a numbered list of recall
  hits the model can acknowledge). The verbose per-memory `[recall: i/N]`
  lines are routed to `additionalContext` only — the terminal stays
  clean.

### Internal refactor

- The 3,400-line `src/persist.js` was split into focused modules under
  `src/persist/`: `connection.js` (schema + `openDb`), `memories.js`
  (CRUD + helpers + synthesis), `search.js` (RRF + recall + backfill),
  `reinforce.js` (reinforce + decay), `edges.js` (typed edges), `share.js`
  (visibility / tier / persona / wiki), `skills.js` (skill triggers +
  invocations), `project.js` (working memory + conversations +
  `project_paths` + reset), `index.js` (barrel). The top-level
  `src/persist.js` is now a 6-line barrel; existing
  `import { … } from './persist.js'` call sites keep working unchanged.
- `src/search.js` (109 lines) holds the FTS5 query helpers
  (`normalizeFts5Query`, `buildTitleBoostedQuery`, `buildOrderByClause`)
  that `persist/search.js` consumes. `src/concurrency.js` (94 lines)
  holds the per-process write-counter used for diagnostics.
- `scripts/check-syntax.js` replaces the hand-maintained `&&`-chained
  `node --check` list in `package.json`. The script walks `src/`,
  `hooks/`, and `tests/`, runs `node --check` on every `.js` file, and
  reports failures file-by-file.

### Tests

- New `tests/33-auto-gc-smoke.test.js` (synthetic DB + the three
  auto-GC passes + the `schema_meta` throttle stamp).
- `tests/04-hooks.test.js` and `tests/13-recall-per-type.test.js`
  updated for the new `hookSpecificOutput.additionalContext` shape.

For the v0.5.0 audit fixes (path-traversal, `redactSecrets`, RRF-vs-O(N²),
`bumpAccess` collapse, etc.) see the commit log; the audit landed in
two commits (`d9ddf33` and `fa8576c`).

## 0.5.0 — 2026-07-30

v10 ACL / tier / wiki / codegraph stack + audit fixes.

### New features

- **ACL / visibility** — every memory carries one of five visibility
  levels (`private`, `team`, `restricted`, `agent`, `task`) plus a
  list of principal descriptors and an explicit grant table. New tools:
  `acl_grant`, `acl_revoke`, `acl_list`, `acl_share_memory`,
  `acl_resolve_principal`. `memory_recall` accepts an optional
  `visibility` filter. `_shared/memory.sqlite` (literal
  `project_key='_shared'`) holds ACL-promoted cross-project rows.
- **Tier / persona** — explicit `L0 → L1 → L2 → L3` promotion with an
  audit log. New tools: `memory_set_tier`, `memory_promote`,
  `memory_demote`, `memory_tier_history`.
- **Wiki / LLM-Wiki** — `[[wiki-name]]` and `[text](wiki:name)` markers
  in memory bodies are resolved to wiki pages with directional links
  (`mentions`, `derived_from`, `contradicts`, `supersedes`). New tools:
  `wiki_upsert_page`, `wiki_get_page`, `wiki_traverse`, `wiki_backlinks`,
  `wiki_resolve`.
- **Codegraph** — local symbol / import / call graph built from a
  project walk, with persisted edges and BFS queries. New tools:
  `codegraph_extract`, `codegraph_build_edges`, `codegraph_query_symbol`,
  `codegraph_impact_path`, `codegraph_callers`, `codegraph_callees`.

### New schema

- `SCHEMA_VERSION` bumped to `10` for ACL/visibility, `11` for the
  `memories_fts` index probe, `12` for the current migration target.
  Migrations are idempotent and backfill defaults on first open.
- New columns: `visibility`, `shared_with`, `team_id`, `agent_id`,
  `user_id`, `session_id`, `task_id`, `tier`, `persona_id`,
  `stability_days`, `last_rehearsed_at`, `last_embed_error`.
- New tables: `memories_acl`, `schema_meta`.

### New env vars

- `KIMI_MEMORY_PROXY_CORS_ORIGINS` — comma-separated origin allowlist
  for the HTTP proxy (default unset; no `Access-Control-Allow-Origin`
  header when unset).
- `KIMI_MEMORY_PERF` — set to `off` to skip the 5k-corpus perf
  benchmarks in `tests/16-perf.test.js`.

### Audit fixes

- Path-traversal hardening on `cwd` / `home` resolution.
- `redactSecrets` extended to cover the `SECRET_PATTERNS` that
  `looksLikeSecret` had silently missed.
- Memory-recall ranking changed from an O(N²) per-side loop to a
  merge-by-rank Reciprocal Rank Fusion (RRF), with `weighted` blend
  preserved as a one-release opt-in for comparison.
- `bumpAccess` collapse — concurrent access updates are coalesced.
- `KIMI_MEMORY_SECRET_DETECTED` thrown by the lowest layer so every
  write path inherits the check.

## 0.4.0 — 2026-07-20

v9 brain modes — session focus, Ebbinghaus decay, dream consolidation,
mid-turn recall.

### New features

- **Continuous retrieval** — every `UserPromptSubmit` recall query
  unions prompt tokens, working-memory slots, the session-focus title,
  and recent file paths. The top 3 hits are round-robined across memory
  types so the user sees a balanced recall.
- **Mid-turn recall** — `PostToolUse` surfaces `[tool-recall]` lines
  when a stored convention matches the tool's arguments. No LLM call.
- **Ebbinghaus decay** — every memory carries a per-row `stability_days`
  and `last_rehearsed_at`. Confidence is rewritten on `SessionStart`
  from `0.1 + 0.9 * exp(-days / stability)`. `memory_reinforce` grows
  stability by 1.5x (cap 365 days) and stamps a fresh rehearsal.
- **Cross-session narrative** — `SessionStart` lists the last 3 sessions
  for the project, oldest → newest.
- **Background consolidation ("dream pass")** — related memories
  (cosine ≥ 0.75, ≥ 2 shared tags) are clustered; each cluster of
  ≥ 3 siblings without a `conclusion` child gets one synthesised.
  Idempotent via `memory_synthesizes` coverage check.

## 0.3.0 — 2026-07-10

Auto-extraction + cost guards + secret detector.

- Stop-hook auto-extract with `looksLikeSecret` safety net.
- `redactSecrets` scrub on the auto-extract transcript before it leaves
  the machine.
- Embedding timeout (`KIMI_MEMORY_EMBED_TIMEOUT_MS`, default 4 s) with
  `last_embed_error` recorded on the row.

## 0.2.0 — 2026-06-15

Working memory + session archive + standalone CLI.

- `working_memory_set/get/clear` (project-only, composite PK).
- `conversation_list/get/search/ingest` over `wire.jsonl` with byte and
  line cursors.
- `kimi-memory` CLI: `list`, `get`, `status`, `recall`, `prune`,
  `reset-project`, `export`, `import`.

## 0.1.0 — 2026-05-01

Initial release.

- Three-layer SQLite memory (global, project, working).
- FTS5 keyword search.
- Local persistence under `$KIMI_CODE_HOME/kimi-memory/`.
- Lifecycle hooks for `SessionStart`, `UserPromptSubmit`, `Stop`,
  `SessionEnd`.
