---
name: dreaming
description: >
  Configure and run the dreaming subsystem that consolidates, combines,
  and prunes memories on a wall-clock floor. Invoke when the user asks
  to turn dreaming on/off, change how often it runs, run a one-shot
  dreaming pass, or check when dreaming last fired. Defaults: mode=auto,
  interval=30m for auto / 24h for on, include set is
  consolidate,dream,gc. Fail-open; never deletes memories without the
  user's go-ahead (the gc pass is non-destructive soft-supersede).
license: MIT
---

# /kimi-memory:dreaming

Configure the dreaming subsystem — the background pass that consolidates
memories into conclusions, combines duplicates, and prunes stale rows on a
schedule. The user-facing verb covers the three existing internal passes
(consolidate + dream + auto-GC) so they share one schedule and one
status surface.

## Modes

- `off` — never auto-run. Only fires on explicit `/dreaming run`.
- `auto` — the historical behaviour: activity-threshold + 30-minute debounce
  (env-tunable via `KIMI_MEMORY_DREAM_DEBOUNCE_MS`). Switching to `auto` is
  a no-op upgrade for existing users.
- `on` — wall-clock floor regardless of session activity. Default
  interval `24h`, overridable via `--interval`. A `SessionStart` that opens
  after the floor has elapsed runs the pass immediately. There is no
  background daemon — the plugin never wakes itself up. If the user
  never opens Kimi, dreaming never runs. That trade-off is intentional.

## Usage

```text
/kimi-memory:dreaming on                       # turn on, default 24h interval
/kimi-memory:dreaming on --interval 3h         # 3-hour floor
/kimi-memory:dreaming off                      # never auto-run
/kimi-memory:dreaming auto                     # default behaviour (alias for the historical debounce path)

/kimi-memory:dreaming run                      # one-shot, force a pass now
/kimi-memory:dreaming run --include consolidate,dream
/kimi-memory:dreaming run --exclude gc         # skip the prune/archive/tier pass

/kimi-memory:dreaming status                   # mode + interval + last run + next due
/kimi-memory:dreaming last                     # last run's saved/merged/pruned counts
```

Add `--scope project|global` to `on|off|auto|status` to write the mode to
the per-project file or to the system-wide default. Per-project wins over
global when both exist.

## What this does

One call runs three passes in order, controlled by `--include`:

1. **consolidate** (`runConsolidate`) — clusters memories by embedding
   cosine + tag overlap, writes `conclusion` rows, records `synthesizes`
   edges, and merges tight duplicates. Writes one
   `consolidation_runs` row at the end.
2. **dream** (`enqueueDreamJob` → `generateProposalsForJob` → `applyDreamJob`) —
   durable staged job lifecycle in `dream_jobs` + `dream_proposals`. One
   enqueue per call; one apply if a job is ready. Honours the partial
   unique index `idx_dream_jobs_active` so two concurrent enqueues are
   safe.
3. **gc** (`runAutoGc`) — prune dead rows (deleted >30d, superseded >90d,
   embed-failed >30d, cold low-confidence >365d), archive old audit
   rows, run L0→L1→L2→L3 tier promotion. Bounded by `KIMI_MEMORY_AUTO_GC=off`.

The default include set is `consolidate,dream,gc`. Auto-extract is NOT
included by default — it makes an outbound LLM call. Add it with
`/dreaming run --include consolidate,dream,gc,extract` (or set
`KIMI_MEMORY_AUTO_EXTRACT=on` and let the Stop hook fire it on its own
schedule).

## Procedure

For `on|off|auto|status|last`:

1. Call `dreaming_status({cwd})` MCP tool (or `node src/cli.js dreaming
status --cwd <path>`). The tool returns the effective state — mode,
   interval, include set, last run timestamp, next due time, and which
   file (project vs global) is the source.

2. For state transitions (`on|off|auto`), call `dreaming_set({cwd, scope,
mode, interval_ms, include})`. Per-project by default; pass
   `scope: 'global'` to set the system-wide default.
   `KIMI_MEMORY_DREAMING_MODE` and `KIMI_MEMORY_DREAMING_INTERVAL_MS`
   env vars override the file for the current process.

3. Print the resulting `dreaming_status` so the user sees what landed.

For `run`:

1. Call `dreaming_run({cwd, include: [...], exclude: [...]})`. The
   `force` flag is implicit; the interval floor does not apply. The
   include list, when supplied, replaces the configured include set for
   this call only.
2. Print the result: which passes fired, their counts, and the next
   due time.

For `last`:

1. Call `dreaming_status({cwd})` and print the `last_run` block.

## When not to use

- Do not invoke `run` while a `dream_*` job is already running for the
  project — `idx_dream_jobs_active` makes the second enqueue a no-op
  duplicate. Check `memory_status` or `dream_status` first.
- Do not set `interval` to less than 5 minutes. Consolidate re-walks the
  embedding matrix; dream re-stages proposals. A busy interval will
  thrash the DB and the auto-tire sweep. The CLI refuses intervals
  shorter than 5m.
- `on` mode is not a daemon. The plugin never spawns a background
  process; dreaming only runs when a `SessionStart` opens after the
  floor has elapsed (or when the user invokes `run`). Tell the user
  this is by design — the alternative is a separate persistent
  scheduler process that the harness doesn't currently support.

## State file layout

Per-project:

```
$KIMI_CODE_HOME/kimi-memory/<project>/dreaming.json
```

Global default:

```
$KIMI_CODE_HOME/kimi-memory/_config/dreaming.json
```

Both files have shape:

```json
{
  "mode": "on",
  "intervalMs": 86400000,
  "include": ["consolidate", "dream", "gc"],
  "last_run": {
    "at": "2026-08-30T01:23:45.678Z",
    "duration_ms": 4321,
    "force": false,
    "passes": { "consolidate": {...}, "dream": {...}, "gc": {...} }
  }
}
```

Atomic write via `tmp + rename`. A crash mid-write leaves the previous
state intact.

## Related

- `memory_status` — pair with `dreaming_status` when the user asks
  "is anything stale?" — that question means "should I run dreaming?"
- `dream_*` MCP tools — the lower-level durable job surface. `dreaming`
  composes these but does not replace them.
- `auto_gc`, `consolidate`, `dream` env opt-outs (`KIMI_MEMORY_AUTO_GC=off`,
  `KIMI_MEMORY_CONSOLIDATE=off`, `KIMI_MEMORY_DREAM=off`) — each pass
  honours its own opt-out independently, so `off` mode is equivalent to
  setting all three on a session-scoped basis.
