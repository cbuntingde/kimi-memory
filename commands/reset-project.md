---
name: reset_project
description: Wipe the per-project memory cache for the active project when it was re-cloned from the same path.
---

# /kimi-memory:reset_project

Wipe every per-project row (memories, working memory, conversations,
conversation events, edges, synthesizes) for the active project so the
project starts from a clean slate. Use this after a repo is re-cloned
to the same canonical path: the project_key is a hash of the path, so
kimi-memory cannot otherwise tell the new project apart from the old
one. The global database and every other project DB are never touched.

Steps:

1. Call `memory_reset_project` with `cwd` set to the project root and
   `confirm: false` to do a dry run. Echo the returned `row_counts`
   and `reclone` so the user can see what would be deleted.
2. Render a one-line confirmation prompt that names the project root,
   the total row count, and asks for the user's explicit "yes" before
   continuing. Never auto-confirm — the reset is destructive.
3. If the user confirms, call `memory_reset_project` again with
   `confirm: true` and echo the returned `summary` (memories_deleted,
   working_memory_deleted, conversations_deleted, etc.).
4. If the user declines, stop and report that the project was not
   reset. Suggest `/kimi-memory:list_memories` so the user can see
   what would have been wiped.

The hook layer surfaces a `[stale-memory]` line on SessionStart and
UserPromptSubmit when a re-clone is detected (compare directory
birthtime with `first_seen_at`). Treat that as the trigger to suggest
this command rather than auto-running it.

Example dry run response:

```
{
  "operation": "reset_project_dry_run",
  "project_key": "152cb83a2d1f7821",
  "reclone": { "isReclone": true, "reason": "directory birthtime is 42m newer than first_seen_at" },
  "row_counts": { "memories": 12, "working_memory": 1, "conversations": 9, ... },
  "total_rows": 23
}
```

The plugin's `/reset_project` skill is equivalent; this command is the
namespaced fallback (`/kimi-memory:reset_project`).
