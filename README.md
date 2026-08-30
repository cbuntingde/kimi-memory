# kimi-memory

[![CI](https://github.com/cbuntingde/kimi-memory/actions/workflows/test.yml/badge.svg)](https://github.com/cbuntingde/kimi-memory/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-339933?logo=node.js&logoColor=white)](package.json)
[![Code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://prettier.io)

A local-first memory layer for Kimi Code. It gives the assistant persistent
recall across projects — cross-project user preferences, durable project
facts, working focus for the current task, and full session transcripts —
all stored in local SQLite and surfaced through MCP tools, slash commands,
and lifecycle hooks.

## Highlights

- **Local-first.** All data lives in SQLite under `$KIMI_CODE_HOME/kimi-memory/`.
  Nothing leaves your machine unless you opt in to the embedding model or
  auto-extraction.
- **Multi-layer storage.** Global user memory, per-project durable memory,
  per-project working memory, and per-project session archives.
- **Reflective advisor.** A built-in `/advisor` workflow turns project
  context into anchored recommendations.
- **Secret-safe by default.** Known credential shapes (API keys, tokens,
  `.env` contents, PII) are refused at write time.

## Quick start

### Install from GitHub

In the Kimi Code chat input:

```text
/plugins install https://github.com/cbuntingde/kimi-memory
```

Kimi pulls the source into `$KIMI_CODE_HOME/plugins/managed/kimi-memory/`
and bootstraps its runtime dependencies on first use. A trust prompt
appears because the plugin is not on the Kimi marketplace — choose the
affirmative option, then run `/reload` and verify with
`/plugins info kimi-memory`. No diagnostic block means a clean install.

### Install from a local checkout

```bash
cd <path-to-this-repo>
npm install
```

Then in Kimi:

```text
/plugins install <absolute-path-to-this-repo>
/reload
```

Local sources are copied into the managed plugin directory; edits to this
checkout do not propagate. Reinstall and `/reload` after meaningful
changes.

### One outbound call to know about

By default, `KIMI_MEMORY_AUTO_EXTRACT=on` fires at the end of every
Stop / SessionEnd / SessionStart: a small chat call goes to the same
provider Kimi's `config.toml` already routes through, with the most
recent conversation exchange and any project metadata detected from
manifest files. The transcript is scrubbed server-side by
`redactSecrets()` before it leaves the machine — known credential
shapes are replaced with `[REDACTED_*]` placeholders — and the
provider's own policies apply on top. If you don't want that call,
set `KIMI_MEMORY_AUTO_EXTRACT=off` before the first SessionStart, or
pass `[kimi-memory] disable_auto_extract = true` in your `config.toml`.
See [Privacy and data handling](#privacy-and-data-handling) for the
full surface.

### Requirements

- Kimi Code with plugin, hook, Skill, and MCP support
- Node.js 24 or newer (uses `node:sqlite`; no native build required)

## Everyday commands

The most common entry points. See [Slash commands](#slash-commands) and
[MCP tools](#tools) for the complete surface.
| Action | Command |
| List this project's memories | `/kimi-memory:list_memories` |
| Reflect on the active project | `/kimi-memory:advisor` |
| Wipe a re-cloned project's stale rows | `/kimi-memory:reset-project --apply` |
| Open the companion dashboard in your browser | `/kimi-memory:memos` |
| Check pipeline status (counts, advisor queue, cleanup) | `node src/cli.js status --cwd <path>` |
| Clean orphan project databases | `node src/cli.js prune --cwd <path> --apply` |

## Storage layers

Each row of memory lives in exactly one place. Routes never cross
layers, so a per-project query can never accidentally read a global row,
and vice versa.

| Layer                     | Path                                                  | Scope tag                    | Lifetime                     |
| ------------------------- | ----------------------------------------------------- | ---------------------------- | ---------------------------- |
| Global user memory        | `$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite`   | `scope: "global"`            | Permanent; you curate it     |
| Project durable memory    | `$KIMI_CODE_HOME/kimi-memory/<project>/memory.sqlite` | `scope: "project"` (default) | Permanent; you curate it     |
| Project working memory    | same database, `working_memory_*` tools               | project-only                 | Transient, current focus     |
| Project session archive   | same database, `conversations` tables                 | project-only                 | Idempotent transcript ingest |
| Shared cross-project pool | `$KIMI_CODE_HOME/kimi-memory/_shared/memory.sqlite`   | promoted on demand           | ACL-controlled rows          |

`<project>` is a stable identifier derived from the canonical project root.

## Slash commands

| Command                      | What it does                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/kimi-memory:list_memories` | List memories across project and global scope                                                         |
| `/kimi-memory:advisor`       | Reflection procedure over the active project, also triggered by phrases like "what should we change?" |
| `/kimi-memory:prune`         | Orphan-project database cleanup (dry-run by default)                                                  |
| `/kimi-memory:reset-project` | Wipe per-project rows after a re-clone (dry-run by default)                                           |
| `/kimi-memory:memos`         | Open the companion `kimi-memos-dashboard` in your browser                                             |

Natural language works too: phrases such as "remember this decision",
"what did we decide?", or "list memories" invoke the same MCP tools when
the Skill matches.

## Tools

Fifty MCP tools are exposed over the `kimi-memory` stdio server.

| Group                | Tools                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable memory       | `memory_save`, `memory_recall`, `memory_list`, `memory_get`, `memory_update`, `memory_delete`, `memory_save_bulk`, `memory_status`, `memory_reinforce`                                |
| Similarity and edges | `memory_similar`, `memory_link`, `memory_unlink`, `memory_edges`, `memory_merge`                                                                                                      |
| Synthesis            | `memory_conclusions_for`, `memory_parents`                                                                                                                                            |
| Working memory       | `working_memory_set`, `working_memory_get`, `working_memory_clear`                                                                                                                    |
| Session archive      | `conversation_list`, `conversation_get`, `conversation_search`, `conversation_ingest`                                                                                                 |
| Maintenance          | `memory_prune`, `memory_reset_project`, `memory_diagnostics`                                                                                                                          |
| Staged consolidation | `dream_list_jobs`, `dream_get_job`, `dream_list_proposals`, `dream_get_proposal`, `dream_status`, `dream_enqueue`, `dream_generate_proposals`, `dream_apply_job`, `dream_discard_job` |

Some legacy groups — access control, tier and persona, code graph —
remain available for existing integrations. They are deprecated; enable
them with `KIMI_MEMORY_LEGACY_SUBSYSTEMS=on`. They will be removed in the
next major version.

By default, `memory_save`, `memory_update`, and `memory_delete` write to
`scope: "project"`. `memory_recall`, `memory_list`, and `memory_get` read
across `scope: "all"` (project first, then global). Pass an explicit
`scope` to override.

### Standalone CLI

The same surface is available without the MCP server through the
`kimi-memory` bin entry:

```bash
kimi-memory list                              [--cwd <path>] [--scope project|global|all]
kimi-memory get <memory-id>                   [--cwd <path>] [--scope project|global]
kimi-memory status                            [--cwd <path>]
kimi-memory recall <query>                    [--cwd <path>] [--limit N]
kimi-memory prune                             [--cwd <path>] [--all-projects] [--apply]
kimi-memory reset-project                     [--cwd <path>] [--apply]
kimi-memory consolidate run                   [--cwd <path>] [--json]
kimi-memory consolidate status                [--cwd <path>] [--json]
kimi-memory dream status / list / get / enqueue / generate / apply / discard   [--cwd <path>]
kimi-memory export                            [--cwd <path>] [--output <path>]
kimi-memory import                            [--cwd <path>] [--input <path>]
kimi-memory serve-http                        [--cwd <path>] [--port <port>]
```

`--json` emits machine-readable output; `-q` suppresses per-row output;
`--home <dir>` overrides `$KIMI_CODE_HOME`. `prune --apply` removes
orphan project databases whose canonical root no longer exists;
`reset-project --apply` wipes the per-project rows of the active
project. Both default to a dry run.

## Configuration

All environment variables are optional; defaults are tuned for production
use.

| Variable                            | Default | Effect                                                                                                       |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `KIMI_MEMORY_AUTO_RESET_ON_RECLONE` | `on`    | Auto-wipe per-project rows when SessionStart detects a re-clone. Set to `off` to keep a manual hint instead. |
| `KIMI_MEMORY_EMBEDDINGS`            | `on`    | Set to `off` to skip the embedding encoder. Recall falls back to keyword search only.                        |
| `KIMI_MEMORY_CONSOLIDATE`           | `on`    | Set to `off` to skip the inline synthesis and merge pass at session start.                                   |
| `KIMI_MEMORY_DREAM`                 | `on`    | Set to `off` to skip staged consolidation. Existing queued jobs stay queryable.                              |
| `KIMI_MEMORY_AUTO_EXTRACT`          | `on`    | Set to `off` to disable the assistant-driven memory extraction at the end of each turn.                      |
| `KIMI_MEMORY_LEGACY_SUBSYSTEMS`     | `on`    | Set to `off` to hide the deprecated tool groups (access control, tier and persona, code graph).              |
| `KIMI_MEMORY_SECRET_SCAN`           | `on`    | Set to `off` to bypass the credential-shape gate on save + import. Off is intended for fixture imports only. |
| `KIMI_MEMORY_PROXY_TOKEN`           | unset   | Bearer token the memory proxy demands on every request. Recommended on any non-loopback bind.                |
| `KIMI_MEMORY_PROXY_ALLOW_TOOLS`     | unset   | Comma-separated destructive tool names the proxy may serve on a non-loopback bind (e.g. `memory_save`).      |
| `KIMI_MEMORY_PROXY_DENY_TOOLS`      | unset   | Comma-separated tool names that must never be served by the proxy, regardless of ALLOW_TOOLS.                |
| `KIMI_MEMORY_PROXY_REQUIRE_HTTPS`   | unset   | Set to `1`/`on` to demand a TLS terminator in front of any non-loopback bind; set to `off` to opt out.       |
| `KIMI_MEMORY_RECALL_BASE_LIMIT`     | `8`     | Hard ceiling on the number of hits recalled per DB. The pool-aware cap is `min(8, ceil(active/2))`.          |
| `KIMI_MEMORY_RECALL_MIN_HITS`       | `3`     | Floor on the per-DB recall limit. A 1-memory project still gets surfaced.                                    |
| `KIMI_MEMORY_RECALL_GAP_FACTOR`     | `0.4`   | Score-gap elbow: drop any hit below `topScore * factor`. Set to `0` to disable (pre-filter surface).         |

The full table — including timeouts, strict-mode network guards, and
auto-cleanup switches — is documented in `AGENTS.md`.

## Privacy and data handling

Local-first by construction. The plugin never writes into Kimi's session
tree. SQLite databases live under `$KIMI_CODE_HOME/kimi-memory/`:

```text
$KIMI_CODE_HOME/kimi-memory/<project>/memory.sqlite
$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite
$KIMI_CODE_HOME/kimi-memory/_shared/memory.sqlite
$KIMI_CODE_HOME/kimi-memory/_diagnostics/hooks.log
```

The diagnostic log records hook events at JSON-line granularity for
failures, extraction issues, embedding errors, and truncation warnings.
Free-form error messages are scrubbed before they land on disk, so
absolute paths, host:port fragments, and URLs are removed from any
third-party string.

Two outbound behaviours, each opt-out:

- The MiniLM embedding model (~25 MB) downloads lazily from Hugging Face
  on first use and caches locally. Disable with
  `KIMI_MEMORY_EMBEDDINGS=off`.
- Auto-extraction makes one short model call per turn to the provider
  configured in Kimi's `config.toml`. The transcript included in that
  call is scrubbed server-side before it leaves the machine, so any
  credentials pasted in chat never reach the configured provider.
  Disable with `KIMI_MEMORY_AUTO_EXTRACT=off`.

Every memory write is checked against a catalogue of known credential
shapes: OpenAI, Anthropic, GitHub, AWS, JWT, PEM, `key=…` assignments,
and `Authorization: Bearer` headers. False positives are preferred to
persisting a real secret. See `SECURITY.md` for the full policy.

## Uninstall and data retention

- `/plugins remove kimi-memory` deletes the installation record but
  leaves the managed copy and memory databases on disk.
- Remove the managed copy: `rm -rf "$KIMI_CODE_HOME/plugins/managed/kimi-memory"`.
- Wipe every kimi-memory database: `rm -rf "$KIMI_CODE_HOME/kimi-memory/"`.
- For orphan-project cleanup only, use `/kimi-memory:prune` (or
  `memory_prune` with `scope: "all-projects"`). Dry-run by default;
  pass `apply: true` to delete. The global database and the active
  project's database are always preserved.

## Development

```bash
npm install
npm run check             # syntax check on every source file
npm test                  # runs tests/*.test.js
npm run format:check      # formatter check on every tracked file
npm run backfill-embeddings
```

The full test suite runs in a few seconds; tests opt out of the
embedding model download so no large artifacts are pulled during CI.

## License

MIT — see `LICENSE`.
