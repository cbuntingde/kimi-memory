# Contributing to kimi-memory

This plugin is plain ESM, no transpilation step. The full suite (npm test) runs in
a few seconds because tests opt out of the embedding model download via
`KIMI_MEMORY_EMBEDDINGS=off` in `tests/_helpers.js`.

## Workflow

1. Branch off `main`.
2. `npm install` if you have not already.
3. Make the change in `src/` and add or update a test under `tests/`.
4. Run the checks locally — they run in CI and PRs will not merge with red:
   ```bash
   npm run check         # node --check on every source file
   npm test              # node --test tests/*.test.js
   npm run format:check  # prettier --check .
   ```
5. If you change the public surface (new tool, new column, new env var), update
   `README.md`, `skills/kimi-memory/SKILL.md`, and the manifest's `longDescription`
   in `kimi.plugin.json` so the agent still knows the surface.
6. If you change the recall output format (`[recall: i/N]` lines), update the
   `Memory recall and acknowledgement` section of `skills/kimi-memory/SKILL.md`
   and the test that asserts it (`tests/13-recall-per-type.test.js`).
7. If you change the SQLite schema, append an idempotent migration to
   `MIGRATIONS` in `src/persist.js` and bump `SCHEMA_VERSION`. Existing rows must
   survive the migration without a manual step.

## Code style

- Two-space indent, single quotes, trailing commas in multi-line lists.
- No new runtime dependencies without a written reason in the PR — the
  plugin is already ~50 MB on disk with `@huggingface/transformers`.
- Keep modules small. Cross-module boundaries map to the files in `src/`.
- Comments explain _why_, not _what_ — the code itself shows what.

## Schema migrations

The `MIGRATIONS` array in `src/persist.js` is the single source of truth. Each
entry is an idempotent function: it inspects the live schema, no-ops when the
target shape is already in place, and mutates otherwise. New columns go in via
`ALTER TABLE … ADD COLUMN` after a `PRAGMA table_info` probe. New tables use
`CREATE TABLE IF NOT EXISTS`.

`SCHEMA_VERSION` is bumped when a new entry is added. The migrations themselves
never depend on the version number — they just run in order on every `openDb`.

## Tests

- Use the real MCP server over stdio (see `StdioMcp` in `tests/_helpers.js`).
- Use the real SQLite engine — `node:sqlite` is the production driver.
- Mock the embedding model by setting `KIMI_MEMORY_EMBEDDINGS=off` (the default
  in the test harness). Tests that need embedding math inject hand-crafted
  vectors directly into the row.
- New tools should add both a unit test against `persist.js` helpers and an MCP
  round-trip test in `tests/05-mcp-protocol.test.js` or a focused new file
  under `tests/NN-*.test.js`.

## Hygiene

- Never store secrets, API keys, `.env` contents, or PII. The
  `looksLikeSecret` helper in `src/extract.js` is the auto-extract safety net;
  the `memory_save` tool deliberately does not enforce it (callers are trusted).
- Never echo memory bodies or raw prompts on hook stdout. The status line is
  bounded; per-memory lines (`[recall: i/N]`) are bounded to 3.
- Hooks must fail open. Any uncaught error logs to `_diagnostics/hooks.log` and
  exits 0 so Kimi's lifecycle is never blocked by the plugin.

## Releases

`AGENTS.md` is the source of truth for the plugin's surface; keep it in sync.
The manifest's `version` field is the source of truth for the release version
(it must match `package.json` and `package-lock.json`).
