# Changelog

All notable changes to `kimi-memory` are recorded here. Versions follow
[Semantic Versioning](https://semver.org/). "Project-only" notes mean
the global DB is not touched; "Breaking" notes mean a stored row from a
prior version is rejected / migrated by the schema upgrade on first open.

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

Total tool count: **46 → 55**.

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
