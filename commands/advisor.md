---
name: advisor
description: Run the advisor reflection over the active project (anchored recommendations, no remote calls).
---

# /kimi-memory:advisor

Trigger an advisor reflection on the active project.

## Usage

```text
/kimi-memory:advisor              # full reflection sweep over the active project
/kimi-memory:advisor <topic>      # focused reflection on a specific topic
```

## What this does

Runs the advisor procedure defined in skill `advisor`:

1. `memory_recall(scope: "all", ...)` over the synthesised query — pulls global and project memories in one call.
2. `working_memory_get` for `current_focus` and `active_task`.
3. `conversation_search` over recent turns for the same theme.
4. Live project context read (top-level `ls` of `cwd`, plus relevant config files).
5. Produce a structured advisor response — verdict, numbered findings (each with Severity / Evidence / Action), negative space, follow-up question.

If `<topic>` is given, the query passed to `memory_recall` is the topic; without it, the advisor does a full sweep.

## When not to use

If the user is asking for an _action_ (rename this, write that), not a reflection, do not invoke `/kimi-memory:advisor`. The advisor skill is meant for reflection; action requests bypass it.
