# Decay and reinforcement contract

The v9 Ebbinghaus-style decay replaces the legacy "scale confidence by elapsed days past a 30-day grace" rule. The new shape treats every memory as having a personal stability window; unused memories lose confidence; recalled memories grow more stable.

## Schema

Two columns added to `memories` by the v9 migration:

- `stability_days REAL NOT NULL DEFAULT 30` — per-row "how long this memory survives without rehearsal." Grows geometrically on every access (`memory_reinforce`, recall hit). Capped at 365 days.
- `last_rehearsed_at TEXT` — last time the memory was actually used. Distinct from `last_accessed_at` (which already tracks every read); rehearsal is what re-stabilises the memory for future decay. Backfilled from `updated_at` on the v9 migration so pre-existing rows have a sensible starting point.

## Formula

```
confidence(t) = 0.1 + 0.9 * exp(-days_since_rehearsal / stability_days)
```

`0.1` is the floor — a memory never falls below 10% confidence, no matter how long it sits unused. The exponential decay tail is what differentiates "memory just rehearsed" (confidence ≈ 1.0) from "memory untouched for a full stability window" (confidence ≈ 0.4).

## Reinforcement contract

| Operation                   | Effect                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `memory_save` (new row)     | `stability_days = 30`, `last_rehearsed_at = now`.                                    |
| `memory_save` (update)      | `last_rehearsed_at = now` (fresh rehearsal on touch).                                |
| `memory_reinforce`          | `+0.05 confidence`, `stability_days *= 1.5` (capped 365), `last_rehearsed_at = now`. |
| `memory_recall` (hook auto) | Top project hit auto-reinforced, debounced within 60s.                               |
| `SessionStart` decay pass   | Each row's `confidence` rewritten from `0.1 + 0.9 * exp(-t/s)`.                      |
| `PostToolUse` recall        | Tool-call hits are surfaced but **not** reinforced (tool calls are too frequent).    |

## Why a debounce on recall reinforcement

The hook debounces reinforcement to within 60 seconds so re-typing the same prompt (or the model repeating the same query internally) doesn't hammer the DB with identical writes. The debounce key is `(project_key, memory_id)`; only the first recall within the window touches the row. See `src/persist/reinforce.js#reinforceIfStale`.

## Migration

`SCHEMA_VERSION = 9` introduced the columns. `SCHEMA_VERSION = 10` then layered on visibility/ACL, tier/persona, wiki, codegraph, and the `skill` type extension. The full migration list lives in `src/persist/connection.js`.
