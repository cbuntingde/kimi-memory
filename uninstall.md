# Uninstalling `kimi-memory`

This doc removes the plugin from your Kimi Code install completely —
both the registered plugin record and every on-disk artifact the plugin
owns (managed copy, memory databases, cached model, diagnostics). Run the
steps in order; each step is idempotent so re-running it is safe.

If you only want to disable the plugin without deleting data, stop after
step 1 (`/plugins disable kimi-memory`).

## 1. Remove the plugin record

In the Kimi Code chat input:

```text
/plugins remove kimi-memory
```

This drops the entry from `$KIMI_CODE_HOME/plugins/installed.json`. Kimi
will prompt for confirmation because the slash is destructive — accept
it. The managed copy and memory databases are **not** touched by this
step; they remain on disk until you remove them in the next steps.

If `/plugins remove` is not available on your build, use the equivalent
in the Installed tab (press `D` on the selected plugin) or run:

```text
/plugins disable kimi-memory
```

to keep the record on disk but stop it from loading.

After the slash, run `/reload` (or start a new session) so the hooks
runner, the MCP server, and the loaded Skill are unloaded.

## 2. Remove the managed copy

The local installation lives at:

```text
$KIMI_CODE_HOME/plugins/managed/kimi-memory/
```

Remove it. On macOS / Linux:

```bash
rm -rf "$KIMI_CODE_HOME/plugins/managed/kimi-memory"
```

On Windows (Git Bash):

```bash
rm -rf "$KIMI_CODE_HOME/plugins/managed/kimi-memory"
```

On Windows (PowerShell):

```powershell
Remove-Item -Recurse -Force "$env:KIMI_CODE_HOME\plugins\managed\kimi-memory"
```

The path is the same on all three OSes because Kimi stores the copy
under a single directory; the only thing that changes is the shell.

## 3. (Optional) Erase all memory databases

This step **destroys every durable memory and session archive the
plugin has ever stored** for every project on this machine. Do not run
it unless you want a clean slate. Confirm with `memory_status` (if the
plugin is still enabled) or by listing the directory first.

The memory databases live at:

```text
$KIMI_CODE_HOME/kimi-memory/<project-key>/memory.sqlite   # one per project
$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite         # cross-project user memory
```

Each project directory also contains a `ingest-state.json` cursor
(the byte/line offset the hook runner last read up to). Diagnostic logs
land under `$KIMI_CODE_HOME/kimi-memory/_diagnostics/hooks.log` and
`<plugin-root>/_diagnostics/advisor-hooks.log` (the latter is a sibling
of the managed copy and travels with the source checkout).

Erase everything in one go:

macOS / Linux / Git Bash:

```bash
rm -rf "$KIMI_CODE_HOME/kimi-memory"
```

Windows PowerShell:

```powershell
Remove-Item -Recurse -Force "$env:KIMI_CODE_HOME\kimi-memory"
```

If you want to keep some projects' data, delete only the specific
`<project-key>` directories you no longer care about. You can read the
project key for any active project with `memory_status.project_key` (when
the plugin is still enabled) or by listing
`$KIMI_CODE_HOME/kimi-memory/` — every entry other than `_global/` is a
project key.

## 4. (Optional) Remove the plugin source checkout

If you cloned or downloaded the plugin source from GitHub, that copy is
independent of Kimi's managed copy. Remove it separately:

```bash
rm -rf /path/to/your/kimi-memory-checkout
```

The source is in no way coupled to the install after step 2.

## 5. (Optional) Wipe the embedding model cache

The MiniLM model used for `memory_similar` / `memory_recall` is cached
under the `@huggingface/transformers` cache directory. Removing it frees
~25 MB and forces a re-download on the next install. The cache path
depends on the OS:

- macOS: `~/Library/Caches/huggingface/`
- Linux: `~/.cache/huggingface/`
- Windows: `%LOCALAPPDATA%\huggingface\`

Delete the `transformers/` subdirectory inside whichever of those
exists. The plugin will re-fetch the model the first time it computes
an embedding on a fresh install.

## 6. Verify the uninstall is complete

After running the steps you want:

1. `/plugins list` — no `kimi-memory` entry.
2. `$KIMI_CODE_HOME/plugins/managed/kimi-memory/` — does not exist.
3. `memory_status` (if the plugin is still enabled) — returns "tool not
   found" from `/mcp`, and `/mcp` shows the `kimi-memory` server as
   disabled or absent.
4. `$KIMI_CODE_HOME/kimi-memory/` — does not exist (or only contains
   the directories you deliberately kept).

If any of those still has a `kimi-memory` artifact, the corresponding
step above was skipped; run it and re-verify.

## Reinstalling

To put the plugin back, follow [`README.md` § Install](README.md#install)
or paste the AI-driven install URL:

```text
https://raw.githubusercontent.com/cbuntingde/kimi-memory/main/ai-install.md
```

A fresh install lands in `$KIMI_CODE_HOME/plugins/managed/kimi-memory/`
and creates a new `$KIMI_CODE_HOME/kimi-memory/` root; nothing from the
previous install is reused unless you kept the memory directories in
step 3.

## Notes

- `installed.json` removal is the only step Kimi manages. Steps 2–5 are
  filesystem operations the user (or a script) runs directly. There is
  no `/plugins` slash that performs them.
- If you skipped step 3 and reinstall later, the new install will pick
  up the existing `$KIMI_CODE_HOME/kimi-memory/<project-key>/` databases
  — durable memories survive across install/uninstall cycles as long as
  the directory does.
- The plugin's source tree is plain ESM with no native build step;
  removing the managed copy and the local checkout is sufficient for a
  full uninstall on any supported platform.
- For a softer cleanup that keeps the install but removes databases for
  projects that no longer exist on disk, use `memory_prune(scope:
"all-projects", apply: true)` via the MCP server or run
  `/kimi-memory:prune`. The global database and the active project are
  preserved; only orphan project DBs are removed.
