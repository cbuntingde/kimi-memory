---
name: list_memories
description: List the kimi-memory entries for the current project.
---

# /kimi-memory:list_memories

List the durable memory entries currently on file for the active project.

Steps:

1. Call `memory_list` with `cwd` set to the project root and `scope` chosen by what the user asked:
   - unqualified listing or "list memories" → `scope: "all"` (project + global; project first).
   - "list project memories" / "list this project's memories" → `scope: "project"`.
   - "list global memories" / "list cross-project memories" → `scope: "global"`.
2. Print a short, readable summary: each entry's scope, id, type, title, and `updated_at`.
3. If the user wants a topic, also call `memory_recall` with the same scope (default `all`) and the topic.

Example (scope: "all"):

```
- [project] [semantic] ab12cd34ef56… Coding style: tabs, no semicolons (2026-07-27)
- [project] [procedural] 99887766aabb… Deploy: push to main, CI ships (2026-07-25)
- [global]  [semantic] fe34ab12cd56… User prefers dark mode (2026-07-26)
```

The plugin's `/list_memories` skill is equivalent; this command is the namespaced fallback (`/kimi-memory:list_memories`).
