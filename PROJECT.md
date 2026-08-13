# PROJECT.md — kimi-memory

Operating contract for the kimi-memory plugin. Every subsequent craftsman pass
(`document`, `critique`, `audit`, etc.) reads this file first; if it is wrong,
those passes are wrong.

## 1. What this is

`kimi-memory` is a Kimi Code plugin that gives the agent a three-layer local
memory backed by SQLite and exposes it through MCP tools, lifecycle hooks,
slash commands, and a small ops CLI. It also embeds a lightweight advisor
subsystem that surfaces reflection prompts when the user says things like
"would we change anything" or "what are we missing".

The three layers are: a **global user** memory shared across every project
(`$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite`), a **per-project**
durable + working memory keyed by a SHA-256 prefix of the canonical project
root (`$KIMI_CODE_HOME/kimi-memory/<project-key>/memory.sqlite`), and a
**per-project session archive** of `wire.jsonl` events ingested idempotently
by lifecycle hooks. The agent curates what gets persisted — there is no
synchronous memory write on every tool call.

## 2. Who uses it, and how

- **The Kimi agent** is the primary reader and writer. It calls the 46 MCP
  tools on `kimi-memory` to recall (`memory_recall`), persist (`memory_save`,
  `memory_save_bulk`), reinforce (`memory_reinforce`), search by embedding
  (`memory_similar`), draw typed edges (`memory_link`, `memory_merge`),
  synthesise (`memory_save({ type: 'conclusion', synthesizes: [...] })`), and
  inspect status (`memory_status`). It passes the active project root as
  `cwd` on every call so writes are scoped and provenance is recorded.
- **The user** interacts through slash commands (`/list_memories`,
  `/kimi-memory:prune`, `/kimi-memory:reset_project`, `/kimi-memory:advisor`,
  `/kimi-memory:memos`) and natural language that the Skill triggers match
  ("remember this decision", "what did we decide?").
- **Lifecycle hooks** are the secondary writer. `SessionStart`, `UserPromptSubmit`,
  `Stop`, `SessionEnd`, `PreCompact`, `Interrupt`, `StopFailure`, and
  `PostToolUse` all run idempotent background work: session ingest,
  session-focus capture, auto-GC, auto-merge, decay, and the auto-extract LLM
  call. `UserPromptSubmit` and `PostToolUse` also surface recall hits to the
  model via `hookSpecificOutput.additionalContext`.
- **The ops CLI** (`kimi-memory` bin, `src/cli.js`) is used for scripted
  cleanup and debugging — `list`, `get`, `status`, `recall`, `prune`,
  `reset-project`, `acl {list,grant,revoke}`. The agent should still use the
  MCP tools.
- **The companion dashboard** (`kimi-memos-dashboard`, a separate plugin) is
  a read-only browser UI over every kimi-memory SQLite DB; it opens via
  `/kimi-memory:memos`.

## 3. What this must never do

These are non-negotiable. Every "is this OK?" question in a future pass
answers here first.

- **Must never accept identity claims from the MCP tool surface.**
  `memory_save`, `memory_update`, and `memory_save_bulk` no longer
  accept `team_id`, `agent_id`, `user_id`, `session_id`, or `task_id`
  from the caller. The MCP server has no authenticated caller, so a
  tool input would be a forge vector. The columns exist on the row
  for the hook layer (which has access to the running session
  principal) and for future signed-token auth. See `CONVENTIONS.md
§7` for the rationale.
- **Must never store secrets, API keys, tokens, `.env` contents, or PII.**
  Enforced at the lowest layer by `looksLikeSecret` in `src/extract.js`,
  applied to `title`, `content`, every `tags` entry, and every string value
  in `metadata` (recursively). Every write path inherits the check
  (`memory_save`, `memory_update`, `memory_merge`, `memory_save_bulk`,
  auto-extract). The only opt-out is `KIMI_MEMORY_SECRET_SCAN=off`, reserved
  for legitimate test fixtures. False positives are accepted; the cost of
  dropping a candidate that mentions a generic `api_key` is far cheaper than
  persisting a real one.
- **Must never block Kimi's lifecycle.** Every hook catches uncaught errors,
  logs to `$KIMI_CODE_HOME/kimi-memory/_diagnostics/hooks.log`, and exits 0.
  Background passes (auto-GC, consolidate, decay, auto-merge) inherit the
  same fail-open contract — wrap each pass in try/catch so a single hiccup
  does not abort the rest of the SessionStart work.
- **Must never echo full memory bodies or raw prompts on hook stdout.** The
  status line is bounded; per-memory lines live in
  `hookSpecificOutput.additionalContext` (numbered list, top 3 hits, body
  snippet capped at 120 chars) so the model sees them while the
  human-readable `systemMessage` stays clean. The verbose `[recall: i/N]`
  style was retired in v0.5.1.
- **Must never lazy-create the global DB on a read.** A `memory_recall` /
  `memory_list` / `memory_status` over `scope: 'global'` against a fresh
  install must not create any files. Write paths
  (`memory_save({scope:'global',...})`, `acl_share_memory` in-place
  promotion, `memory_reset_project` confirm=true) DO create the directory on
  first write.
- **Must never write into Kimi's `sessions/` tree.** Local-first: SQLite
  databases live under `$KIMI_CODE_HOME/kimi-memory/`; the plugin reads
  `agents/main/wire.jsonl` but never modifies it. The session-archive parser
  is tolerant of unknown/malformed records.
- **Must never break the wire protocol.** Session archival uses byte and line
  cursors and is idempotent — re-ingesting the same `wire.jsonl` must not
  duplicate rows. A cursor mismatch surfaces as a `conversation_ingest_error`
  diagnostic, never a crash.
- **Must never make more than two outbound calls by default.** (1) the
  MiniLM embedding model download from Hugging Face (~25 MB, lazy, cached
  locally, disable with `KIMI_MEMORY_EMBEDDINGS=off`); (2) the Stop-hook
  auto-extract LLM call to the model in `$KIMI_CODE_HOME/config.toml`. The
  auto-extract call **scrubs the conversation transcript with
  `redactSecrets` server-side** before it leaves the machine. Both can be
  disabled independently.
- **Must never hard-delete without grace.** Soft-delete (`memory_delete`
  without `hard: true`) marks the row `deleted` and lets auto-GC reap it
  after a 30-day grace. Auto-GC has its own grace windows: deleted after 30
  days; soft-superseded after 90 days; embedding-failed after 30 days; cold
  rows after 365 days; orphans after 7 days.
- **Must never require a manual schema upgrade.** `MIGRATIONS` in
  `src/persist/connection.js` runs on every `openDb`; each entry is
  idempotent (probes the live schema, no-ops when target shape is in place).
  Existing rows must survive a `SCHEMA_VERSION` bump without a manual step.

## 4. Stack and runtime

- **Language**: JavaScript (ESM, plain — no transpilation, no TypeScript).
- **Runtime**: Node.js ≥ 24.0.0 (uses the built-in `node:sqlite` driver; no
  native build required).
- **Package manager**: npm ≥ 10.0.0. The plugin bootstraps its own runtime
  from `package-lock.json` with `npm ci` on first MCP start.
- **Database**: SQLite via `node:sqlite`. Per-project DBs plus a global DB
  plus an opt-in `_shared` ACL pool plus a `_diagnostics` log directory.
- **MCP**: `@modelcontextprotocol/sdk` ^1.29.0 (stdio transport).
- **Embedding model**: `Xenova/all-MiniLM-L6-v2` (~25 MB) loaded lazily via
  `@huggingface/transformers` ^4.2.0. 384-dim float32 vectors, 4 s wall-clock
  cap per embed (`KIMI_MEMORY_EMBED_TIMEOUT_MS`).
- **Validation**: `zod` ^3.25.76.
- **Deployment**: distributed as a Kimi Code plugin. Install path is
  `/plugins install https://github.com/cbuntingde/kimi-memory` (or a local
  absolute path). The plugin is not on the Kimi marketplace, so a trust
  prompt appears on install.
- **License**: MIT.

## 5. Test and quality gate

- **Test framework**: `node --test` (built-in Node test runner),
  `--test-reporter=spec`. 34 numbered test files plus `_helpers.js`.
- **Syntax check**: `scripts/check-syntax.js` walks `src/`, `hooks/`, and
  `tests/`, runs `node --check` on every `.js` file, reports failures
  file-by-file. Replaces the previous hand-maintained `&&`-chained list in
  `package.json` (which had drifted out of sync).
- **Formatter**: Prettier ^3.3.0 (`format:check`). `.prettierrc` pins
  two-space indent, single quotes, trailing commas, LF line endings,
  100-column width.
- **Type checker**: none. The plugin is plain JS — types are not enforced
  statically, but Zod schemas at the MCP boundary are the structural
  contract.
- **Linter**: none. Prettier covers formatting; ESLint is intentionally not
  introduced to keep the runtime small.
- **CI gate** (must all pass before merge):
  ```bash
  npm run check         # node --check on every source file
  npm test              # node --test tests/*.test.js
  npm run format:check  # prettier --check .
  ```
- **Test isolation**: tests run against the real MCP server over stdio
  (`StdioMcp` helper in `tests/_helpers.js`). Embedding is mocked by
  `KIMI_MEMORY_EMBEDDINGS=off` (default in the harness); embedding-math
  tests inject hand-crafted vectors directly into the row.
- **Coverage threshold**: not enforced. The contract is per-tool: every
  public MCP tool must have a unit test against `src/persist/` helpers and
  an MCP round-trip test in `tests/05-mcp-protocol.test.js` or a focused
  new file under `tests/NN-*.test.js`. Every new background pass (e.g.
  `runAutoGc` in `src/auto-gc.js`) must add a smoke test that drives the
  pass against a synthetic DB.

## 6. Entry points

A new contributor should open these first:

- `kimi.plugin.json` — the plugin manifest. `interface.longDescription` is
  the agent-facing surface description; update it whenever the public tool
  surface or skill text changes (per `CONTRIBUTING.md`).
- `README.md` — install, environment variables, tool reference, schema, and
  privacy notes.
- `package.json` — engines (Node ≥ 24, npm ≥ 10), bin (`kimi-memory` →
  `src/cli.js`), scripts (`start`, `test`, `check`, `backfill-embeddings`,
  `format:check`).
- `skills/kimi-memory/SKILL.md` — the agent-facing instruction sheet loaded
  at every `SessionStart`. Update this whenever the recall ack contract or
  routing rules change.
- `src/mcp/launcher.js` — the MCP server entry point invoked by
  `mcpServers.kimi-memory.command` in the manifest.
- `src/cli.js` — the standalone CLI entry point (`kimi-memory` bin).
- `src/persist/connection.js` — schema + migrations. `MIGRATIONS` array is
  the single source of truth for `SCHEMA_VERSION = 12`; bump the version
  when an entry is added.
- `hooks/` — eight lifecycle hook scripts (`session-start.js`,
  `user-prompt-submit.js`, `stop.js`, `session-end.js`, `pre-compact.js`,
  `interrupt.js`, `stop-failure.js`, `post-tool-use.js`). Every one must
  fail open.
- `commands/` — five slash-command markdown files (`advisor.md`,
  `list-memories.md`, `memos.md`, `prune.md`, `reset-project.md`).
- `tests/_helpers.js` — `StdioMcp`, `tempDb`, env-var defaults. New tests
  start by importing these.

## 7. Boundary with adjacent systems

| Dependency                                   | Direction     | Contract                                                                                                         | Failure mode                                                                                                                         |
| -------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Kimi Code runtime (hooks)                    | inbound       | Calls hook scripts with a JSON payload on stdin, expects a JSON line on stdout (or non-JSON for legacy).         | Hook script must catch every error and exit 0; a crash blocks the lifecycle.                                                         |
| Kimi Code runtime (MCP)                      | bidirectional | The MCP server is launched by Kimi over stdio per `mcpServers.kimi-memory` in the manifest.                      | Server crash surfaces to Kimi; a `StdioMcp` integration test exercises the full wire in `tests/05-mcp-protocol.test.js`.             |
| `$KIMI_CODE_HOME/kimi-memory/`               | write         | SQLite DBs plus a `_diagnostics/hooks.log`. Writes are per-project-keyed, never lazy on read.                    | Permission denied on the home dir surfaces as a hook-error diagnostic; the hook still exits 0.                                       |
| `agents/main/wire.jsonl`                     | read          | Byte + line cursors; idempotent ingest; tolerant of unknown/malformed records.                                   | Cursor drift is recorded as `conversation_ingest_error` in the diagnostics log; the session is re-ingestable from byte 0 on force.   |
| Hugging Face (transformers hub)              | outbound      | Lazy model download on first embedding call; cached locally.                                                     | Download failure flips `embedding_status` to `failed`; recall falls back to FTS5-only and `memory_similar` returns `[]`.             |
| User-configured LLM provider (`config.toml`) | outbound      | One short call per `Stop` event for auto-extract. Transcript is scrubbed server-side with `redactSecrets` first. | Provider timeout / 5xx surfaces as `auto_extract_error`; the session still ends cleanly. Disable via `KIMI_MEMORY_AUTO_EXTRACT=off`. |

Two outbound calls. Both have opt-outs. No other network behavior.

## 8. Open context

- **Schema is at v12 and may keep moving.** ACL/visibility (`visibility`,
  `shared_with`, `memories_acl` grant table), tier (`L0`–`L3`,
  `persona_id`), wiki (`wiki_pages`, `wiki_links`), codegraph
  (`codegraph_files`, `codegraph_edges`, `codegraph_symbols`), and the
  `skill` memory type landed in v10. Future schema bumps must keep the
  same idempotent-migration contract.
- **Auto-GC / auto-merge shipped in v0.5.1.** Three fail-open passes on
  `SessionStart` (`runAutoPrune`, `runAutoArchive`, `runAutoTier`) plus
  the consolidate pass's auto-merge step. Heavy passes are throttled to
  once per 6 hours per project via `schema_meta(auto_gc_last_run)`. These
  are new — expect tweaks as edge cases (orphan edges, persona promotion
  during archive windows) surface in production.
- **`src/persist.js` is a 6-line barrel.** New code should import from
  `./persist/<topic>.js` directly (`memories`, `search`, `edges`, `reinforce`,
  `share`, `skills`, `project`); the top-level barrel exists so older
  call sites keep working byte-identical.
- **Two outbound behaviors are the only allowed ones.** Anything that
  reaches the network (telemetry, model upload, crash reporting, feature
  ping) needs an explicit `[kimi-memory] <flag> = true` opt-in plus a
  README call-out before it lands.
