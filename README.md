# Project Memory for Kimi Code

A local Kimi Code plugin that provides three-layer memory — cross-project user memory, per-project durable + working memory, and per-project session archives — through MCP tools and lifecycle hooks.

## Layered model

The plugin uses three storage layers, each with its own scope defaults:

| Layer | Path | Read default | Write default | Lifetime |
|---|---|---|---|---|
| Global user memory | `$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite` | `scope: "all"` (merged) or `scope: "global"` | `scope: "global"` (must be explicit) | Permanent; agent-curated. |
| Project durable + working memory | `$KIMI_CODE_HOME/kimi-memory/<project-key>/memory.sqlite` | `scope: "project"` (or `scope: "all"`) | `scope: "project"` (default) | Permanent; agent-curated. |
| Project session archive | same path; `conversations` + `conversation_events` tables | project-only, no scope | automatic (hook-driven) | Idempotent ingest of `wire.jsonl`. |

`<project-key>` is a SHA-256 prefix of the canonical project root, so paths are stable across runs and across machines for the same repo. The `_global` directory name keeps global data visually separated from hashed project keys; the global database uses the literal `project_key = "_global"` so existing per-project queries never accidentally hit it.

## Requirements

- Kimi Code with plugin, hook, Skill, and MCP support
- Node.js 24 or newer (`node:sqlite` is used; no native database build is required)

## Install

From Kimi Code, install this source directory as a Custom plugin:

```text
/plugins install C:/Chris-Dev/plugins/kimi-memory
/reload
```

Local plugins are copied into Kimi's managed plugin directory. After editing this source, reinstall it and run `/reload`; editing this directory alone does not update the managed copy. The MCP server and loaded Skill only see changes after `/reload` or a new session.

This repository does not install or enable itself globally.

## Use

- `/list_memories` — unqualified Skill shorthand. Calls `memory_list` with `scope: "all"`.
- `/kimi-memory:list_memories` — guaranteed namespaced plugin-command fallback.
- Natural language such as "list memories", "remember this decision", or "what did we decide?" invokes the same MCP tools when the Skill matches.

Every MCP call requires the active project's absolute root as `cwd`. This prevents accidental cross-project writes and gives global writes the correct provenance context.

## Memory tools

D durable memory (scope-aware — defaults shown):

- `memory_save(scope, type, ...)` — default `scope: "project"`.
- `memory_recall(scope, query, ...)` — default `scope: "all"` (project hits first, then global).
- `memory_list(scope, ...)` — default `scope: "all"`.
- `memory_get(scope, id)` — default `scope: "all"` (project first, then global).
- `memory_update(scope, id, ...)` — default `scope: "project"`.
- `memory_delete(scope, id, hard?)` — default `scope: "project"`.
- `memory_save_bulk(scope, items)` — default `scope: "project"`. Atomic batch save: 1–500 items, single transaction, all-or-nothing rollback on any error. Within a batch, a later item with `supersede: true` can replace an earlier one that shares the same `(type, title)`.

Working memory (project-only, no scope):

- `working_memory_set`, `working_memory_get`, `working_memory_clear`

Session archive (project-only, no scope):

- `conversation_list`, `conversation_get`, `conversation_search`, `conversation_ingest`

Combined summary:

- `memory_status` — returns project + global durable-memory counts in one call.

Successful memory operations return explicit operation metadata (`operation: "saved"|"saved_bulk"|"recalled"|"listed"|"got"|"updated"|"deleted"`), `scope`, item counts, and the affected memory `id` so callers can observe what was persisted.

### Supersede semantics

`memory_save` and `memory_save_bulk` both accept `supersede: true`. When set, the plugin looks for the **prior** `(project_key, type, title)` row(s) and:

1. Marks every prior active row as `status = 'superseded'`, with `superseded_by` pointing at the new row.
2. Stamps the new row's `supersedes` field with the id of the most-recent prior, so the replacement is queryable in both directions.

If there is no prior matching row, `supersede: true` is a no-op: the new memory is still saved as `active`. The flag is meant to *replace*, not to *tombstone*, so pairing it with no predecessor simply creates a fresh active entry.

### `scope: "all"` ordering

When a tool reads with `scope: "all"`, results are sorted most-recent-first **within each scope**, then concatenated: every project row appears before every global row. A more recent global row cannot outrank a stale project row.

Memory types:

- `working`: active scratch context and intermediate state
- `episodic`: timestamped events and prior interactions
- `semantic`: durable facts, decisions, rules, and specifications
- `procedural`: repeatable workflows and step-by-step instructions

## Conversation archival

Lifecycle hooks run at `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`, `PreCompact`, `Interrupt`, and `StopFailure`. They incrementally read the current session's `agents/main/wire.jsonl`, preserve every raw JSONL event, and extract searchable user, assistant, and tool summaries. Imports use byte and line cursors and are idempotent.

`SessionStart` and `UserPromptSubmit` write a compact status line plus a brief summary line to stdout. The status line always reports project key, active project and global memory counts, working-slot count, conversations, conversation events, ingest status (event count or skip reason), and (for `UserPromptSubmit`) project/global recall hit counts. The summary line is intentionally short so the agent's chat stays uncluttered:

- SessionStart: `Loaded N recent memories. (N project, N global.)` or `No recent memories.`
- UserPromptSubmit: `Recalled N memory/memories. (N project, N global.)` or `No recall hits.`

Working-memory slots are still emitted as compact `- WM <slot>: <value>` lines, since the agent's current focus is the one piece of context it consistently needs at session start. The agent can pull full memory content via `memory_recall` whenever it needs the actual bodies — the hook deliberately does not echo them. Raw prompts and memory bodies are never written to stdout.

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
$KIMI_CODE_HOME/kimi-memory/_diagnostics/hooks.log
```

The plugin is entirely local and makes no network calls. It does not write into Kimi's `sessions` tree.

- Project conversation archives may contain prompts, model responses, tool arguments, and tool output, so protect the Kimi data directory. Automatic full-conversation archival cannot guarantee that a conversation never contains sensitive text.
- Memory-save instructions prohibit deliberately saving API keys, passwords, credentials, `.env` contents, and other secrets. The plugin never lazy-creates the global database on a read; it only opens an existing global DB or accepts an explicit global save.

## Reading `memory_status`

```jsonc
{
  "project_key": "59e809561f923b9f",
  "cwd": "C:/projects/example",
  "memories": {
    "total": 12,        // every row in the memories table (compat field)
    "active": 8,        // status='active' and not expired — currently forceable
    "retained": 4,      // superseded + soft-deleted + expired — still on disk
    "expired": 1,
    "superseded": 2,
    "deleted": 1,
    "by_type": { "semantic": 5, "procedural": 3, "episodic": 0, "working": 0 },
    "by_status": { "active": 8, "superseded": 2, "deleted": 1 },
    "latest_update_at": "2026-07-27T19:35:15.985Z"
  },
  "working_memory_slots": 2,
  "conversations": 1,
  "conversation_events": 8,
  "global": {
    "memories": {
      "total": 3, "active": 3, "retained": 0,
      "by_type": { "semantic": 2, "procedural": 1 },
      "latest_update_at": "2026-07-26T18:00:00.000Z"
    }
  },
  "scopes": { "project": "59e809561f923b9f", "global": "_global" }
}
```

Top-level fields describe the project layer; `global.memories` describes the cross-project layer; `scopes` reports the literal project key and the literal `"_global"` string used in the `project_key` column for each database.

## Hook output format

`SessionStart` and `UserPromptSubmit` emit two kinds of lines on stdout:

**Status line** (always one line, structured, parseable):

```text
[kimi-memory] event=UserPromptSubmit project_key=59e809561f923b9f pmem.active=0 gmem.active=1 wm=0 conv=3 events=354 ingest=ok:2 recall project:0 global:0 cwd=C:\Users\cbunt\kimi-code\plugins\managed\kimi-memory
```

**Summary line** (zero or one line, human-readable):

```text
Loaded 2 recent memories. (1 project, 1 global.)
```

```text
Recalled 1 memory. (1 global.)
```

```text
No recall hits.
```

Working-memory slots are appended as `- WM <slot>: <value>` lines, then nothing else. The hooks never echo memory bodies, raw prompts, or session transcripts. The agent pulls full memory content via `memory_recall` when it actually needs it.

## Soft deletion

Soft deletion is the default for memories. `memory_delete` with `hard: true` permanently removes the selected memory row.

## Uninstall and data retention

Disable or remove the plugin through `/plugins`. Removing the plugin does not delete memory databases. To erase retained data, manually remove the relevant directory under `$KIMI_CODE_HOME/kimi-memory/` after confirming the project key with `memory_status`.

## Development

```bash
npm install
npm run check
npm test
```

## Official references

- https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/reference/slash-commands.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html
