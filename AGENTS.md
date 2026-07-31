# AGENTS

Operating notes for human and AI contributors working in this repo.

## Subsystems

Two subsystems live in this plugin since the 2026-07-31 merge:

1. **Memory** — three-layer durable store (global user, per-project durable
   - working, per-project session archive) exposed via the `kimi-memory` MCP
     server. 23 tools.
2. **Advisor** — keyword detection on `UserPromptSubmit` plus the
   `advisor` skill (anchored recommendation procedure). Zero runtime deps;
   pure ESM + stdlib.

The advisor subsystem shares this plugin's hooks (`src/hooks/run.js` calls
`matchAdvisor` on every UserPromptSubmit after the memory recall pass).

## Layout

- `src/` — runtime modules. `persist.js` owns SQLite (schema + migrations + CRUD),
  `wire.js` owns `wire.jsonl` parsing, `server.js` owns MCP tool wiring,
  `validation.js` is shared input validation, `util.js` is shared helpers,
  `extract.js` runs the auto-extraction LLM call, `backfill.js` rebuilds
  embeddings for older rows, `embedding.js` wraps the MiniLM encoder.
- `src/mcp/main.js` — stdio entry point for the MCP server.
- `src/hooks/run.js` — single Node script consumed by every hook entry in
  `hooks/`. The hooks directory only contains thin wrappers that set
  `KM_HOOK_EVENT` and import the runner. Memory recall runs first; advisor
  detection runs after and appends a second status line on match. The
  Stop-family handlers (`Stop`, `SessionEnd`, `PreCompact`, `Interrupt`,
  `StopFailure`) all delegate to `handleStop`, which runs the auto-extract
  LLM call after the idempotent ingest pass.
- `src/advisor/detect.js` — frozen keyword list + `matchAdvisor(prompt)`
  - `logAdvisorDiag(msg)`. Writes to
    `<plugin-root>/_diagnostics/advisor-hooks.log`.
- `hooks/` — one tiny entry script per lifecycle event.
- `tests/` — `node --test` files; `_helpers.js` provides the temp-home +
  stdio-MCP harness.
- `skills/` — Kimi-side Skill definitions. `skills/kimi-memory/SKILL.md` is
  auto-loaded at SessionStart (`sessionStart.skill: "kimi-memory"` in the
  manifest); `skills/list_memories/SKILL.md` and `skills/advisor/SKILL.md`
  are loaded on demand via `/list_memories`, `/advisor`, or skill reference.
- `commands/` — Kimi-side slash commands. `list-memories.md`, `advisor.md`,
  `memos.md` (the last one opens kimi-memos-dashboard in the browser).
- `ai-install.md` — agent-facing install procedure. The URL
  `https://raw.githubusercontent.com/cbuntingde/kimi-memory/main/ai-install.md`
  is the recommended paste-into-Kimi input; the agent fetches it and
  runs every step end-to-end.
- `uninstall.md` — the inverse: removes the install record, the
  managed copy, and (optionally) every memory database plus the
  embedding model cache. Documented in six numbered steps so a user or
  an agent can drive the full teardown.

## Commands

```bash
npm install
npm run check        # node --check on every source file
npm test             # node --test tests/*.test.js
npm run format:check # prettier --check on every tracked file
npm run backfill-embeddings   # rebuild embeddings for older rows
```

## Hard conventions

- **Project keys are SHA-256 prefixes of canonicalised project roots.**
  `canonicalizeRoot` normalises Windows drive letters and rejects anything
  non-absolute. Never derive a project key from anywhere except this function.
- **`_global` is a literal `project_key` value** (`GLOBAL_PROJECT_KEY` in
  `project-key.js`). It is intentionally not a hex hash so existing
  per-project queries never accidentally hit the global database. Don't
  collapse it into the hashed scheme.
- **Per-project isolation is non-negotiable.** Every read, write, and
  delete goes through a target db opened with `openScopeDb` so the
  `project_key` column is always set. Adding a tool that bypasses this
  is a bug.
- **Schema migrations live in `MIGRATIONS` in `persist.js`.** They run
  idempotently on every `openDb`. To bump the schema, append a new
  idempotent function and bump `SCHEMA_VERSION`. They never depend on
  `SCHEMA_VERSION` themselves.
- **Hooks fail open.** Any uncaught error logs to `_diagnostics/hooks.log`
  (sibling of the plugin's `src/` — `path.resolve(import.meta.dirname, '..', '..', '_diagnostics')`)
  and exits 0 so Kimi's lifecycle is never blocked by the plugin. The
  per-event `timeout` is declared in `kimi.plugin.json` (currently
  10/10/15/15/5/5/5 seconds for SessionStart/UserPromptSubmit/Stop/
  SessionEnd/PreCompact/Interrupt/StopFailure); hooks release cached
  SQLite handles before `process.exit(0)` so WAL writes flush within
  the budget.
- **Hooks never echo memory bodies, raw prompts, or transcripts on
  stdout.** Status line + bounded summary only.
- **Secrets are never persisted.** `memory_save` and `memory_save_bulk`
  accept anything, but agents must not pass API keys, tokens, passwords,
  `.env` contents, or PII. The SKILL.md hygiene section makes this
  explicit; the persist layer does not enforce it.

## Testing

Tests spawn the real MCP server over stdio and use `KIMI_CODE_HOME`
pointed at a temp directory, so they exercise the same code path the
agent does. New tools should add both a unit test (against `persist.js`
directly) and an MCP-level test in `tests/05-mcp-protocol.test.js`.

Run a single test file:

```bash
node --test tests/02-persist.test.js
```

## Style

- Plain ESM, no transpile step.
- Two-space indent, single quotes, trailing commas in multi-line lists.
- No new runtime dependencies without a serious reason; the plugin
  already uses `@modelcontextprotocol/sdk`, `@huggingface/transformers`,
  and `zod`.
- Keep modules small; cross-module boundaries map to the files above.
- The advisor subsystem has no runtime deps on its own; its detection
  logic is pure-string and its diagnostics writer uses `node:fs`.
