# AGENTS

Operating notes for human and AI contributors working in this repo.

## Subsystems

Two subsystems live in this plugin since the 2026-07-31 merge:

1. **Memory** — three-layer durable store (global user, per-project durable
   - working, per-project session archive) exposed via the `kimi-memory` MCP
     server. 24 tools, including `memory_prune` for orphan-project cleanup,
     `memory_save_bulk` for atomic batch save, and `memory_conclusions_for`
     / `memory_parents` for the higher-order `conclusion` type. A small
     `src/cli.js` exposes the same data via `node src/cli.js …` for ops
     debugging without spinning up MCP.
2. **Advisor** — keyword detection on `UserPromptSubmit` plus the
   `advisor` skill (anchored recommendation procedure). The keyword
   detector now applies a per-sentence negation gate so prompts like
   "I wouldn't change anything here" do not fire. Zero runtime deps;
   pure ESM + stdlib.

The advisor subsystem shares this plugin's hooks (`src/hooks/run.js` calls
`matchAdvisor` on every UserPromptSubmit after the memory recall pass).

## Layout

- `src/` — runtime modules. `persist.js` owns SQLite (schema + migrations + CRUD),
  `wire.js` owns `wire.jsonl` parsing, `server.js` owns MCP tool wiring,
  `validation.js` is shared input validation, `util.js` is shared helpers,
  `extract.js` runs the auto-extraction LLM call (with secret-scrubbing
  on the candidates), `backfill.js` rebuilds embeddings for older rows,
  `embedding.js` wraps the MiniLM encoder, `cli.js` is the standalone
  ops CLI (list / get / status / recall / prune). Schema is v8:
  - v6: `project_paths` table that records the canonical project root
    for each project DB so `memory_prune` can detect orphans.
  - v7: `last_embed_error` column on `memories` so a failed embedding
    pass is observable via `rowToMemory.embedding_status: 'failed'`
    instead of staying `pending` forever.
  - v8: `last_canonical_root` + `record_count` on `project_paths` so
    a project that moved is recorded with a move history (the prior
    canonical root is preserved on re-record).
- `src/mcp/main.js` — stdio entry point for the MCP server.
- `src/hooks/run.js` — single Node script consumed by every hook entry in
  `hooks/`. The hooks directory only contains thin wrappers that set
  `KM_HOOK_EVENT` and import the runner. Memory recall runs first; the
  recall summary now breaks down the hit count per memory type
  (`[semantic: 2, procedural: 1]`) and emits up to three
  `[recall: i/N] "title" (type, scope, score=…) — <body snippet>`
  lines so the user can see which memories surfaced _and_ verify the
  body matched the title. The snippet is the first non-empty line of
  the memory's content, capped at 120 chars, with internal whitespace
  squeezed onto one line. Advisor detection runs after and
  appends a second status line on match. The Stop-family handlers
  (`Stop`, `SessionEnd`, `PreCompact`, `Interrupt`, `StopFailure`) all
  delegate to `handleStop`, which runs the auto-extract LLM call after
  the idempotent ingest pass.
- `src/advisor/detect.js` — frozen keyword list + `matchAdvisor(prompt)`
  (with per-sentence negation gating) + `logAdvisorDiag(msg)`. Writes
  to `<plugin-root>/_diagnostics/advisor-hooks.log`.
- `hooks/` — one tiny entry script per lifecycle event.
- `tests/` — `node --test` files; `_helpers.js` provides the temp-home +
  stdio-MCP harness. `tests/13-recall-per-type.test.js` covers the
  new behaviors (per-type recall, threshold, secret scrubbing,
  memory_save_bulk error collection, advisor negations, CLI).
- `skills/` — Kimi-side Skill definitions. `skills/kimi-memory/SKILL.md` is
  auto-loaded at SessionStart (`sessionStart.skill: "kimi-memory"` in the
  manifest); `skills/list_memories/SKILL.md` and `skills/advisor/SKILL.md`
  are loaded on demand via `/list_memories`, `/advisor`, or skill reference.
  The `Memory recall and acknowledgement` section of
  `skills/kimi-memory/SKILL.md` instructs the agent to acknowledge
  recalled memories by name in its reply.
- `commands/` — Kimi-side slash commands. `list-memories.md`, `advisor.md`,
  `memos.md` (the last one opens kimi-memos-dashboard in the browser),
  `prune.md` (calls `memory_prune` after a dry-run review).
- `assets/` — `icon.svg` (the plugin's display icon) + `README.md`.
- `ai-install.md` — agent-facing install procedure. The URL
  `https://raw.githubusercontent.com/cbuntingde/kimi-memory/main/ai-install.md`
  is the recommended paste-into-Kimi input; the agent fetches it and
  runs every step end-to-end.
- `uninstall.md` — the inverse: removes the install record, the
  managed copy, and (optionally) every memory database plus the
  embedding model cache. Documented in six numbered steps so a user or
  an agent can drive the full teardown.
- `CONTRIBUTING.md` — workflow, style, schema-migration rules, and
  test conventions for new tools and migrations.

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
  is a bug. Write tools use `openScopeDbForWrite` (which records the
  canonical root into `project_paths`); read tools use `openScopeDb`
  without recording so a recall on a slow network share does not pay
  a write per call.
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
- **Hooks never echo full memory bodies, raw prompts, or transcripts on
  stdout.** Status line + bounded per-type breakdown + up to three
  `[recall: i/N]` lines (title + a one-line body snippet, capped at
  120 chars per snippet). Full bodies are pulled by the agent via
  `memory_recall` when the snippet is not enough.
- **Recall is type-balanced by default.** The `UserPromptSubmit` hook
  calls `searchMemories` with `perType: true` so the agent sees a mix
  of memory types (conventions, procedures, working notes) rather than
  the top-N of one type. A relevance threshold of 0.2 on the combined
  FTS+vector score keeps marginal matches out of the recall.
- **Secrets are never persisted.** `saveMemory` (the lowest layer
  every write path funnels through) runs `looksLikeSecret` on the new
  title and content and throws `KIMI_MEMORY_SECRET_DETECTED` if either
  matches a known credential shape (OpenAI, Anthropic, GitHub, AWS,
  JWT, PEM, `key=…` assignments, or `Authorization: Bearer` headers).
  The error is surfaced verbatim by `memory_save` and `memory_save_bulk`
  (the whole bulk batch rolls back), and applies equally to
  `memory_update` and `memory_merge` since both go through
  `saveMemory`. The check is opt-out via `KIMI_MEMORY_SECRET_SCAN=off`
  for the rare case where a user genuinely needs to persist a
  secret-shaped string (e.g. an example fixture). Auto-extract
  (`runAutoExtract`) keeps its own pre-screen so the rule is enforced
  at least twice on that path; that duplication is intentional.

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
