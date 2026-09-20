# Contributing

## Quick start

```bash
git clone https://github.com/cbuntingde/kimi-memory
cd kimi-memory
npm install
npm test                 # full suite, embeddings off (~25s)
npm run check            # node --check on every source file
npm run format:check     # prettier --check
```

Tests use a temp directory under `os.tmpdir()` per test, so the suite
leaves nothing behind. Embedding is off by default in `tests/_helpers.js`
to keep CI fast.

## Code style

- 2-space indent, double-quoted strings, ESM `import`/`export`.
- `prettier --check` is the formatting gate.
- `node --check` (via `npm run check`) is the syntax gate.
- Comments explain _why_, not _what_. The codebase has a long history of
  `(Audit fix …)` and `(Audit finding …)` markers — preserve them.
- No mock or stub logic on production paths. Test-only stubs go behind
  `_setPipelineStubForTests` style seams (see `src/embedding.js`).

## Layout

- `src/persist/` — SQLite, schema migrations, row-level helpers. The
  `connection.js` file owns the schema.
- `src/server.js` — MCP server wiring. Tool definitions live in
  `src/mcp/tool-defs.js`; each registration lives in a per-domain
  module under `src/mcp/handlers/` and is wired up with
  `registerTool(server, D.<name>, …)`.
- `src/hooks/` — lifecycle hooks. The dispatcher in `run.js` is small;
  per-event handlers live in `src/hooks/handlers/`.
- `src/cli.js` — standalone CLI. Mirrors the MCP tool surface where it
  makes sense.
- `src/<subsystem>.js` — feature modules (acl, codegraph, consolidate,
  decay, dream, session-focus, etc.).
- `tests/NN-<name>.test.js` — number-prefixed so they sort in the order
  they were added.

## Schema changes

1. Add a new idempotent migration function to the `MIGRATIONS` array in
   `src/persist/connection.js`.
2. Probe-before-rebuild: read `sqlite_master.sql` to detect whether
   your migration has already been applied; only rebuild when the
   shape is wrong. Re-runs must be no-ops.
3. Bump `SCHEMA_VERSION`. Add a one-line note in the migration comment
   naming the phase that introduced it (v10, v11, …).
4. Update the relevant `tests/NN-*.test.js` so the new shape is covered
   by an existing case, or add a new case file.
5. The migration must be additive for at least one minor version before
   any hard-delete can land.

## Adding an MCP tool

1. Add a new entry to `TOOL_DEFS` in `src/mcp/tool-defs.js`.
2. Register the handler in the matching per-domain module under
   `src/mcp/handlers/` with `registerTool(server, D.<name>, …)`.
3. Use Zod for input validation (`z.enum`, `z.string`, `z.number().min()
.max()`).
4. Declare `cwd` in the Zod schema whenever the handler touches a
   project database. `registerTool` reads the schema: a tool that
   declares `cwd` gets `resolveProjectRoot(args.cwd)` and is refused
   when `!pr.ok`; a tool that does not (see `memory_diagnostics`) is
   registered with `skipDb: true` and opens no database.
5. Wrap the handler in `try { … } catch (e) { return textError(...); }`.
   The wrapper already routes the message through `safeErrorMessage`,
   so do not build a path-bearing error string by hand.
6. Add the tool name to `kimi.plugin.json`'s `interface.longDescription`
   so the plugin manifest matches the runtime surface.
7. Write a focused test in a new or existing `tests/NN-*.test.js`.

## Adding an environment variable

1. Decide the default (most opt-outs default `on` for the feature).
2. Read it at the call site, or in the module that owns the feature if
   it is a cross-cutting toggle.
3. Document it in the README's `## Configuration` table and in the
   environment-variable table in `AGENTS.md`.
4. Test the off path. See `tests/14-secret-block.test.js` for the
   `KIMI_MEMORY_SECRET_SCAN` shape.

## Hook changes

- `src/hooks/run.js` is the dispatcher. Do not add event-specific
  logic to it; route through `src/hooks/handlers/<event>.js`.
- New event? Add a handler file, register it in the `HANDLERS` map, and
  add an entry in `kimi.plugin.json`'s `hooks` array with a sensible
  `timeout` (10s for `SessionStart`, 15s for `Stop`/`SessionEnd`, 5s
  for the rest).
- Hooks are fail-open: any caught exception must log via `logHookDiag`
  and exit 0 so Kimi isn't blocked.

## Submission

1. Fork + branch off `main`.
2. Open a pull request. The CI pipeline runs `npm run check`,
   `npm run format:check`, and `npm test` on `ubuntu-latest` and
   `windows-latest` with Node 24. All three must be green.
3. Reference any open issue the PR closes.
4. Keep PRs scoped. One feature per PR; one refactor per PR. A 2000-
   line PR is a sign the scope needs splitting.

## Code of conduct

Standard: be useful, be brief, leave the codebase cleaner than you
found it.
