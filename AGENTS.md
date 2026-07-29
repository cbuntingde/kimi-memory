# AGENTS

Operating notes for human and AI contributors working in this repo.

## Layout

- `src/` — runtime modules. `persist.js` owns SQLite (schema + migrations + CRUD),
  `wire.js` owns `wire.jsonl` parsing, `server.js` owns MCP tool wiring,
  `validation.js` is shared input validation, `util.js` is shared helpers.
- `src/mcp/main.js` — stdio entry point for the MCP server.
- `src/hooks/run.js` — single Node script consumed by every hook entry in
  `hooks/`. The hooks directory only contains thin wrappers that set
  `PM_HOOK_EVENT` and import the runner.
- `hooks/` — one tiny entry script per lifecycle event.
- `tests/` — `node --test` files; `_helpers.js` provides the temp-home +
  stdio-MCP harness.
- `skills/` and `commands/` — Kimi-side Skill and slash-command definitions.

## Commands

```bash
npm install
npm run check   # node --check on every source file
npm test        # node --test tests/*.test.js
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
  and exits 0 so Kimi's lifecycle is never blocked by the plugin. The
  8-second hard timeout releases cached SQLite handles before
  `process.exit(0)` so WAL writes flush.
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
  already uses `@modelcontextprotocol/sdk` and `zod`.
- Keep modules small; cross-module boundaries map to the files above.