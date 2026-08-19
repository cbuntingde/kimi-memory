# kimi-memory

A local-first Kimi Code plugin that gives the agent a three-layer memory
store — cross-project user memory, per-project durable + working memory,
and per-project session archives — exposed through MCP tools, lifecycle
hooks, and slash commands. Also includes an integrated advisor subsystem
for reflective prompts.

<p align="center">
  <img src="assets/demo-list-calls.png" alt="Kimi assistant running memory_list" width="48%" />
  <img src="assets/demo-list-output.png" alt="Memory list and summary output" width="48%" />
</p>

## Architecture

| Layer                     | Path                                                      | Read default                  | Write default                | Lifetime                           |
| ------------------------- | --------------------------------------------------------- | ----------------------------- | ---------------------------- | ---------------------------------- |
| Global user memory        | `$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite`       | `scope: "all"` or `"global"`  | `scope: "global"` (explicit) | Permanent; agent-curated.          |
| Project durable + working | `$KIMI_CODE_HOME/kimi-memory/<project-key>/memory.sqlite` | `scope: "project"` or `"all"` | `scope: "project"` (default) | Permanent; agent-curated.          |
| Project session archive   | same path; `conversations` + `conversation_events` tables | project-only, no `scope`      | automatic (hook-driven)      | Idempotent ingest of `wire.jsonl`. |
| Shared cross-project pool | `$KIMI_CODE_HOME/kimi-memory/_shared/memory.sqlite`       | `scope: "all"` (with share)   | `acl_share_memory` only      | ACL-promoted rows.                 |

`<project-key>` is a SHA-256 prefix of the canonical project root. The
global DB uses `project_key = "_global"`; the shared pool uses
`project_key = "_shared"`. Per-project queries never accidentally hit
either.

## Requirements

- Kimi Code with plugin, hook, Skill, and MCP support.
- Node.js ≥ 24 (`node:sqlite`; no native build required).

## Install

### From GitHub

In the Kimi Code chat input:

```text
/plugins install https://github.com/cbuntingde/kimi-memory
```

Kimi pulls the source into `$KIMI_CODE_HOME/plugins/managed/kimi-memory/`.
On its first MCP start, the plugin bootstraps the runtime dependencies
from `package-lock.json` with `npm install`; no second manual step is
required. The plugin is not on the Kimi marketplace, so a trust prompt
will appear (default **Cancel**); choose the affirmative option. Then
run `/reload` and verify with `/plugins info kimi-memory` — no
diagnostic block means a clean install.

### From a local checkout

```bash
cd <path-to-this-repo>
npm install
```

Then from the Kimi chat input:

```text
/plugins install <absolute-path-to-this-repo>
/reload
```

Local sources are copied into the managed plugin directory; edits to
this checkout do not propagate. Reinstall (and `/reload`) after
meaningful changes.

## Use

### Slash commands

| Command                      | What it does                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/kimi-memory:list_memories` | `memory_list` over project + global scope.                                                                                           |
| `/kimi-memory:advisor`       | Reflection procedure over the active project (anchored recommendations, no remote). Also triggered by reflection phrases in prompts. |
| `/kimi-memory:prune`         | Orphan-project DB cleanup (dry-run by default; `--apply` to delete).                                                                 |
| `/kimi-memory:reset-project` | Wipe the per-project rows after a re-clone (dry-run by default; `--apply` to delete).                                                |
| `/kimi-memory:memos`         | Open the companion `kimi-memos-dashboard` in the default browser (read-only view of every kimi-memory SQLite DB; separate plugin).   |

### Natural language

Phrases like "list memories", "remember this decision", or "what did we
decide?" invoke the same MCP tools when the Skill matches. Every MCP
call requires the active project's absolute root as `cwd` to prevent
cross-project writes and supply provenance context.

## Tools

The plugin exposes 46 MCP tools over the `kimi-memory` stdio server:

- **Durable memory** — `memory_save`, `memory_recall`, `memory_list`, `memory_get`, `memory_update`, `memory_delete`, `memory_save_bulk`, `memory_status`
- **Similarity + edges** — `memory_similar`, `memory_link`, `memory_unlink`, `memory_edges`, `memory_merge`
- **Synthesis** — `memory_conclusions_for`, `memory_parents`
- **Working memory** — `working_memory_set`, `working_memory_get`, `working_memory_clear`
- **Session archive** — `conversation_list`, `conversation_get`, `conversation_search`, `conversation_ingest`
- **ACL / visibility** — `acl_grant`, `acl_revoke`, `acl_list`, `acl_share_memory`, `acl_resolve_principal`
- **Tier / persona** — `memory_set_tier`, `memory_promote`, `memory_demote`, `memory_tier_history`
- **Wiki** — `wiki_upsert_page`, `wiki_get_page`, `wiki_traverse`, `wiki_backlinks`, `wiki_resolve`
- **Codegraph** — `codegraph_extract`, `codegraph_build_edges`, `codegraph_query_symbol`, `codegraph_impact_path`, `codegraph_callers`, `codegraph_callees`
- **Maintenance** — `memory_prune`, `memory_reset_project`, `memory_diagnostics`

Defaults: `memory_save` / `memory_update` / `memory_delete` write to
`scope: "project"`; `memory_recall` / `memory_list` / `memory_get` read
across `scope: "all"` (project first, then global). Pass an explicit
`scope` to override.

### Standalone CLI

The same surface is available without the MCP server via the
`kimi-memory` bin entry:

```bash
kimi-memory list                              [--cwd <path>] [--scope project|global|all]
kimi-memory get <memory-id>                   [--cwd <path>] [--scope project|global]
kimi-memory status                            [--cwd <path>]
kimi-memory recall <query>                    [--cwd <path>] [--limit N]
kimi-memory prune                             [--cwd <path>] [--all-projects] [--apply]
kimi-memory reset-project                     [--cwd <path>] [--apply]
kimi-memory export                            [--cwd <path>] [--output <path>]
kimi-memory import                            [--cwd <path>] [--input <path>]
kimi-memory serve-http                        [--cwd <path>] [--port <port>]
```

`--json` emits machine-readable JSON; `-q` suppresses per-row output;
`--home <dir>` overrides `$KIMI_CODE_HOME`. `prune --apply` removes
orphan project DBs whose canonical root no longer exists;
`reset-project --apply` wipes the per-project rows of the active
project. Both are dry runs by default.

## Environment variables

All optional; defaults are tuned for production.

| Variable                            | Default | Effect                                                                                                |
| ----------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `KIMI_MEMORY_EMBEDDINGS`            | `on`    | Set to `off` to skip the embedding encoder. Recall falls back to FTS5-only.                           |
| `KIMI_MEMORY_EMBED_TIMEOUT_MS`      | `4000`  | Wall-clock cap on a single embedding call.                                                            |
| `KIMI_MEMORY_AUTO_EXTRACT`          | `on`    | Set to `off` to disable the Stop-hook auto-extraction LLM call.                                       |
| `KIMI_MEMORY_SECRET_SCAN`           | `on`    | Set to `off` to bypass the server-side secret pre-write check. Use only for legitimate test fixtures. |
| `KIMI_MEMORY_PROXY_CORS_ORIGINS`    | unset   | Comma-separated origin allowlist for the HTTP proxy.                                                  |
| `KIMI_MEMORY_CONSOLIDATE`           | `on`    | Set to `off` to skip the background "dream pass" (conclusion synthesis + auto-merge).                 |
| `KIMI_MEMORY_AUTO_MERGE`            | `on`    | Set to `off` to disable auto-merge of tight sibling clusters (synthesis still runs).                  |
| `KIMI_MEMORY_AUTO_GC`               | `on`    | Master switch for the auto-GC pipeline (prune + archive + tier).                                      |
| `KIMI_MEMORY_AUTO_PRUNE`            | `on`    | Set to `off` to skip auto-prune of dead rows.                                                         |
| `KIMI_MEMORY_AUTO_ARCHIVE`          | `on`    | Set to `off` to skip auto-archive of `conversation_events`.                                           |
| `KIMI_MEMORY_AUTO_TIER`             | `on`    | Set to `off` to skip auto-tier promotion / demotion.                                                  |
| `KIMI_MEMORY_DISABLE_SESSION_FOCUS` | `off`   | Set to `1` to skip the Stop-hook session-focus capture.                                               |
| `KIMI_MEMORY_PERF`                  | `on`    | Set to `off` to skip the 5k-corpus perf benchmarks in `tests/16-perf.test.js`.                        |

## Storage and privacy

Local-first. SQLite databases live under `$KIMI_CODE_HOME/kimi-memory/`;
the plugin never writes into Kimi's `sessions` tree.

```text
$KIMI_CODE_HOME/kimi-memory/<project-key>/memory.sqlite
$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite
$KIMI_CODE_HOME/kimi-memory/_shared/memory.sqlite
$KIMI_CODE_HOME/kimi-memory/_diagnostics/hooks.log
```

Two outbound behaviours:

- The MiniLM model (~25 MB) downloads lazily from Hugging Face on first
  use and caches locally. Disable with `KIMI_MEMORY_EMBEDDINGS=off`.
- Auto-extraction sends one short LLM call per Stop event to the model
  configured in `config.toml`. The transcript included in that call is
  scrubbed server-side (`redactSecrets`) before it leaves the machine —
  credentials typed in chat never reach the configured LLM provider.
  Disable with `KIMI_MEMORY_AUTO_EXTRACT=off`.

The server `saveMemory` runs `looksLikeSecret` on every write and
refuses to persist known credential shapes (OpenAI, Anthropic, GitHub,
AWS, JWT, PEM, `key=…`, `Authorization: Bearer`). False positives are
preferred over persisting a real secret.

## Uninstall and data retention

- `/plugins remove kimi-memory` deletes the installation record but
  leaves the managed copy and memory databases on disk.
- Remove the managed copy: `rm -rf "$KIMI_CODE_HOME/plugins/managed/kimi-memory"`.
- Wipe every kimi-memory database:
  `rm -rf "$KIMI_CODE_HOME/kimi-memory/"`.
- For orphan-project cleanup only, use `/kimi-memory:prune` (or
  `memory_prune(scope: "all-projects")`) — dry-run by default, then
  `apply: true` to delete. The global DB and the active project's DB
  are always preserved.

## Development

```bash
npm install
npm run check             # node --check on every source file
npm test                  # node --test tests/*.test.js
npm run format:check      # prettier --check on every tracked file
npm run backfill-embeddings
```

The full test suite runs in a few seconds because tests opt out of the
embedding model download via `KIMI_MEMORY_EMBEDDINGS=off` in
`tests/_helpers.js`. The `assets/` directory holds the static assets
shipped with the plugin (`icon.svg` plus the README hero screenshots)
and is kept under version control so the manifest and tests can rely
on a stable relative path.

## License

MIT — see `LICENSE`.
