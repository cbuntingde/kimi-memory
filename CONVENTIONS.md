# CONVENTIONS.md — kimi-memory

How this codebase is written. PROJECT.md is the operating contract; this file is
the working contract — the rules every code change has to honor. Future
craftsman passes (`critique`, `audit`, `polish`, …) load this first when they
review a diff. Get it wrong and they'll fight the codebase instead of fixing it.

## 1. Language and format

- **JavaScript only.** Plain ESM, no transpilation, no TypeScript, no JSX.
  Engine constraint: `engines.node >= 24.0.0`, `engines.npm >= 10.0.0`
  (`package.json:8-11`). Type safety at the MCP boundary is enforced with
  Zod schemas; nothing static.
- **Line endings:** LF. Final newline mandatory. Trim trailing whitespace,
  except in `.md` (`/dev/null/file.editorconfig:14`).
- **Indent:** two spaces. Single quotes. Trailing commas in multi-line lists.
  Semicolons. `printWidth = 100`, `arrowParens = always` (`package.json:28`
  via `prettier --check`).
- **Run `npm run format:check` before commit.** `npm run check` runs
  `scripts/check-syntax.js` which walks `src/`, `hooks/`, and `tests/` and
  runs `node --check` on every `.js` file.

## 2. Module layout

- **`src/`** holds the runtime. Each file is one concern; cross-module
  boundaries map to files. The current top-level layout:
  `acl.js`, `auto-gc.js`, `backfill.js`, `cli.js`, `codegraph.js`,
  `codegraph.js`, `consolidate.js`, `decay.js`, `diagnostics.js`,
  `embedding.js`, `extract.js`, `lifecycle.js`, `performance.js`,
  `project-key.js`, `prune.js`, `retry.js`, `search.js`, `server.js`,
  `session-focus.js`, `toml.js`, `tool-registry.js`, `util.js`,
  `validation.js`, `wiki.js`, `wire.js`, `work-log.js`; plus subdirs
  `advisor/`, `hooks/`, `mcp/`, `persist/`, `proxy/`.
- **`src/persist/`** holds all SQLite work. One module per topic:
  `connection.js`, `memories.js`, `search.js`, `edges.js`, `reinforce.js`,
  `share.js`, `skills.js`, `project.js`, `index.js`, `re-exports.js`. New
  persistence code imports from `./persist/<topic>.js` directly;
  `src/persist.js` is a six-line barrel kept for older call-sites
  (`CONTRIBUTING.md:36-38`).
- **`hooks/`** holds the eight lifecycle scripts (`session-start.js`,
  `user-prompt-submit.js`, `stop.js`, `session-end.js`, `pre-compact.js`,
  `interrupt.js`, `stop-failure.js`, `post-tool-use.js`). Every one is a
  standalone Node process, reads JSON from stdin, writes JSON to stdout,
  and must fail open (`PROJECT.md:3.5`, `CONTRIBUTING.md:86-91`).
- **`commands/`** holds five slash-command markdown files (`advisor.md`,
  `list-memories.md`, `memos.md`, `prune.md`, `reset-project.md`).
- **`skills/`** holds `kimi-memory/SKILL.md` — the agent-facing
  instruction sheet loaded at every `SessionStart`. Update whenever the
  recall-ack contract, hooks contract, or routing rules change
  (`CONTRIBUTING.md:4-6`, `20-24`).
- **`tests/`** holds 34 `tests/*.test.js` files plus `tests/_helpers.js`,
  all running under `node --test`. New tests start by importing from
  `tests/_helpers.js` (`StdioMcp`, `tempDb`, env-var defaults).

## 3. Imports and exports

- **ESM imports only.** `import { x } from './y.js'` — explicit `.js`
  extension on every relative path (Node ESM requirement).
- **No circular imports.** The `src/persist/` modules re-export through
  `index.js` / `re-exports.js` so import paths stay acyclic.
- **Named exports preferred.** Default exports are reserved for the
  single-purpose entry points (`src/cli.js`, `src/mcp/launcher.js`).
- **JSDoc on every exported function.** Style of `src/acl.js:29-39`:
  paragraph description of what and why, then `@param` / `@returns` only
  when the signature is non-trivial. No `@typedef` walls.

## 4. Comment density

- **Comments explain _why_, not _what_.** The code shows what; comments
  explain the constraint, the failure mode, or the source-of-truth
  citation (`CONTRIBUTING.md:39`).
- **Top-of-file block** on every module ≥ 60 lines: one paragraph
  describing purpose, a "boundary with" line listing what the module
  does not touch (network, embedding, etc.), and references to related
  modules by path. `src/acl.js:1-11` is the canonical example.
- **No commented-out code blocks.** Delete or restore. A diff is not a
  museum.

## 5. Error handling

- **Hooks fail open.** Wrap the whole script body in `try/catch`, log to
  `$KIMI_CODE_HOME/kimi-memory/_diagnostics/hooks.log`, exit 0.
  Background passes (`runAutoGc` and friends in `src/auto-gc.js`,
  `runAutoPrune` / `runAutoArchive` / `runAutoTier`) inherit this
  contract — wrap each pass so a single hiccup does not abort the rest
  of `SessionStart` (`PROJECT.md:3.2`, `CONTRIBUTING.md:87-91`).
- **MCP tools fail loud.** Throw a Zod error or a typed `Error` with a
  message that names the invalid field and the valid options —
  `src/acl.js:34-39` is the pattern: `invalid visibility: <v> (must be
one of: <list>)`.
- **No empty `catch (e) {}` blocks.** Either log with context, re-throw,
  or write a one-line comment explaining the justified discard.
- **No silent `value ?? default` fallbacks.** A fallback must equal "this
  is the documented no-op state", not "this is what we wish was true."
  See `src/acl.js:34-40` for the documented-default pattern that catches
  `undefined` and `''` both, returning `'private'`.
- **Two-outbound rule.** The only network behaviors are the
  `@huggingface/transformers` model download (lazy, cached) and the
  Stop-hook auto-extract LLM call (transcript scrubbed server-side via
  `redactSecrets`). Anything else needs an explicit opt-in
  (`PROJECT.md:3.7`, `7 Boundary`).

## 6. Persistence — schema and migrations

- **`SCHEMA_VERSION` in `src/persist/connection.js`** is bumped on every
  migration. Current value: `11`.
- **`MIGRATIONS` is an ordered array** of idempotent functions
  (`CONTRIBUTING.md:42-50`). Each entry probes the live schema and
  no-ops when the target shape is already in place.
- **Adding a column:** `PRAGMA table_info(<table>)` probe → `ALTER TABLE
… ADD COLUMN <col> <type>`. Existing rows must survive the bump
  without a manual step.
- **Adding a table:** `CREATE TABLE IF NOT EXISTS`. No
  drop-and-recreate; that breaks cross-version `connection.js` reads.
- **Per-DB config** belongs in `schema_meta(key, value)`. The
  `auto_gc_last_run` throttle stamp lives there too. Never a sidecar
  file or a `memory.metadata` field (`CONTRIBUTING.md:53-55`).
- **Per-tool tests:** every new persistence helper gets a unit test
  against `src/persist/` plus an MCP round-trip test in
  `tests/05-mcp-protocol.test.js` or a focused new file
  (`CONTRIBUTING.md:65-68`).

## 7. MCP surface

- **46 tools** registered through `src/tool-registry.js`. Adding a tool
  means new Zod schema, new server dispatch, new unit test, and new
  round-trip test — and a `skills/kimi-memory/SKILL.md` plus
  `kimi.plugin.json.interface.longDescription` update
  (`CONTRIBUTING.md:19-24`).
- **Identity columns are not accepted on the tool surface.** The MCP
  server has no authenticated caller, so `memory_save`,
  `memory_update`, and `memory_save_bulk` drop `team_id`,
  `agent_id`, `user_id`, `session_id`, and `task_id` from their
  input shape. The columns are persisted by the hook layer
  (which observes the running session principal) and reserved for
  future signed-token auth. Trying to set identity through the MCP
  surface is by design a no-op.
- **Per-write validation.** `looksLikeSecret` in `src/extract.js`
  means new Zod schema, new server dispatch, new unit test, and new
  round-trip test — and a `skills/kimi-memory/SKILL.md` plus
  `kimi.plugin.json.interface.longDescription` update
  (`CONTRIBUTING.md:19-24`).
- **Per-write validation.** `looksLikeSecret` in `src/extract.js`
  covers `title`, `content`, every `tags` entry, and every string value
  in `metadata` (recursively). Every write path inherits the check:
  `memory_save`, `memory_update`, `memory_merge`, `memory_save_bulk`,
  auto-extract. Opt-out: `KIMI_MEMORY_SECRET_SCAN=off` — fixtures only
  (`CONTRIBUTING.md:72-82`).
- **Status line and recall output.** The hook stdout is bounded; per-
  memory lines live in
  `hookSpecificOutput.additionalContext` (numbered list, top 3 hits,
  body snippet capped at 120 chars). The verbose `[recall: i/N]`
  style was retired in v0.5.1; do not regress it
  (`CONTRIBUTING.md:83-86`).
- **Proxy CORS allowlist.** `KIMI_MEMORY_PROXY_CORS_ORIGINS` (default
  unset) is a comma-separated origin allowlist. The HTTP proxy
  reflects each request's `Origin` only when it is in the allowlist;
  the default is no `Access-Control-Allow-Origin` header at all.
  Set this when a dashboard or browser-side agent must call the
  proxy cross-origin with the bearer token.

## 8. Concurrency and idempotence

- **`openDb` is the only writer handle.** `src/persist/connection.js`
  opens SQLite once per process; long-lived hook processes reuse it.
- **Session ingest is byte-cursor based.** `src/wire.js` records both
  byte and line cursors; re-ingest must be idempotent. Cursor drift is
  logged as `conversation_ingest_error` to `_diagnostics/hooks.log`,
  not thrown (`PROJECT.md:3.6`).
- **Background passes are throttled.** Throttle stamp in
  `schema_meta('auto_gc_last_run', <iso>)`; once per 6 hours per
  project. Reading the stamp is cheaper than re-running the pass.

## 9. Tests

- **Test framework:** `node --test --test-reporter=spec` (`package.json:17`).
- **Real MCP, real SQLite.** `tests/_helpers.js` ships a `StdioMcp` that
  spawns the server (`src/mcp/launcher.js`) over stdio and round-trips
  every tool. No mocks of the wire protocol.
- **Embedding mocked at the boundary, not in the math.**
  `KIMI_MEMORY_EMBEDDINGS=off` is the harness default; tests that need
  cosine math inject hand-crafted vectors into the row, not at the
  encoder (`CONTRIBUTING.md:60-63`).
- **Per-tool coverage:**
  - Unit test against `src/persist/` helper.
  - MCP round-trip test (in `tests/05-mcp-protocol.test.js` or a
    focused new file).
  - Smoke test for new background passes (drives the pass against a
    synthetic DB end-to-end).
- **No coverage threshold.** Quality is per-tool, per-pass, per-hook.

## 10. Versioning and release

- **Source of truth for version:** `package.json:3` and
  `kimi.plugin.json:3`. They must match exactly. `package-lock.json`
  pins the lock state (`CONTRIBUTING.md:113-114`).
- **Surface-change protocol.** Adding a tool, a column, or a hook
  requires updating:
  1. `README.md` — env-var table and tool reference.
  2. `skills/kimi-memory/SKILL.md` — agent-facing instruction sheet.
  3. `kimi.plugin.json` — `interface.longDescription`.
  4. The matched tests — `tests/04-hooks.test.js` if recall output,
     `tests/13-recall-per-type.test.js` if per-type counts,
     `tests/05-mcp-protocol.test.js` if a new tool.
- **Schema-change protocol.** Bump `SCHEMA_VERSION` in
  `src/persist/connection.js`. Append an idempotent migration to
  `MIGRATIONS`. Existing rows must survive without a manual step
  (`CONTRIBUTING.md:25-28`).
- **CI gate:** `npm run check`, `npm test`, `npm run format:check` —
  all three must pass before merge (`CONTRIBUTING.md:12-17`).

## 11. Forbidden patterns (project-specific)

The craft skill's absolute bans are always in force. Project-specific
clarifications:

- **`Math.random()` is never a memory id source.** Memory ids are
  generated deterministically in `src/persist/memories.js` (sha-256
  prefix or similar). Hand-rolled id logic at a call site is wrong.
- **No new runtime dependencies without a written reason in the PR.**
  The `@huggingface/transformers` footprint already pushes the plugin
  to ~50 MB on disk (`CONTRIBUTING.md:34-35`).
- **No `node_modules` work.** Don't traverse `node_modules` for
  context, don't add it as a target. Embedding smoke tests inject
  vectors at the row level, not from the encoder.
- **No Kimi write access to `agents/main/wire.jsonl`.** Read-only —
  `src/wire.js` parses it, never modifies it (`PROJECT.md:3.5`,
  `7 Boundary`).
- **No lazy creation of the global DB.** `memory_recall` /
  `memory_list` / `memory_status` over `scope: 'global'` against a
  fresh install must not create any files. Only write paths create
  the file (`PROJECT.md:3.4`).

## 12. Quick checklist before commit

1. `npm run check` — `node --check` on every `.js` file under `src/`,
   `hooks/`, `tests/`.
2. `npm test` — all 34 test files pass.
3. `npm run format:check` — Prettier clean.
4. New persistence helper → unit test added.
5. New MCP tool → MCP round-trip test added.
6. New schema column / table → migration entry, `SCHEMA_VERSION`
   bumped.
7. New env var → `CONTRIBUTING.md` table + `README.md` env vars
   section + matched tests.
8. Recall-output change → `skills/kimi-memory/SKILL.md` "Memory
   recall and acknowledgement" section updated.
9. AGENTS.md / README / manifest / SKILL all in sync with the
   surface.
