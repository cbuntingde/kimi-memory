---
name: list_memories
description: Show the kimi-memory entries currently on file for this project (and the global layer when relevant). Use when the user asks to "list memories", "what do you remember", "show project memory", or "list_memories".
---

# list_memories

Show the durable memory entries currently on file.

By default this calls `memory_list` with `scope: "all"`, so both the active project's durable memory and the cross-project global layer are returned. Each entry is annotated with the scope it came from (`scope: "project"` or `scope: "global"`).

If the user explicitly asks for one scope, pass it through:

- "list memories for this project" → `scope: "project"`.
- "list global memories" / "list cross-project memories" → `scope: "global"`.
- "list memories" (unqualified) → `scope: "all"`.

Natural-language triggers include:

- "list memories"
- "show project memory"
- "what do you remember about this project"
- "list global preferences"
- "list_memories"

Always pass the project root (the cwd of the current session) as `cwd`. The server never infers it.

When the user asks for a topic, also call `memory_recall` with the same scope (default `all`) to surface keyword hits beyond plain listing.
