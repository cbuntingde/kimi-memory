# kimi-memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local-first memory layer for the Kimi Code assistant. It gives the
assistant persistent recall across your projects — your preferences,
facts about the work you do, and the focus of what you were doing last —
all stored on your own computer, never uploaded to a service you didn't
choose.

## What it does

The assistant normally forgets everything between conversations. With
this plugin installed, the assistant remembers:

- Your preferences and habits, no matter which project you're working in
- Decisions and conventions for the project you have open
- What you were last working on, so the next conversation can pick up
  the thread
- The full conversation history of every session, indexed and searchable

Everything stays on your machine. The plugin writes to local files in a
folder the Kimi Code runtime owns; you can read them, back them up, or
delete them whenever you want.

## Highlights

- **Local-first.** Your memories live in local files inside Kimi's data
  folder. Nothing leaves your machine unless you turn on the optional
  helper model for finding related memories.
- **Cross-project preferences.** A fact about you ("I prefer dark
  mode", "always run the tests before committing") can be saved once
  and recalled in every project.
- **Per-project facts.** A decision about one project ("we use tabs in
  this repo") stays with that project and never bleeds into another.
- **Focus continuity.** Each session saves what you were working on so
  the next conversation starts with the thread already in hand.
- **Secret-safe by default.** Passwords, API keys, and security
  tokens are caught at save time and refused — they never land in
  memory.

## Install

### From GitHub

In the Kimi Code chat input:

```text
/plugins install https://github.com/cbuntingde/kimi-memory
```

Kimi pulls the source into its managed plugins folder and starts the
plugin on next session. A trust prompt appears because the plugin is
not on the Kimi marketplace — choose the affirmative option, then
reload and verify with `/plugins info kimi-memory`. No error block
means a clean install.

### From a local checkout

```bash
cd <path-to-this-repo>
npm install
```

Then in Kimi:

```text
/plugins install <absolute-path-to-this-repo>
/reload
```

Local sources are copied into the managed plugin directory; edits to
your checkout do not propagate. Reinstall and reload after meaningful
changes.

## Requirements

- Kimi Code with plugin, slash command, and tool support
- Node.js 24 or newer

## Everyday commands

The most common entry points. You don't need to remember these — the
assistant handles them when you ask in plain language.

| What you want to do                               | Command                                      |
| ------------------------------------------------- | -------------------------------------------- |
| List this project's memories                      | `/kimi-memory:list_memories`                 |
| Reflect on the active project                     | `/kimi-memory:advisor`                       |
| Wipe a re-cloned project's stale memories         | `/kimi-memory:reset-project --apply`         |
| Open the companion dashboard in your browser      | `/kimi-memory:memos`                         |
| Check the pipeline (counts, queues, cleanup)      | `node src/cli.js status --cwd <path>`        |
| Clean up memory for projects that no longer exist | `node src/cli.js prune --cwd <path> --apply` |

For everything else, just ask: "remember this decision", "what did
we decide about X?", "list memories", "promote this to cross-project".
The assistant will use the right tool.

## Where your memories live

Each memory row lives in exactly one place. Routes never cross layers,
so a per-project question can never accidentally pull in a cross-project
memory, and vice versa.

| Layer                   | Location                                                 | Lifetime                 | What goes here                                           |
| ----------------------- | -------------------------------------------------------- | ------------------------ | -------------------------------------------------------- |
| Cross-project memory    | `<Kimi data folder>/kimi-memory/_global/memory.sqlite`   | Permanent; you curate it | Your preferences, environment facts, reusable procedures |
| Project durable memory  | `<Kimi data folder>/kimi-memory/<project>/memory.sqlite` | Permanent; you curate it | Decisions, conventions, and facts about one project      |
| Project working memory  | Same project file, separate table                        | Transient, current focus | What you are working on right now                        |
| Project session archive | Same project file, separate table                        | Idempotent transcript    | Every conversation, indexed and searchable               |

`<Kimi data folder>` is the `$KIMI_CODE_HOME` environment variable on
your system. `<project>` is a stable identifier derived from the
project folder's full path.

## Slash commands

| Command                      | What it does                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/kimi-memory:list_memories` | List memories across project and cross-project                                                        |
| `/kimi-memory:advisor`       | Reflection procedure over the active project; also triggered by phrases like "what should we change?" |
| `/kimi-memory:prune`         | Clean up memory for projects that no longer exist (dry-run by default)                                |
| `/kimi-memory:reset-project` | Wipe per-project memories after a re-clone (dry-run by default)                                       |
| `/kimi-memory:promote`       | Move a project memory to the cross-project store so it shows up everywhere                            |
| `/kimi-memory:dreaming`      | Configure and run the background consolidation pass that merges near-duplicates and prunes stale rows |
| `/kimi-memory:memos`         | Open the companion dashboard in your browser                                                          |

Natural language works too. Phrases such as "remember this decision",
"what did we decide?", "list memories", or "promote this to global"
invoke the same actions when the assistant understands your intent.

## How the assistant saves memories

The assistant has tools to read and write memories, but you do not need
to call them by name. Just talk naturally:

- **State a durable preference about yourself or your environment** and
  the assistant will save it cross-project (for example: "I always
  prefer dark mode").
- **State a fact about the project** and the assistant will save it
  for that project (for example: "this repo uses tabs").
- **Ask "do you remember…?" or "what did we decide…?"** and the
  assistant will search cross-project first, then the active project.

At the end of every conversation, the assistant does one short review
of the session and saves any facts that are worth keeping. The
review uses the same model Kimi Code is already configured to talk
to, and the text it sees is scrubbed before it leaves your machine
so credentials pasted in chat never reach the configured provider.

If you do not want that automatic review, set
`KIMI_MEMORY_AUTO_EXTRACT=off` before the first conversation starts.

## Privacy and data handling

Local-first by construction. The plugin never writes into Kimi's
session tree. The four files it creates are:

```text
<Kimi data folder>/kimi-memory/<project>/memory.sqlite
<Kimi data folder>/kimi-memory/_global/memory.sqlite
<Kimi data folder>/kimi-memory/_diagnostics/hooks.log
```

The diagnostic log records automatic actions at one record per line
for failures, save issues, and similar warnings. Free-form error
messages are cleaned before they land on disk, so absolute paths,
host names, and URLs are removed from any third-party string.

Two optional behaviours, each can be turned off:

- **Helper model for finding related memories.** A small model file
  (~25 MB) downloads the first time you use the plugin and caches
  locally. Disable with `KIMI_MEMORY_EMBEDDINGS=off`.
- **Automatic review at end of conversation.** One short model call
  per session to the provider configured in Kimi's settings. The
  conversation text included in that call is cleaned before it leaves
  your machine, so any credentials pasted in chat never reach the
  provider. Disable with `KIMI_MEMORY_AUTO_EXTRACT=off`.

Every memory save is checked against a catalogue of known credential
shapes — passwords, API keys, security tokens, "Authorization: Bearer"
headers, and similar patterns. False positives are preferred to
persisting a real secret. See `SECURITY.md` for the full policy.

## Configuration

All settings are optional; defaults are tuned for everyday use.

| Setting                             | Default | What it does                                                                                                                                                                             |
| ----------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KIMI_MEMORY_AUTO_RESET_ON_RECLONE` | on      | Auto-wipe per-project memories when the assistant detects the project was re-cloned. Set to `off` to keep a manual hint instead.                                                         |
| `KIMI_MEMORY_EMBEDDINGS`            | on      | Set to `off` to skip the helper model download. Finding related memories falls back to keyword search.                                                                                   |
| `KIMI_MEMORY_CONSOLIDATE`           | on      | Set to `off` to skip the in-line merge pass at session start.                                                                                                                            |
| `KIMI_MEMORY_DREAM`                 | on      | Set to `off` to skip the background cleanup. Queued jobs stay queryable.                                                                                                                 |
| `KIMI_MEMORY_AUTO_EXTRACT`          | on      | Set to `off` to disable the automatic review at the end of each conversation.                                                                                                            |
| `KIMI_MEMORY_AUTO_EXTRACT_GLOBAL`   | on      | Set to `off` to demote every automatically-saved cross-project candidate back to project scope. Cross-project memory stays useful either way; this just freezes the cross-project store. |
| `KIMI_MEMORY_LEGACY_SUBSYSTEMS`     | on      | Set to `off` to hide the deprecated tool groups (older access-control, graph, and persona features kept for backwards compatibility).                                                    |
| `KIMI_MEMORY_SECRET_SCAN`           | on      | Set to `off` to bypass the credential-shape gate on save. Off is intended for fixture imports only.                                                                                      |

The full table — including timeouts, strict-mode network guards, and
auto-cleanup switches — lives in `AGENTS.md`.

## Standalone command line

For power users, the same surface is available without starting the
plugin, through the `kimi-memory` bin entry:

```bash
kimi-memory list                              [--cwd <path>] [--scope project|global|all]
kimi-memory get <memory-id>                   [--cwd <path>] [--scope project|global]
kimi-memory status                            [--cwd <path>]
kimi-memory recall <query>                    [--cwd <path>] [--limit N]
kimi-memory prune                             [--cwd <path>] [--all-projects] [--apply]
kimi-memory reset-project                     [--cwd <path>] [--apply]
kimi-memory export                            [--cwd <path>] [--output <path>]
kimi-memory import                            [--cwd <path>] [--input <path>]
```

`--json` emits machine-readable output; `-q` suppresses per-row
output; `--home <dir>` overrides the Kimi data folder.
`prune --apply` removes memory for projects whose folder no longer
exists; `reset-project --apply` wipes the per-project memories of
the active project. Both default to a dry run that shows what would
change before doing it.

## Uninstall and data retention

- `/plugins remove kimi-memory` removes the installation record but
  leaves the managed copy and memory files on disk.
- Remove the managed copy: `rm -rf "$KIMI_CODE_HOME/plugins/managed/kimi-memory"`.
- Wipe every kimi-memory file: `rm -rf "$KIMI_CODE_HOME/kimi-memory/"`.
- For cleanup of just the projects that no longer exist, use
  `/kimi-memory:prune` (or `memory_prune` with `scope: "all-projects"`).
  Dry-run by default; pass `apply: true` to delete. The cross-project
  database and the active project's database are always preserved.

## License

MIT — see `LICENSE`.
