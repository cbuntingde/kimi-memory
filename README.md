# Project Memory for Kimi Code

<p align="center">
  <img src="assets/demo-list-calls.png" alt="Kimi assistant running memory_list" width="48%" />
  <img src="assets/demo-list-output.png" alt="Memory list and summary output" width="48%" />
</p>

A local Kimi Code plugin that provides three-layer memory — cross-project user memory, per-project durable + working memory, and per-project session archives — through MCP tools and lifecycle hooks.

## Layered model

The plugin uses three storage layers, each with its own scope defaults:

| Layer                            | Path                                                      | Read default                                 | Write default                        | Lifetime                           |
| -------------------------------- | --------------------------------------------------------- | -------------------------------------------- | ------------------------------------ | ---------------------------------- |
| Global user memory               | `$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite`       | `scope: "all"` (merged) or `scope: "global"` | `scope: "global"` (must be explicit) | Permanent; agent-curated.          |
| Project durable + working memory | `$KIMI_CODE_HOME/kimi-memory/<project-key>/memory.sqlite` | `scope: "project"` (or `scope: "all"`)       | `scope: "project"` (default)         | Permanent; agent-curated.          |
| Project session archive          | same path; `conversations` + `conversation_events` tables | project-only, no scope                       | automatic (hook-driven)              | Idempotent ingest of `wire.jsonl`. |

`<project-key>` is a SHA-256 prefix of the canonical project root, so paths are stable across runs and across machines for the same repo. The `_global` directory name keeps global data visually separated from hashed project keys; the global database uses the literal `project_key = "_global"` so existing per-project queries never accidentally hit it.

## Requirements

- Kimi Code with plugin, hook, Skill, and MCP support
- Node.js 24 or newer (`node:sqlite` is used; no native database build is required)

## Install

### AI-driven install (one URL, hands-off)

Paste the URL below into Kimi Code's chat input and ask the agent to
follow it. The agent fetches `ai-install.md` from the repo and walks the
end-to-end install, including dependency install, manifest verification,
MCP bring-up, and hook smoke-test. This is the recommended path because
it catches the `npm install` step (Kimi does not run it for you) and the
trust-prompt default-cancel gotcha in one pass.

```text
https://raw.githubusercontent.com/cbuntingde/kimi-memory/main/ai-install.md
```

The agent-run procedure is agent-facing; humans who want to drive the
install themselves can read the same file directly and follow the steps.

### Manual install

The plugin source is this directory. Two prerequisites from a clean checkout:

1. `npm install` inside this directory. Kimi copies the source into
   `$KIMI_CODE_HOME/plugins/managed/kimi-memory/` on install but does
   not run `npm install` for you, so the MCP server fails on its first
   call without `node_modules/`.
2. The plugin is not on the Kimi official marketplace, so
   `/plugins install` shows a trust prompt that defaults to **Cancel**.
   Pick the affirmative option; a Cancel leaves no record, so just
   re-run the slash and accept.

Then from the Kimi TUI chat input:

```text
/plugins install <absolute-path-to-this-repo>
/reload
```

To install without a local checkout, pass a GitHub URL:
`/plugins install https://github.com/cbuntingde/kimi-memory`. Kimi pulls
the source itself; you still owe `npm install` in the managed copy once
it lands under `$KIMI_CODE_HOME/plugins/managed/kimi-memory/`.

Verify with `/plugins info kimi-memory` — no diagnostic block means a
clean install. If the plugin is already installed (check
`$KIMI_CODE_HOME/plugins/installed.json`), skip the install slash and
just `/reload` after dependency changes; each install copies the source
again, so re-installing a healthy install is wasteful.

Local plugins are copied into Kimi's managed plugin directory. Edits to
this source do not propagate to the managed copy; reinstall after every
meaningful change and then `/reload`. The MCP server and loaded Skill
only see changes after `/reload` or a new session.

This repository does not install or enable itself globally.

## Use

- `/list_memories` — unqualified Skill shorthand. Calls `memory_list` with `scope: "all"`.
- `/kimi-memory:list_memories` — guaranteed namespaced plugin-command fallback.
- `/kimi-memory:advisor` — runs the advisor reflection procedure over the active project (anchored recommendations, no remote calls). Also reachable through natural-language triggers like "would we change anything" or "what would you do differently" — the auto-detect hook emits `[advisor] matched: ...` on the hook status.
- `/kimi-memory:prune` — dry-run-first cleanup of orphan project databases (projects whose canonical root no longer exists on disk). Always dry-runs first; `--apply` removes after explicit confirmation.
- `/kimi-memory:memos` — open the companion `kimi-memos-dashboard` in the default browser (read-only view of every kimi-memory SQLite database; the dashboard is a separate plugin that the user must start).
- Natural language such as "list memories", "remember this decision", or "what did we decide?" invokes the same MCP tools when the Skill matches.

Every MCP call requires the active project's absolute root as `cwd`. This prevents accidental cross-project writes and gives global writes the correct provenance context.

## Environment variables

All optional. Defaults are tuned for production use; these are the override knobs.

| Variable                       | Default | Effect                                                                                                                                                           |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KIMI_MEMORY_EMBEDDINGS`       | `on`    | Set to `off` to skip the embedding encoder entirely. `memory_recall` falls back to FTS5-only; `memory_similar` returns `[]`.                                     |
| `KIMI_MEMORY_EMBED_TIMEOUT_MS` | `4000`  | Wall-clock cap on a single embedding call. On timeout the row's `embedding_status` flips to `failed` with `last_embed_error = "embed_timeout: ..."`.             |
| `KIMI_MEMORY_AUTO_EXTRACT`     | `on`    | Set to `off` to disable the Stop-hook auto-extraction LLM call. Also configurable as `[kimi-memory] disable_auto_extract = true` in `config.toml`.               |
| `KIMI_MEMORY_SECRET_SCAN`      | `on`    | Set to `off` to bypass the server-side secret check on `saveMemory`. The check refuses to persist a row whose title or content matches a known credential shape. |
| `KIMI_MEMORY_PERF`             | `on`    | Set to `off` to skip the `tests/16-perf.test.js` benchmarks (5k-corpus baseline). Useful on slow CI hosts.                                                       |

## Memory tools

The plugin exposes **24 MCP tools** over the `kimi-memory` stdio server. Durable memory (scope-aware — defaults shown):

- `memory_save(scope, type, ...)` — default `scope: "project"`. Accepts `synthesizes: [childId, ...]` for the `conclusion` type to record which lower-level memories it was derived from.
- `memory_recall(scope, query, ...)` — default `scope: "all"` (project hits first, then global). Hybrid search: FTS5 keyword match blended with cosine over stored embeddings when an embedding exists. Falls back to FTS5-only when `KIMI_MEMORY_EMBEDDINGS=off` or the model fails to load.
- `memory_list(scope, ...)` — default `scope: "all"`.
- `memory_get(scope, id)` — default `scope: "all"` (project first, then global).
- `memory_update(scope, id, ...)` — default `scope: "project"`.
- `memory_delete(scope, id, hard?)` — default `scope: "project"`.
- `memory_save_bulk(scope, items)` — default `scope: "project"`. Atomic batch save: 1–500 items, single transaction, all-or-nothing rollback on any error. Within a batch, a later item with `supersede: true` can replace an earlier one that shares the same `(type, title)`.

Similarity, edges, and synthesis:

- `memory_similar(scope, id, limit?, threshold?)` — return memories closest to `id` by embedding cosine. `threshold` is the minimum cosine in `[0, 1]` (default `0.6`); `limit` defaults to `10`. Returns `[]` when the seed has no embedding. Default `scope: "all"`.
- `memory_link(scope, from_id, to_id, kind, weight?)` — write a typed edge between two memories. `kind` is one of `related`, `supports`, `contradicts`, `supersedes`, `synthesizes`; `weight` defaults to `1.0` and lives in `[0, 10]`.
- `memory_unlink(scope, edge_id)` — remove a previously written edge.
- `memory_edges(scope, id, direction?, kind?)` — return edges where `id` is the source or target (`direction: "out" | "in" | "both"`, default `both`; `kind` is an optional filter).
- `memory_merge(scope, into_id, from_id, merged_content?, weight?)` — soft-supersede one memory into another. `into_id` stays active and gains the union of `from_id`'s tags plus a `provenance.merge_from` entry; `from_id` is soft-superseded and a `supersedes` edge points `from_id → into_id`. Pass `merged_content` to overwrite `into_id`'s body; otherwise it is kept.
- `memory_reinforce(scope, id)` — bump a memory's `confidence` by `+0.05` (hard-coded) and stamp `last_accessed_at = now` so the decay pass treats it as fresh. Idempotent — call repeatedly when a memory proves useful.

Working memory (project-only, no scope):

- `working_memory_set`, `working_memory_get`, `working_memory_clear`

Session archive (project-only, no scope):

- `conversation_list`, `conversation_get`, `conversation_search`, `conversation_ingest`

Higher-order (project-aware reads; `conclusions_for`/`parents` accept `scope: "all"`):

- `memory_conclusions_for(scope, child_id, limit?)` — list `conclusion`-typed memories that were synthesized from `child_id`.
- `memory_parents(scope, conclusion_id, limit?)` — inverse: list the underlying memories that a given conclusion was built from.

Combined summary:

- `memory_status` — returns project + global durable-memory counts in one call.

Maintenance (orphan-project cleanup):

- `memory_prune(cwd, scope?, apply?)` — find (and optionally delete) project databases whose canonical project root no longer exists on disk. `scope` is `"project"` (default — only the active project) or `"all-projects"` (every project DB in the data root except the active one). `apply` defaults to `false` (dry run). The active project and the global database are never removed. Driven by the `project_paths` table that the MCP server and the hook runner update on every project DB open.

Successful memory operations return explicit operation metadata (`operation: "saved"|"saved_bulk"|"recalled"|"listed"|"got"|"updated"|"deleted"|"pruned"`), `scope`, item counts, and the affected memory `id` so callers can observe what was persisted.

### Standalone CLI

The same surface is reachable without spinning up the MCP server via the `kimi-memory` bin entry:

```bash
kimi-memory list    [--cwd <path>] [--scope project|global|all] [--type <type>] [--limit N] [--json] [-q]
kimi-memory get     <memory-id> [--scope project|global] [--cwd <path>] [--json]
kimi-memory status  [--cwd <path>] [--json]
kimi-memory recall  <query> [--cwd <path>] [--limit N] [--per-type] [--json]
kimi-memory prune   [--cwd <path>] [--all-projects] [--apply] [--json]
```

`--json` emits machine-readable JSON; `-q` (list only) suppresses per-row output. `--home <dir>` overrides `$KIMI_CODE_HOME` for ops debugging on a non-default data root. The CLI never writes — `prune --apply` is the only mutating command and is gated by the same dry-run-first contract as the MCP `memory_prune` tool.

### Secret scan on save

`saveMemory` runs `looksLikeSecret` on the new title and content and throws `KIMI_MEMORY_SECRET_DETECTED` if either matches a known credential shape (OpenAI, Anthropic, GitHub, AWS, JWT, PEM, `key=…` assignments, `Authorization: Bearer` headers). The check is enforced at the lowest layer so every write path (`memory_save`, `memory_update`, `memory_merge`, `memory_save_bulk`, the auto-extract pass) inherits it. `memory_save_bulk` rolls back the whole batch on a single bad item. The only opt-out is `KIMI_MEMORY_SECRET_SCAN=off` in the server environment — for the rare case where a user genuinely needs to persist a secret-shaped string (a test fixture, an example). False positives are accepted: dropping a candidate that mentions a generic "api_key" is far cheaper than persisting a real one.

### Supersede semantics

`memory_save` and `memory_save_bulk` both accept `supersede: true`. When set, the plugin looks for the **prior** `(project_key, type, title)` row(s) and:

1. Marks every prior active row as `status = 'superseded'`, with `superseded_by` pointing at the new row.
2. Stamps the new row's `supersedes` field with the id of the most-recent prior, so the replacement is queryable in both directions.

If there is no prior matching row, `supersede: true` is a no-op: the new memory is still saved as `active`. The flag is meant to _replace_, not to _tombstone_, so pairing it with no predecessor simply creates a fresh active entry.

### `scope: "all"` ordering

When a tool reads with `scope: "all"`, results are sorted most-recent-first **within each scope**, then concatenated: every project row appears before every global row. A more recent global row cannot outrank a stale project row.

Memory types:

- `working`: active scratch context and intermediate state
- `episodic`: timestamped events and prior interactions
- `semantic`: durable facts, decisions, rules, and specifications
- `procedural`: repeatable workflows and step-by-step instructions
- `conclusion`: a higher-order synthesis built from one or more underlying memories. A `conclusion` row carries a list of `child_id` references in `memory_synthesizes` so the lineage is queryable in both directions (see [Higher-level features](#higher-level-features)).

### Schema version

`SCHEMA_VERSION` is `8`. Existing databases are migrated in place on first open; migrations are idempotent and append a new column or table when missing. The current migration stack covers:

- v6: `project_paths` table — records the canonical project root for each project DB so `memory_prune` can detect orphans.
- v7: `last_embed_error` column on `memories` — a failed embedding pass is observable via `rowToMemory.embedding_status: 'failed'` instead of staying `pending` forever.
- v8: `last_canonical_root` + `record_count` columns on `project_paths` — a project that moved is recorded with a move history (the prior canonical root is preserved on re-record).

## Higher-level features

### Vector similarity search

The `memories` table carries an optional 384-dim `embedding` (stored as `BLOB`, float32). By default every `memory_save`, `memory_recall`, `memory_save_bulk`, and `memory_merge` call computes an embedding for the title+content and stores it. `memory_recall` runs FTS5 keyword search and cosine similarity in parallel and merges the two ranked lists (deduplicating by id). `memory_similar(scope, id)` returns memories closest to a seed memory's embedding.

The model is `Xenova/all-MiniLM-L6-v2` (quantised, ~25 MB on disk) and is fetched lazily from Hugging Face on first use; the model is cached locally afterwards, so subsequent calls do not require network access. Set `KIMI_MEMORY_EMBEDDINGS=off` to skip embedding entirely (the rest of the surface still works, only similarity is unavailable). When the model fails to load or is opted out, `memory_recall` falls back to FTS5-only and `memory_similar` returns `[]`.

The encoder load is wall-clock bounded at 4 s (`KIMI_MEMORY_EMBED_TIMEOUT_MS` overrides), comfortably under the 5 s hook budget. On a timeout the row's `embedding_status` flips to `failed` and `last_embed_error` records `embed_timeout: ...` so the operator can see the cause without a separate log dive; the next call rides the in-flight load if it eventually lands.

### Edges and merge

`memory_edges (id, project_key, from_id, to_id, kind, weight, created_at)` records typed relationships between memories inside a single scope. `kind` is one of `related | supports | contradicts | supersedes | synthesizes`. Edges are written by:

- `memory_save(..., supersede: true)` — automatically writes a `supersedes` edge from the new row to the most-recent prior row with the same `(type, title)`.
- `memory_link(...)` — explicit user-driven edge between any two active memories.
- `memory_merge(...)` — writes a `supersedes` edge from the merged-in source to the destination.

Edges are visible via `memory_edges(scope, id, direction?, kind?)`. To remove one: `memory_unlink(scope, edge_id)`.

### Auto-extraction

The `Stop` hook (and the other handlers that delegate to it — `SessionEnd`, `PreCompact`, `Interrupt`, `StopFailure`) runs an idempotent auto-extract pass after the conversation-events table is up to date. It reads the last six conversation summaries, asks the configured model provider for up to three candidate memories, and saves the survivors through `memory_save` with `provenance.source = "auto_extract"` so they are distinguishable from manual saves. Auto-extracted rows are visible on the kimi-memos-dashboard with a purple `src-badge src-auto_extract` chip.

Cost guards: extraction skips when there are fewer than `6` events in the session, when the latest event is older than 5 minutes (no longer "in flight"), or when the same `(type, title)` already exists. It also skips anything that looks like a transient task, anything already covered by an active recall hit, and any sentence containing a likely secret.

Auto-extraction sends one short LLM call per Stop event to the model configured in `$KIMI_CODE_HOME/config.toml`. Disable it with either:

- `KIMI_MEMORY_AUTO_EXTRACT=off` (environment variable), or
- `[kimi-memory]` `disable_auto_extract = true` in `config.toml` (consumed by `src/validation.js`).

The agent should still verify an auto-extracted batch before treating it as canon.

### Importance and decay

Every memory has a `confidence` (default `0.8`, range `0.1–1.0`) and an `access_count` / `last_accessed_at` pair. A background pass runs at the end of every `SessionStart`:

- Rows newer than 30 days, or accessed within 30 days, are untouched.
- Older untouched rows decay `5% per 30 days`, floored at `0.1`. Decay uses `COALESCE(last_accessed_at, updated_at)` so a row that has never been reinforced still drifts.
- Decay runs in a single SQL `UPDATE`; it is logged in the hook output.

`memory_reinforce(scope, id)` nudges a memory's confidence up by `+0.05` and stamps `last_accessed_at = now`. Recall hits that the agent reads are good candidates to reinforce.

### Higher-order `conclusion` type

A `conclusion` is a memory that synthesizes one or more underlying memories. Save it with `memory_save({ ..., type: "conclusion", synthesizes: [childId, ...] })`. The plugin writes one row to `memory_synthesizes` per child and exposes two read tools:

- `memory_conclusions_for(scope, childId, limit?)` — which conclusions did this memory feed into?
- `memory_parents(scope, conclusionId, limit?)` — which memories fed into this conclusion?

Use this for any case where the right answer is not a raw fact but a synthesis — meeting takeaways, design decisions with tradeoffs, project retrospectives. Conclusions decay like any other row, but their child rows do not decay while the conclusion is active; reinforce the conclusion and the children stay fresh by association through the `memory_reinforce` call on the conclusion itself.

## Conversation archival

Lifecycle hooks run at `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`, `PreCompact`, `Interrupt`, and `StopFailure`. They incrementally read the current session's `agents/main/wire.jsonl`, preserve every raw JSONL event, and extract searchable user, assistant, and tool summaries. Imports use byte and line cursors and are idempotent.

`SessionStart` and `UserPromptSubmit` write a compact status line plus a brief summary line to stdout. The status line always reports project key, active project and global memory counts, working-slot count, conversations, conversation events, ingest status (event count or skip reason), and (for `UserPromptSubmit`) project/global recall hit counts. The summary line is intentionally short so the agent's chat stays uncluttered:

- SessionStart: `Loaded N recent memories. (N project, N global.)` or `No recent memories.`
- UserPromptSubmit: `Recalled N memory/memories. (N project, N global.) [semantic: 2, procedural: 1]` (a per-type breakdown appended when there are hits) or `No recall hits.`.

The `UserPromptSubmit` summary is followed by up to three `[recall: i/N] "title" (type, scope, score=…) — <body snippet>` lines, sorted by score. The body snippet is the first non-empty line of the memory's `content`, capped at 120 characters, so the user can verify what was recalled without depending on the agent to translate titles into substance. Snippets are bounded; full bodies are pulled by the agent via `memory_recall` only when the snippet is not enough.

Working-memory slots are still emitted as compact `- WM <slot>: <value>` lines, since the agent's current focus is the one piece of context it consistently needs at session start. The hook deliberately does **not** echo full memory bodies, raw prompts, or session transcripts on stdout.

The remaining hooks (`Stop`, `SessionEnd`, `PreCompact`, `Interrupt`, `StopFailure`) are silent on stdout and run only the idempotent project-session ingest. They are fail-open and never block Kimi's lifecycle on a transcript problem.

Kimi does not document full conversation text in hook payloads. Therefore, complete archival reads Kimi's session transcript files without modifying them. The `wire.jsonl` record schema is an internal format and may evolve; the parser is intentionally tolerant and keeps unknown/malformed records verbatim.

## Storage and privacy

Each canonical project path is SHA-256 keyed and stored separately:

```text
$KIMI_CODE_HOME/kimi-memory/<project-key>/memory.sqlite
$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite
```

Hook diagnostics are stored at:

```text
$KIMI_CODE_HOME/kimi-memory/_diagnostics/hooks.log      # hook runner (transcript ingest, auto-extract, recall, decay)
<plugin-root>/_diagnostics/advisor-hooks.log            # advisor keyword detector (matchAdvisor hits + errors)
```

The plugin is local-first: SQLite databases live under `$KIMI_CODE_HOME/kimi-memory/`, and the plugin never writes into Kimi's `sessions` tree. Two outbound behaviours can occur:

- The MiniLM embedding model (`Xenova/all-MiniLM-L6-v2`, ~25 MB) is downloaded lazily from Hugging Face on first use and cached on disk afterwards. Set `KIMI_MEMORY_EMBEDDINGS=off` to skip this download and the per-save embedding pass.
- Auto-extraction sends one short LLM call per `Stop` event to the model configured in `$KIMI_CODE_HOME/config.toml`. Disable it via `KIMI_MEMORY_AUTO_EXTRACT=off` or `[kimi-memory] disable_auto_extract = true` in `config.toml`.

- Project conversation archives may contain prompts, model responses, tool arguments, and tool output, so protect the Kimi data directory. Automatic full-conversation archival cannot guarantee that a conversation never contains sensitive text.
- Memory-save instructions prohibit deliberately saving API keys, passwords, credentials, `.env` contents, and other secrets. The persist layer also enforces this: `saveMemory` runs `looksLikeSecret` on the new title and content and refuses to land a row that matches a known credential shape. The plugin never lazy-creates the global database on a read; it only opens an existing global DB or accepts an explicit global save.

## Reading `memory_status`

```jsonc
{
  "project_key": "59e809561f923b9f",
  "cwd": "C:/projects/example",
  "memories": {
    "total": 12, // every row in the memories table (compat field)
    "active": 8, // status='active' and not expired — currently forceable
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

Top-level fields describe the project layer; `global.memories` describes the cross-project layer; `scopes` reports the literal project key and the literal `"_global"` string used in the `project_key` column for each database.

## Hook output format

`SessionStart` and `UserPromptSubmit` emit up to three kinds of lines on stdout:

**Status line** (always one line, structured, parseable):

```text
[kimi-memory] event=UserPromptSubmit project_key=59e809561f923b9f pmem.active=0 gmem.active=1 wm=0 conv=3 events=354 ingest=ok:2 recall project:0 global:0 cwd=C:\Users\cbunt\kimi-code\plugins\managed\kimi-memory
```

**Summary line** (zero or one line, human-readable):

```text
Loaded 2 recent memories. (1 project, 1 global.)
```

```text
Recalled 3 memories. (2 project, 1 global.) [semantic: 2, procedural: 1]
```

```text
No recall hits.
```

**Recall lines** (up to three on `UserPromptSubmit`, sorted by score, when the summary above reports hits):

```text
[recall: 1/3] "semantic use tabs" (semantic, project, score=0.78) — indent with tabs not spaces for release
[recall: 2/3] "Tabs for release" (procedural, project, score=0.50) — run prettier with --use-tabs before tagging
[recall: 3/3] "User prefers dark mode" (semantic, global, score=0.45) — dark mode is the default for new sessions
```

**Advisor match line** (zero or one line on `UserPromptSubmit` only, when the prompt contains a frozen keyword):

```text
[advisor] matched: "would we change" — /advisor or ask naturally; skill `advisor` is loaded
```

The frozen keyword list lives in `src/advisor/detect.js`; a per-sentence negation gate (20+ markers) suppresses matches when the keyword shares a sentence with words like "wouldn't", "not", "never". The advisor subsystem is fail-open and only logs to its own `<plugin-root>/_diagnostics/advisor-hooks.log`.

Working-memory slots are appended as `- WM <slot>: <value>` lines, then nothing else. The hooks do **not** echo full memory bodies, raw prompts, or session transcripts; per-memory recall lines carry a bounded body snippet (capped at 120 chars) so the user can verify the recall without a second round-trip. The agent pulls full memory content via `memory_recall` when the snippet is not enough.

## Soft deletion

Soft deletion is the default for memories. `memory_delete` with `hard: true` permanently removes the selected memory row.

## Orphan-project cleanup

When a project is deleted, moved, or rebuilt at a different path, its
per-project database at
`$KIMI_CODE_HOME/kimi-memory/<project-key>/memory.sqlite` stays on disk
because the SHA-256 key was path-derived and the new path no longer
hashes to the same key. `memory_prune` walks the data root, looks up
each project DB's recorded canonical root in the `project_paths` table
(stamped automatically on every project DB open by the MCP server and
the hook runner), and reports any DB whose root no longer exists. The
default `apply: false` is a dry run; re-run with `apply: true` to delete.

The active project is always reported as `kept-active` regardless of
`apply`. The global database is never in scope. To remove the
install entirely, follow [`uninstall.md`](uninstall.md).

## Uninstall and data retention

The complete uninstall procedure (slash command, managed-copy removal,
memory-database wipe, diagnostics cleanup, source-checkout teardown) lives
in [`uninstall.md`](uninstall.md). The short version:

- `/plugins remove kimi-memory` (or `D` in the Installed tab) deletes the
  installation record but leaves the managed copy and memory databases
  on disk.
- The managed copy is removed with
  `rm -rf "$KIMI_CODE_HOME/plugins/managed/kimi-memory"`.
- Memory databases live under `$KIMI_CODE_HOME/kimi-memory/<project-key>/`
  and `$KIMI_CODE_HOME/kimi-memory/_global/`. Wipe the whole tree with
  `rm -rf "$KIMI_CODE_HOME/kimi-memory/"` only when you want to erase
  every memory this plugin has stored.

For a softer cleanup of just the orphan-project databases (project
directories whose canonical root no longer exists on disk), use
`memory_prune(scope: "all-projects")` for a dry run, then re-run with
`apply: true` to remove the orphans. The global database and the active
project's database are always preserved. The user-facing wrapper is the
`/kimi-memory:prune` slash command.

## Development

```bash
npm install
npm run check        # node --check on every source file
npm test             # node --test tests/*.test.js
npm run format:check # prettier --check on every tracked file
npm run backfill-embeddings   # rebuild embeddings for older rows
```

The `assets/` directory holds the static assets the plugin ships with — currently `icon.svg` (a three-node knowledge-graph display icon) and a small `README.md` describing the contents. The directory is kept under version control so the manifest and test suite can rely on a stable relative path.

## Official references

- https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/reference/slash-commands.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html
