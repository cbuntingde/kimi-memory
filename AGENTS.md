# AGENTS.md

Orientation for agents working in this repository. `README.md` covers
installation and everyday use; `CONTRIBUTING.md` covers the change
workflow; `SECURITY.md` covers the threat model. This file is the
reference for the code layout and the environment variables.

## Code layout

- `src/mcp/` — the MCP surface. `launcher.js` is the stdio entry point,
  `main.js` builds the server, `tool-defs.js` holds every tool
  definition, and `handlers/` holds one registration module per domain,
  wired up with `registerTool(server, D.<name>, …)`.
- `src/server.js` — the server wiring that calls each domain's
  `register()`.
- `src/persist/` — the SQLite layer. `connection.js` owns the schema and
  the `MIGRATIONS` array; `memories.js`, `edges.js`, `share.js`,
  `project.js`, and the rest hold the row-level helpers.
- `src/hooks/run.js` — the hook dispatcher. Per-event logic lives in
  `src/hooks/handlers/`; the top-level `hooks/*.js` files are thin shims
  that set `KM_HOOK_EVENT` and call the dispatcher.
- `src/cli.js` + `src/cli-cmd/` — the standalone CLI.
- `src/proxy/` — the HTTP transport adapter.
- `src/advisor/` — the advisor keyword detector.
- `src/<name>.js` — feature modules (consolidate, dream, dreaming,
  auto-gc, extract, embedding, session-focus, work-log, decay, …).
- `skills/`, `commands/` — the agent-facing skill and slash-command
  docs.
- `tests/NN-<name>.test.js` — number-prefixed so they sort in the order
  they were added.

## Environment variables

This is the authoritative table. The README's `## Configuration` section
covers only the everyday settings; everything the code reads is here.
Unless noted, a value of `off` disables the feature and the default is
`on`.

### Core

| Variable                        | Default        | What it does                                                                                                           |
| ------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `KIMI_CODE_HOME`                | `~/.kimi-code` | Root of Kimi's data folder. Every memory DB and state file lives under `$KIMI_CODE_HOME/kimi-memory/`.                 |
| `KIMI_MEMORY_LEGACY_SUBSYSTEMS` | `on`           | Set to `off` to skip registration of the 15 legacy MCP tools and the tier/persona sweeps. See "Subsystem deprecation". |
| `KIMI_MEMORY_SECRET_SCAN`       | `on`           | Set to `off` to bypass the credential-shape gate on save. Intended for fixture imports only.                           |

### Auto-extract

| Variable                                 | Default         | What it does                                                                                                                          |
| ---------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `KIMI_MEMORY_AUTO_EXTRACT`               | `on`            | Set to `off` to disable the end-of-conversation extraction pass.                                                                      |
| `KIMI_MEMORY_AUTO_EXTRACT_GLOBAL`        | `on`            | Set to `off` to demote every automatically-saved cross-project candidate back to project scope.                                       |
| `KIMI_MEMORY_AUTO_EXTRACT_REQUIRE_HTTPS` | unset           | Set to `1` to refuse cleartext `http://` provider bases and loopback / private / link-local targets before the extract call is built. |
| `KIMI_MEMORY_EXTRACT_MAX_LATENCY_MS`     | `1800000` (30m) | Upper bound on session age before auto-extract is skipped.                                                                            |

### Embeddings

| Variable                       | Default | What it does                                                                         |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------ |
| `KIMI_MEMORY_EMBEDDINGS`       | `on`    | Set to `off` to skip the helper-model download; recall falls back to keyword search. |
| `KIMI_MEMORY_EMBED_TIMEOUT_MS` | `4000`  | Wall-clock cap for one embed call.                                                   |

### Recall

| Variable                        | Default | What it does                                                                                  |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `KIMI_MEMORY_RECALL_BASE_LIMIT` | `8`     | Hard ceiling on recall hits per DB.                                                           |
| `KIMI_MEMORY_RECALL_MIN_HITS`   | `3`     | Floor on the per-DB recall limit, so a tiny pool still surfaces a usable mix.                 |
| `KIMI_MEMORY_RECALL_GAP_FACTOR` | `0.4`   | Drop hits whose RRF score is below `topScore * factor`. Set to `0` to disable the gap filter. |

### Consolidation and cleanup

| Variable                            | Default | What it does                                                                                                                     |
| ----------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `KIMI_MEMORY_CONSOLIDATE`           | `on`    | Set to `off` to skip the in-line merge pass at session start.                                                                    |
| `KIMI_MEMORY_CONSOLIDATE_RELAX`     | `on`    | Gates the small-dataset escape (under 10 active memories, the tag-overlap filter is dropped). `off` restores strict tag-overlap. |
| `KIMI_MEMORY_DEDUP`                 | `on`    | Enables the pair-level dedup paths (title-dedup + near-duplicate cosine). `off` falls back to the clusterer only.                |
| `KIMI_MEMORY_AUTO_MERGE`            | `on`    | Set to `off` to disable the pair-level auto-merge inside the inline consolidate pass.                                            |
| `KIMI_MEMORY_AUTO_GC`               | `on`    | Set to `off` to disable all three auto-GC passes (prune, archive, tier).                                                         |
| `KIMI_MEMORY_AUTO_PRUNE`            | `on`    | Set to `off` to disable auto-prune of dead rows.                                                                                 |
| `KIMI_MEMORY_AUTO_ARCHIVE`          | `on`    | Set to `off` to disable auto-archive of old audit rows.                                                                          |
| `KIMI_MEMORY_AUTO_TIER`             | `on`    | Set to `off` to disable L0 → L3 auto-tier promotion and demotion.                                                                |
| `KIMI_MEMORY_AUTO_RESET_ON_RECLONE` | `on`    | Set to `off` to keep a manual hint instead of auto-wiping when a re-clone is detected.                                           |

### Dream

| Variable                                  | Default         | What it does                                                         |
| ----------------------------------------- | --------------- | -------------------------------------------------------------------- |
| `KIMI_MEMORY_DREAM`                       | `on`            | Set to `off` to disable the staged Dream pipeline (enqueue + apply). |
| `KIMI_MEMORY_DREAM_DEBOUNCE_MS`           | `1800000` (30m) | Minimum gap between Dream runs.                                      |
| `KIMI_MEMORY_DREAM_ACTIVITY_MIN`          | `4`             | New events needed in the window before a job is enqueued.            |
| `KIMI_MEMORY_DREAM_PROPOSAL_CAP`          | `32`            | Hard cap on proposals persisted per job.                             |
| `KIMI_MEMORY_DREAM_AUTO_APPLY_CONFIDENCE` | `0.85`          | Proposals at or above this confidence are auto-applied.              |

### Dreaming

| Variable                           | Default                  | What it does                                                                 |
| ---------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `KIMI_MEMORY_DREAMING`             | unset                    | Set to `off` to make the SessionStart dreaming pass a no-op (`env_opt_out`). |
| `KIMI_MEMORY_DREAMING_MODE`        | from state file (`auto`) | Overrides the dreaming mode (`off` / `auto` / `on`) for the current process. |
| `KIMI_MEMORY_DREAMING_INTERVAL_MS` | from state file          | Overrides the wall-clock floor for the current process.                      |

### Feature toggles

| Variable                            | Default | What it does                                 |
| ----------------------------------- | ------- | -------------------------------------------- |
| `KIMI_MEMORY_DISABLE_SESSION_FOCUS` | unset   | Set to `1` to disable session-focus capture. |
| `KIMI_MEMORY_DISABLE_WORK_LOG`      | unset   | Set to `1` to disable work-log writes.       |

### HTTP proxy

| Variable                          | Default     | What it does                                                                                              |
| --------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| `KIMI_MEMORY_PROXY_HOST`          | `127.0.0.1` | Bind host for the memory proxy. A non-loopback bind enforces the guards below.                            |
| `KIMI_MEMORY_PROXY_TOKEN`         | unset       | Bearer token required on every proxy request.                                                             |
| `KIMI_MEMORY_PROXY_AUTH`          | unset       | `off` (or `0` / `false` / `no`) disables auth; refused on a non-loopback bind.                            |
| `KIMI_MEMORY_PROXY_REQUIRE_HTTPS` | unset       | `1` demands TLS termination for a non-loopback bind; `off` explicitly allows cleartext (not recommended). |
| `KIMI_MEMORY_PROXY_CORS_ORIGINS`  | unset       | Comma-separated CORS origin allowlist.                                                                    |
| `KIMI_MEMORY_PROXY_ALLOW_TOOLS`   | unset       | Comma-separated opt-in for destructive tools on a non-loopback bind.                                      |
| `KIMI_MEMORY_PROXY_DENY_TOOLS`    | unset       | Comma-separated deny-list. Wins over the allow-list.                                                      |

### Internal

These are set by the runtime or the hook shims, not by the user.

| Variable           | Set by                       | What it does                                                                                  |
| ------------------ | ---------------------------- | --------------------------------------------------------------------------------------------- |
| `KIMI_PLUGIN_ROOT` | Kimi, for plugin hooks       | Plugin root directory, used to locate assets. Falls back to the importing module's directory. |
| `KM_HOOK_EVENT`    | the `hooks/*.js` entry shims | Names the lifecycle event the dispatcher is handling.                                         |

## Re-clone auto-reset

When the canonical project root's birthtime is newer than the
`first_seen_at` the plugin stamped on the per-project DB, the project
was re-cloned and the memories on file belong to a previous incarnation
of the repo. `KIMI_MEMORY_AUTO_RESET_ON_RECLONE` (default `on`) decides
what happens at `SessionStart` / `UserPromptSubmit`:

- **on** — `buildStaleMemoryLine` in
  `src/hooks/handlers/lib/pipeline.js` wipes the project's per-row
  tables in one transaction and reports what was deleted. The reset is
  one-shot: `resetProject` moves `first_seen_at` forward, which
  neutralises the detection on the next session.
- **off** — the hook emits the manual `[stale-memory]` hint instead,
  telling the user to call `memory_reset_project`.

Only the per-project DB is touched; the global store and every other
project DB are never affected.

## Subsystem deprecation

Four subsystems ported from `TencentDB-Agent-Memory` — ACL/visibility,
tier/persona, wiki, and codegraph — have no authenticated MCP caller and
no agent-workflow integration. They ship for backward compatibility and
are slated for removal in the next major version.

`KIMI_MEMORY_LEGACY_SUBSYSTEMS` (default `on`) gates them. Set it to
`off` to skip registration of the 15 legacy MCP tools:

- ACL / visibility (5): `acl_grant`, `acl_revoke`, `acl_list`,
  `acl_share_memory`, `acl_resolve_principal`.
- tier / persona (4): `memory_set_tier`, `memory_promote`,
  `memory_demote`, `memory_tier_history`.
- codegraph (6): `codegraph_extract`, `codegraph_build_edges`,
  `codegraph_query_symbol`, `codegraph_impact_path`,
  `codegraph_callers`, `codegraph_callees`.

The wiki group (5 tools) was removed entirely, which is why the gated
count is 15 rather than the 20 the original gate covered.

With the gate off, the auto-tier promotion and `persona_promotions`
archive sweeps in `src/auto-gc.js` are skipped too. The schema columns
and tables stay in place, so flipping the variable back on needs no
migration.

There is no `deprecated` flag on the tool definitions — gating is purely
the environment variable. The 37 always-on tools are catalogued in
`skills/kimi-memory/references/tools.md`.
