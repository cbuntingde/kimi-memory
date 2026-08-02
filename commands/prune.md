---
name: prune
description: Find and remove project memory databases whose project root no longer exists on disk. Use when a project is deleted or moved.
---

# /kimi-memory:prune

Remove kimi-memory project databases for projects that no longer exist on disk.

## Usage

```text
/kimi-memory:prune                # dry run — list orphan databases, do not remove
/kimi-memory:prune --apply        # actually remove the orphan database files
```

## What this does

The plugin stores one SQLite database per project under
`$KIMI_CODE_HOME/kimi-memory/<project-key>/memory.sqlite`, keyed by the
SHA-256 of the canonical project root. When a project is deleted or
moved, the database is left behind and the file becomes unreachable
through normal agent flow. This command finds and removes those orphans.

The dry run is the default — it always shows what would be removed
before touching the filesystem. Review the list, then re-run with
`--apply` if the deletions are correct.

## Procedure

1. Call `memory_prune(scope: "all-projects", apply: false)`. The MCP
   tool enumerates every project DB in the data root, looks up the
   recorded canonical root, and reports `exists_on_disk: true|false`
   for each.
2. Print the list of orphans (`exists_on_disk: false`) clearly:
   ```
   Found 2 orphan project databases:
     - 5344107ff52a7a33 → /Users/me/old-projects/foo
     - aabbccdd00112233 → /Users/me/old-projects/bar
   ```
3. Stop. Tell the user the dry-run result. If they want to proceed,
   wait for confirmation; this command is destructive.
4. After explicit confirmation, call
   `memory_prune(scope: "all-projects", apply: true)` and report the
   final `removed` count. The global database is never touched.

## When not to use

- Do not invoke with `--apply` on someone else's behalf. The MCP tool
  is idempotent and the dry-run is the safe default; the user must
  confirm before destructive removal.
- Do not use this command to remove a project the user is still
  working on. The dry run shows the canonical root for each project —
  if the path exists, the project is alive and the entry should not
  be removed.
- The global cross-project database (`$KIMI_CODE_HOME/kimi-memory/_global/`)
  is not in scope. Removing it is a separate manual cleanup, not
  `memory_prune`.

## Related

- `memory_prune(scope: "project", apply: ...)` — check / clean a single
  project (use this when the user just deleted the active project and
  wants the current directory's memory swept immediately).
- Manual removal — use `/plugins remove kimi-memory`, then remove the managed
  copy and data directories described in `README.md` under "Uninstall and
  data retention".
- `memory_status` — counts of memories per scope; pair with prune when
  the user asks "is there anything old I should clean up?".
