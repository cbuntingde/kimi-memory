---
name: reset_project
description: Wipe the per-project memory cache for the active project when it was re-cloned from the same path. Use when the user says "reset project memory", "wipe this project's memory", "I re-cloned the repo", or "memory is stale".
---

# reset_project

Wipe every per-project row (memories, working memory, conversations, conversation events, edges, synthesizes) for the active project so the project starts from a clean slate. Use this after a repo is re-cloned to the same canonical path: the project_key is a hash of the path, so kimi-memory cannot otherwise tell the new project apart from the old one. The global database and every other project DB are never touched.

## When to use

- The hook layer surfaces a `[stale-memory]` line on SessionStart or UserPromptSubmit (compare directory birthtime with `first_seen_at`).
- The user says "I re-cloned this repo" / "I deleted and re-cloned" / "the memory is stale" / "start fresh on this project".
- `memory_status` reports `reclone.isReclone: true` and the user wants to clean up.

## Steps

1. Call `memory_reset_project` with `cwd` set to the project root and `confirm: false` (dry run). Echo the returned `row_counts` and `reclone` so the user can see what would be deleted.
2. Render a one-line confirmation prompt that names the project root, the total row count, and asks for the user's explicit "yes" before continuing. **Never auto-confirm** — the reset is destructive and there is no undo.
3. If the user confirms, call `memory_reset_project` again with `confirm: true` and echo the returned `summary` (`memories_deleted`, `working_memory_deleted`, `conversations_deleted`, `conversation_events_deleted`, `memory_edges_deleted`, `memory_synthesizes_deleted`).
4. If the user declines, stop and report that the project was not reset. Suggest `/kimi-memory:list_memories` so the user can see what would have been wiped.

## Memory recall and acknowledgement

Before wiping, run `memory_recall(scope='project', ...)` to surface the durable entries that will go away. Render a one-line summary so the user knows what is being lost (e.g. "3 conventions, 1 procedure, 1 working note will be deleted"). This is the recall acknowledgement contract — the user can read what was on file and make a final call.

## Example dry run response

```
{
  "operation": "reset_project_dry_run",
  "project_key": "152cb83a2d1f7821",
  "reclone": {
    "isReclone": true,
    "reason": "directory birthtime is 42m newer than first_seen_at; project was re-cloned after kimi-memory first saw it"
  },
  "row_counts": { "memories": 12, "working_memory": 1, "conversations": 9, ... },
  "total_rows": 23
}
```

Always pass the project root (the cwd of the current session) as `cwd`. The server never infers it.
