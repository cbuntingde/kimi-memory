# Project Memory for Kimi Code

<p align="center">
  <img src="assets/demo-list-calls.png" alt="Kimi assistant running memory_list" width="48%" />
  <img src="assets/demo-list-output.png" alt="Memory list and summary output" width="48%" />
</p>

A local Kimi Code plugin that provides three-layer memory — cross-project user memory, per-project durable + working memory, and per-project session archives — through MCP tools and lifecycle hooks.

## Layered model

| Layer                            | Path                                                      | Read default                          | Write default                | Lifetime                           |
| -------------------------------- | --------------------------------------------------------- | ------------------------------------- | ---------------------------- | ---------------------------------- |
| Global user memory               | `$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite`       | `scope: "all"` (merged) or `"global"` | `scope: "global"` (explicit) | Permanent; agent-curated.          |
| Project durable + working memory | `$KIMI_CODE_HOME/kimi-memory/<project-key>/memory.sqlite` | `scope: "project"` or `"all"`         | `scope: "project"` (default) | Permanent; agent-curated.          |
| Project session archive          | same path; `conversations` + `conversation_events`        | project-only, no scope                | automatic (hook-driven)      | Idempotent ingest of `wire.jsonl`. |

`<project-key>` is a SHA-256 prefix of the canonical project root. The global DB uses the literal `project_key = "_global"` so per-project queries never accidentally hit it.

## Requirements

- Kimi Code with plugin, hook, Skill, and MCP support
- Node.js ≥ 24 (`node:sqlite`; no native build required)

## Install

### From GitHub

In the Kimi Code chat input:

```text
/plugins install https://github.com/cbuntingde/kimi-memory
```

Kimi pulls the source into `$KIMI_CODE_HOME/plugins/managed/kimi-memory/`. On
its first MCP start, the plugin bootstraps the runtime dependencies from
`package-lock.json` with `npm ci`; no second manual install is required. The
plugin is not on the Kimi marketplace, so a trust prompt appears (default
**Cancel**); choose the affirmative option. Then run `/reload` and verify with
`/plugins info kimi-memory` — no diagnostic block means a clean install.

### From a local checkout

```bash
cd <path-to-this-repo>
npm install
```

Then from the Kimi chat input:

```text
/plugins install <absolute-path-to-this-repo>
/reload
```

Local sources are copied into the managed plugin directory; edits to this checkout do not propagate. Reinstall (and `/reload`) after meaningful changes. If the plugin is already installed, skip the install slash and just `/reload` after dependency changes — re-installing a healthy install copies the source again for no benefit.

## Use

- `/list_memories` — calls `memory_list` with `scope: "all"`.
- `/kimi-memory:list_memories` — namespaced fallback.
- `/kimi-memory:advisor` — reflection procedure over the active project (anchored recommendations, no remote calls). Also triggered by phrases like "would we change anything"; the auto-detect hook emits `[advisor] matched: ...`.
- `/kimi-memory:prune` — orphan-project DB cleanup (dry-run by default; `--apply` to delete).
- `/kimi-memory:memos` — open the companion `kimi-memos-dashboard` in the default browser (read-only view of every kimi-memory SQLite DB; the dashboard is a separate plugin the user starts).
- Natural language ("list memories", "remember this decision", "what did we decide?") invokes the same MCP tools when the Skill matches.

Every MCP call requires the active project's absolute root as `cwd` to prevent cross-project writes and supply provenance context.

## Environment variables

All optional; defaults are tuned for production.

| Variable                       | Default | Effect                                                                                                                                               |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KIMI_MEMORY_EMBEDDINGS`       | `on`    | Set to `off` to skip the embedding encoder. `memory_recall` falls back to FTS5-only; `memory_similar` returns `[]`.                                  |
| `KIMI_MEMORY_EMBED_TIMEOUT_MS` | `4000`  | Wall-clock cap on a single embedding call; on timeout the row's `embedding_status` flips to `failed` with `last_embed_error = "embed_timeout: ..."`. |
| `KIMI_MEMORY_AUTO_EXTRACT`     | `on`    | Set to `off` to disable the Stop-hook auto-extraction LLM call. Also configurable as `[kimi-memory] disable_auto_extract = true` in `config.toml`.   |
| `KIMI_MEMORY_SECRET_SCAN`      | `on`    | Set to `off` to bypass the server-side secret check on save (see Storage and privacy).                                                               |
| `KIMI_MEMORY_PERF`             | `on`    | Set to `off` to skip the `tests/16-perf.test.js` benchmarks.                                                                                         |

## Memory tools

The plugin exposes 24 MCP tools over the `kimi-memory` stdio server.

**Durable memory** (scope-aware; defaults shown):

- `memory_save(scope?, type, ...)` — `scope: "project"`. Accepts `synthesizes: [childId, ...]` for `conclusion` type to record lineage.
- `memory_recall(scope?, query, ...)` — `scope: "all"` (project first, then global). Hybrid FTS5 keyword + cosine over stored embeddings; falls back to FTS5-only when embeddings are off.
- `memory_list(scope?, ...)`, `memory_get(scope?, id)` — both default `scope: "all"`.
- `memory_update(scope?, id, ...)` — `scope: "project"`.
- `memory_delete(scope?, id, hard?)` — `scope: "project"`. Soft by default; `hard: true` removes the row permanently.
- `memory_save_bulk(scope?, items)` — `scope: "project"`. Atomic batch save (1–500 items, single transaction); rolls back on any error. A later item with `supersede: true` can replace an earlier one sharing the same `(type, title)`.

**Similarity, edges, and synthesis** (scope-aware; defaults shown):

- `memory_similar(scope?, id, limit?, threshold?)` — closest to `id` by cosine. `threshold` ∈ [0, 1] (default 0.6); `limit` defaults to 10. Returns `[]` when the seed has no embedding. `scope: "all"`.
- `memory_link(scope?, from_id, to_id, kind, weight?)` — typed edge. `kind` ∈ `related | supports | contradicts | supersedes | synthesizes`; `weight` ∈ [0, 10], default 1.0.
- `memory_unlink(scope?, edge_id)`.
- `memory_edges(scope?, id, direction?, kind?)` — `direction`: `out | in | both` (default `both`); `kind` optional filter.
- `memory_merge(scope?, into_id, from_id, merged_content?, weight?)` — soft-supersede `from_id` into `into_id`; tag union plus `provenance.merge_from`; writes a `supersedes` edge `from_id → into_id`. Pass `merged_content` to overwrite `into_id`'s body; otherwise it is kept.
- `memory_reinforce(scope?, id)` — bump `confidence` by +0.05, stamp `last_accessed_at = now`. Idempotent.

**Working memory** (project-only):

- `working_memory_set`, `working_memory_get`, `working_memory_clear`

**Session archive** (project-only):

- `conversation_list`, `conversation_get`, `conversation_search`, `conversation_ingest`

**Higher-order** (project-aware reads; `conclusions_for`/`parents` accept `scope: "all"`):

- `memory_conclusions_for(scope?, child_id, limit?)` — conclusions synthesized from `child_id`.
- `memory_parents(scope?, conclusion_id, limit?)` — underlying memories for a conclusion.

**Combined summary**:

- `memory_status` — project + global durable-memory counts in one call.

**Maintenance**:

- `memory_prune(cwd, scope?, apply?)` — find (or, with `apply: true`, delete) project DBs whose canonical root no longer exists. `scope`: `"project"` (default, active only) or `"all-projects"` (every DB except active). Always dry-runs first. Active project and global DB are never removed.

Successful memory operations return explicit metadata (`operation`, `scope`, counts, affected `id`).

### Scope and types

- **`scope: "all"` ordering**: results are sorted most-recent-first within each scope, then concatenated — every project row appears before every global row. A newer global row cannot outrank a stale project row.
- **Types**: `working` (active scratch), `episodic` (timestamped events), `semantic` (durable facts/decisions/rules), `procedural` (repeatable workflows), `conclusion` (synthesis over child memories; lineage recorded in `memory_synthesizes`).
- **Supersede**: `memory_save` / `memory_save_bulk` with `supersede: true` mark prior `(type, title)` rows as `superseded` and stamp `supersedes` on the new row. No-op when no prior row exists.

### Standalone CLI

Same surface without the MCP server, via the `kimi-memory` bin entry:

```bash
kimi-memory list    [--cwd <path>] [--scope project|global|all] [--type <type>] [--limit N] [--json] [-q]
kimi-memory get     <memory-id> [--scope project|global] [--cwd <path>] [--json]
kimi-memory status  [--cwd <path>] [--json]
kimi-memory recall  <query> [--cwd <path>] [--limit N] [--per-type] [--json]
kimi-memory prune   [--cwd <path>] [--all-projects] [--apply] [--json]
```

`--json` emits machine-readable JSON; `-q` suppresses per-row output; `--home <dir>` overrides `$KIMI_CODE_HOME`. The CLI never writes — `prune --apply` is the only mutating command.

## Higher-level features

### Vector similarity search

The `memories` table carries an optional 384-dim `embedding` (`BLOB`, float32). Every `memory_save`, `memory_recall`, `memory_save_bulk`, and `memory_merge` computes and stores an embedding by default; `memory_recall` runs FTS5 and cosine in parallel and merges the two ranked lists. The model is `Xenova/all-MiniLM-L6-v2` (~25 MB), fetched lazily from Hugging Face and cached locally. Set `KIMI_MEMORY_EMBEDDINGS=off` to skip embedding entirely; `memory_similar` returns `[]` and `memory_recall` falls back to FTS5-only. Encoding is wall-clock bounded at 4 s (`KIMI_MEMORY_EMBED_TIMEOUT_MS`); on timeout the row's `embedding_status` flips to `failed` and `last_embed_error` records the cause. The next call rides the in-flight load if it eventually lands.

### Edges

Edges (`memory_edges` table) are written by `memory_save(..., supersede: true)`, `memory_link(...)`, and `memory_merge(...)`. Listed via `memory_edges(scope, id, direction?, kind?)`; removed via `memory_unlink(scope, edge_id)`.

### Auto-extraction

The `Stop` hook (and `SessionEnd`, `PreCompact`, `Interrupt`, `StopFailure` that delegate to it) runs an idempotent auto-extract pass: reads the last six conversation summaries, asks the configured provider for up to three candidate memories, and saves the survivors through `memory_save` with `provenance.source = "auto_extract"` (visible on the dashboard as a purple `src-auto_extract` chip).

Cost guards: skips when there are fewer than 6 events, when the latest event is older than 5 minutes, when the same `(type, title)` already exists, when the candidate looks like a transient task or is already covered by a recall hit, or when it contains a likely secret.

One short LLM call per Stop event to the model configured in `$KIMI_CODE_HOME/config.toml`. Disable via `KIMI_MEMORY_AUTO_EXTRACT=off` or `[kimi-memory] disable_auto_extract = true` in `config.toml`. The agent should still verify an auto-extracted batch before treating it as canon.

### Importance and decay

Every memory has `confidence` (default 0.8, range 0.1–1.0) and `access_count` / `last_accessed_at`. A background pass runs at every `SessionStart`:

- Rows newer than 30 days, or accessed within 30 days, are untouched.
- Older untouched rows decay 5% per 30 days, floored at 0.1. Decay uses `COALESCE(last_accessed_at, updated_at)`.

`memory_reinforce` is the manual nudge (see Durable memory); recall hits that the agent actually reads are good candidates.

### Higher-order `conclusion` type

Save with `memory_save({ type: "conclusion", synthesizes: [childId, ...] })`. Lineage is recorded in `memory_synthesizes` and queryable in both directions via `memory_conclusions_for` and `memory_parents`. Conclusions decay like any other row, but their child rows stay fresh while the conclusion is active — reinforce the conclusion itself.

## Conversation archival

Hooks run at `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`, `PreCompact`, `Interrupt`, and `StopFailure`. They incrementally read the current session's `agents/main/wire.jsonl`, preserve every raw JSONL event, and extract searchable summaries. Imports use byte and line cursors and are idempotent. Kimi does not document full conversation text in hook payloads, so archival reads the transcript files directly without modifying them; the parser is tolerant of unknown/malformed records.

`SessionStart` and `UserPromptSubmit` emit a structured status line plus a short summary line. The status line reports project key, active/global memory counts, working-slot count, conversations, conversation events, ingest status, and (for `UserPromptSubmit`) project/global recall hit counts:

```text
[kimi-memory] event=UserPromptSubmit project_key=59e809561f923b9f pmem.active=0 gmem.active=1 wm=0 conv=3 events=354 ingest=ok:2 recall project:0 global:0 cwd=...
```

Summary lines are intentionally short:

- SessionStart: `Loaded N recent memories. (N project, N global.)` or `No recent memories.`
- UserPromptSubmit: `Recalled N memory/memories. (N project, N global.) [semantic: 2, procedural: 1]` (per-type breakdown appended when there are hits) or `No recall hits.`

`UserPromptSubmit` is followed by up to three `[recall: i/N] "title" (type, scope, score=…) — <body snippet>` lines (snippet capped at 120 chars). Working-memory slots are emitted as `- WM <slot>: <value>` lines. The remaining hooks are silent on stdout and run only the idempotent project-session ingest; they are fail-open and never block Kimi's lifecycle. The hooks never echo full memory bodies, raw prompts, or session transcripts.

An advisor match line appears on `UserPromptSubmit` when the prompt contains a frozen keyword:

```text
[advisor] matched: "would we change" — /advisor or ask naturally; skill `advisor` is loaded
```

The frozen list lives in `src/advisor/detect.js`; a per-sentence negation gate suppresses matches when the keyword shares a sentence with negation markers.

## Storage and privacy

Each project is SHA-256 keyed and stored separately:

```text
$KIMI_CODE_HOME/kimi-memory/<project-key>/memory.sqlite
$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite
```

Hook diagnostics:

```text
$KIMI_CODE_HOME/kimi-memory/_diagnostics/hooks.log          # hook runner (ingest, auto-extract, recall, decay)
<plugin-root>/_diagnostics/advisor-hooks.log                # advisor keyword detector
```

Local-first: SQLite databases live under `$KIMI_CODE_HOME/kimi-memory/`; the plugin never writes into Kimi's `sessions` tree. Two outbound behaviours:

- The MiniLM model (~25 MB) downloads lazily from Hugging Face on first use and caches locally. Disable with `KIMI_MEMORY_EMBEDDINGS=off`.
- Auto-extraction sends one short LLM call per Stop event to the model in `config.toml`. Disable with `KIMI_MEMORY_AUTO_EXTRACT=off` or `[kimi-memory] disable_auto_extract = true`.

Caveats:

- Conversation archives may contain prompts, model responses, tool arguments, and tool output — protect the Kimi data directory.
- `saveMemory` runs `looksLikeSecret` on title and content and refuses to persist known credential shapes (OpenAI, Anthropic, GitHub, AWS, JWT, PEM, `key=…`, `Authorization: Bearer`). The check is enforced at the lowest layer so every write path (`memory_save`, `memory_update`, `memory_merge`, `memory_save_bulk`, auto-extract) inherits it; `memory_save_bulk` rolls back the whole batch on a single bad item. Opt out via `KIMI_MEMORY_SECRET_SCAN=off` only for legitimate test fixtures. False positives are preferred over persisting a real secret.
- The plugin never lazy-creates the global DB on a read; it only opens an existing global DB or accepts an explicit global save.

## Reading `memory_status`

```jsonc
{
  "project_key": "59e809561f923b9f",
  "cwd": "C:/projects/example",
  "memories": {
    "total": 12, // every row in the memories table
    "active": 8, // status='active' and not expired
    "retained": 4, // superseded + soft-deleted + expired — still on disk
    "expired": 1,
    "superseded": 2,
    "deleted": 1,
    "by_type": { "semantic": 5, "procedural": 3, "episodic": 0, "working": 0 },
    "by_status": { "active": 8, "superseded": 2, "deleted": 1 },
    "latest_update_at": "2026-07-27T19:35:15.985Z",
  },
  "working_memory_slots": 2,
  "conversations": 1,
  "conversation_events": 8,
  "global": {
    "memories": {
      "total": 3,
      "active": 3,
      "retained": 0,
      "by_type": { "semantic": 2, "procedural": 1 },
      "latest_update_at": "2026-07-26T18:00:00.000Z",
    },
  },
  "scopes": { "project": "59e809561f923b9f", "global": "_global" },
}
```

Top-level fields describe the project layer; `global.memories` describes the cross-project layer; `scopes` reports the literal project key and the literal `"_global"` string used in the `project_key` column.

## Schema

`SCHEMA_VERSION` is `8`. Databases are migrated in place on first open; migrations are idempotent and append a new column or table when missing. Current schema additions: `project_paths` (canonical project root per DB, drives `memory_prune`); `last_embed_error` on `memories` (failed embeddings are observable); `last_canonical_root` + `record_count` on `project_paths` (preserves prior root on re-record).

## Uninstall and data retention

- `/plugins remove kimi-memory` (or `D` in the Installed tab) deletes the installation record but leaves the managed copy and memory databases on disk.
- Remove the managed copy: `rm -rf "$KIMI_CODE_HOME/plugins/managed/kimi-memory"`.
- Memory databases live under `$KIMI_CODE_HOME/kimi-memory/<project-key>/` and `$KIMI_CODE_HOME/kimi-memory/_global/`. Wipe everything: `rm -rf "$KIMI_CODE_HOME/kimi-memory/"`.
- For orphan-project cleanup only, use `/kimi-memory:prune` (or `memory_prune(scope: "all-projects")`) — dry-run by default, then `apply: true` to delete. The global DB and the active project's DB are always preserved.

## Development

```bash
npm install
npm run check             # node --check on every source file
npm test                  # node --test tests/*.test.js
npm run format:check      # prettier --check on every tracked file
npm run backfill-embeddings
```

The `assets/` directory holds the static assets shipped with the plugin (`icon.svg` plus a small `README.md`) and is kept under version control so the manifest and tests can rely on a stable relative path.

## Official references

- [Plugins](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html)
- [Hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html)
- [MCP](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html)
- [Skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html)
- [Slash commands](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/slash-commands.html)
- [Data locations](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html)
