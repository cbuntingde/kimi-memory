---
name: promote
description: Move one or more project memories into the cross-project _global store so they recall from any project.
---

# /kimi-memory:promote

Promote project memories into the cross-project store. Use when
auto-extract under-classified a fact (it stayed in the project DB
when it should have gone to global) or when the operator is
reconciling a project cache manually.

## Usage

Two paths, with different safety defaults:

- **MCP tool** `memory_promote_to_global(cwd, memory_ids)` — moves
  immediately. There is no dry run on this path, so confirm with the
  user before calling it.
- **CLI** `node src/cli.js promote-to-global --memory-id <id>` — dry run
  by default; re-run with `--apply` to perform the move.

```text
node src/cli.js promote-to-global --memory-id <id> [--memory-id <id> ...]   # dry run
node src/cli.js promote-to-global --memory-id <id> --apply                 # actually move
```

On the CLI, the dry run lists what would be moved and exits without
touching either database. Review the list, then re-run with `--apply`
to perform the move.

## What this does

The plugin stores project memories under
`$KIMI_CODE_HOME/kimi-memory/<project-key>/memory.sqlite` and
cross-project memories under
`$KIMI_CODE_HOME/kimi-memory/_global/memory.sqlite`. This command
moves a row from the project DB to the global DB:

1. The source row is removed from the project DB.
2. The row is rewritten into `_global/memory.sqlite` with
   `project_key = '_global'`. The id is preserved across the move so
   any caller holding the id keeps working.
3. `provenance.promoted_from` records the originating project key;
   `provenance.promoted_at` records the move timestamp.

The move is a two-phase commit with compensation: the global DB is
written first, then the source DB is deleted; if the source-DB step
fails, the global writes are rolled back so the operation is atomic
from the caller's view.

## Procedure

1. Confirm the user wants to promote. Cross-project memory is visible
   from every project — promoting the wrong fact pollutes global
   recall.
2. Identify the source memory ids. Use `memory_recall(scope: "project",
query: ...)` or `memory_list(scope: "project")` to find the row.
   Confirm the title and content are genuinely cross-project (user
   preference, environment fact, reusable procedure) before promoting.
3. Move the rows. The MCP tool moves immediately — it has no dry run —
   and returns `moved` (each entry carrying `id`, `new_global_id` — the
   same value — `type`, and `title`), `skipped` (ids that did not exist,
   were duplicates, or matched a secret shape), and the counts
   `moved_count` / `skipped_count`:
   ```
   memory_promote_to_global(cwd: <project>, memory_ids: [...])
   ```
   If you want a preview first, use the CLI instead; it is dry-run by
   default and needs `--apply` to move:
   ```
   node src/cli.js promote-to-global --cwd <project> --memory-id <id>          # preview
   node src/cli.js promote-to-global --cwd <project> --memory-id <id> --apply  # move
   ```
4. Confirm by calling `memory_recall(scope: "global", query: ...)` and
   showing the user the row is now visible from any project.

## When not to use

- Do not promote project-specific facts (commit policy, build/stack
  details, project conventions). They belong in the project DB and
  would pollute global recall if promoted.
- Do not promote secrets or credentials. The `looksLikeSecret` shape
  scan rejects them at promote time (defence-in-depth on top of the
  save-time gate), but the user-visible reason is `secret_detected`
  rather than a clean move.
- Do not run on someone else's behalf. The MCP tool moves immediately
  with no dry run, so the user must confirm before the destructive move;
  use the CLI's dry-run path (`promote-to-global` without `--apply`) if
  you want to preview first.

## Related

- `memory_recall(scope: "all", query: ...)` — confirm the row shows up
  in cross-project recall after the move.
- `memory_list(scope: "global")` — list every cross-project memory;
  pair with promote when the user asks "is there anything I should
  move up".
- `memory_save(scope: "global", ...)` — for new facts the user wants
  saved as global without going through project first.
