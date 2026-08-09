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
  `looksLikeSecret` helper in `src/extract.js` is the auto-extract safety
  net, **and** `saveMemory` in `src/persist.js` runs the same check at
  the lowest layer so `memory_save`, `memory_update`, `memory_merge`,
  and `memory_save_bulk` all inherit it. The check covers `title`,
  `content`, every `tags` entry, and every string value in `metadata`
  (recursively). It throws `KIMI_MEMORY_SECRET_DETECTED` and the call
  rolls back; the only opt-out is `KIMI_MEMORY_SECRET_SCAN=off`,
  reserved for the rare fixture case. False positives are accepted: dropping a candidate that
  mentions a generic `api_key` is far cheaper than persisting a real one.
- Never echo full memory bodies or raw prompts on hook stdout. The status
  line is bounded; per-memory lines (`[recall: i/N]`) are bounded to 3,
  each line carries a body snippet capped at 120 chars so the user can
  verify the recall without a second round-trip.
- Hooks must fail open. Any uncaught error logs to `_diagnostics/hooks.log` and
  exits 0 so Kimi's lifecycle is never blocked by the plugin.

## Environment variables (test-time overrides)

| Variable                       | Default | Effect                                                                                                          |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------- |
| `KIMI_MEMORY_EMBEDDINGS`       | `on`    | Set to `off` to skip the encoder (the `_helpers.js` default for the test suite).                                |
| `KIMI_MEMORY_EMBED_TIMEOUT_MS` | `4000`  | Wall-clock cap on a single `embedText` call. Tests that want to exercise the timeout set this to a small value. |
| `KIMI_MEMORY_AUTO_EXTRACT`     | `on`    | Set to `off` to skip the Stop-hook auto-extract LLM call.                                                       |
| `KIMI_MEMORY_SECRET_SCAN`      | `on`    | Set to `off` to bypass the persist-layer secret check (use only for fixtures).                                  |
| `KIMI_MEMORY_PERF`             | `on`    | Set to `off` to skip the 5k-corpus perf benchmarks in `tests/16-perf.test.js`.                                  |

## Releases

`AGENTS.md` is the source of truth for the plugin's surface; keep it in sync.
The manifest's `version` field is the source of truth for the release version
(it must match `package.json` and `package-lock.json`).
